import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, respondJson } from './http.js';
import type { ToolSpec } from './tools.js';

/**
 * The agent's tool routes on the control channel (`control-channel.ts`): the manifest, the call, and the refusal an
 * older runner's gate route gets. Split out of the channel for its line budget; the channel owns the per-attempt state.
 */

/** The agent's tool manifest: `GET /tools`, `{tools: [...]}` (`tools.ts`). */
export const TOOLS_PATH = '/tools';
/** The agent's tool call: `POST /tools/call {tool, input?}`, served by the gate server's own run logic. */
export const TOOLS_CALL_PATH = '/tools/call';
/**
 * The route an older runner's helpers still call: a taken-over run keeps its runner image and supervisor, whose
 * relay forwards it unchanged. Answered a retryable 503 with no `executionId` — those helpers exit 75 — and never run.
 */
export const LEGACY_GATE_RUN_PATH = '/gate/run';
/** An older runner's `POST /gate/run` body is drained, bounded as a tool call's is (`gate-request.ts`). */
const LEGACY_BODY_LIMIT = 4096;

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** What a tool route answers: its status and JSON body. */
export interface ToolAnswer {
    status: number;
    body: unknown;
}

/**
 * What serves an attempt's `POST /tools/call`: the gate server's ad-hoc run of the gate token registered for it, which
 * answers the reply itself, or `none` for a job that declares no gates (`404 no gates`).
 */
export type GateRunDoor = ((request: IncomingMessage, reply: ServerResponse) => Promise<void>) | 'none';

/** What `POST /tools/call` answers while no gate claim is open for the attempt: retryable, never "no gates". */
const GATE_RUN_NOT_OPEN: ToolAnswer = {
    status: HTTP_SERVICE_UNAVAILABLE,
    body: { error: 'the gate run is not open yet', retryable: true },
};

/**
 * What an older runner's `POST /gate/run` answers, whatever its body and whether or not the claim has gates: a
 * retryable 503 with no `executionId`, which its helpers read as "not open yet" (exit 75) — never "no gates" and
 * never a verdict. Nothing runs and nothing is recorded; its finish pass (`POST /gate/finish`) is unchanged.
 */
const SKEW_REFUSAL: ToolAnswer = {
    status: HTTP_SERVICE_UNAVAILABLE,
    body: {
        error: 'this runner predates its driver: the gate run route is gone; ad-hoc gate runs and exec are unavailable for the rest of this run, and the finish pass still runs the gates',
        retryable: true,
    },
};

/** `GET /tools`: the manifest attached for the attempt, or a retryable 503 before it is — never an empty list. */
const toolsAnswer = (tools: readonly ToolSpec[] | undefined): ToolAnswer =>
    tools === undefined
        ? { status: HTTP_SERVICE_UNAVAILABLE, body: { error: 'the tools are not open yet', retryable: true } }
        : { status: HTTP_OK, body: { tools } };

/**
 * A gate server's `attachGateRun`: opens `POST /tools/call` of a control token on `run`, the ad-hoc run of a registered gate
 * token (`null`: the job declares no gates). A gate token no longer in `claims` is the attempt's end: a retryable 503, never a run.
 */
export const gateRunAttacher =
    (
        channel: { attachGateRun(token: string, door: GateRunDoor): void },
        claims: ReadonlyMap<string, unknown>,
        run: (request: IncomingMessage, reply: ServerResponse, gateToken: string) => Promise<void>
    ) =>
    (controlToken: string, gateToken: string | null): void =>
        channel.attachGateRun(
            controlToken,
            gateToken === null
                ? 'none'
                : async (request, reply) =>
                      claims.has(gateToken)
                          ? run(request, reply, gateToken)
                          : respondJson(reply, GATE_RUN_NOT_OPEN.status, GATE_RUN_NOT_OPEN.body)
        );

/** `POST /tools/call`: the attempt's door answers the reply itself (null); none open yet is a retryable 503, a run that throws a 500. */
async function serveGateRun(
    door: GateRunDoor | undefined,
    { request, reply }: { request: IncomingMessage; reply: ServerResponse }
): Promise<ToolAnswer | null> {
    if (door === 'none') return { status: HTTP_NOT_FOUND, body: { error: 'no gates' } };
    if (door === undefined) return GATE_RUN_NOT_OPEN;
    try {
        await door(request, reply);
        return null;
    } catch (e) {
        if (reply.headersSent) {
            reply.destroy();
            return null;
        }
        return { status: HTTP_INTERNAL_ERROR, body: { error: `gate run failed: ${(e as Error).message}` } };
    }
}

/** Whether a request is one of the agent's tool routes: `GET /tools`, `POST /tools/call`, or an older runner's `POST /gate/run`. */
export const isToolRoute = (request: IncomingMessage): boolean => {
    const url = request.url ?? '';
    if (request.method === 'GET') return url === TOOLS_PATH;
    return request.method === 'POST' && (url === TOOLS_CALL_PATH || url === LEGACY_GATE_RUN_PATH);
};

/**
 * The agent's tool routes, once its token holds them: the attempt's manifest, its door's answer (null when the door
 * answered the reply itself), or — for an older runner's `POST /gate/run` — the body drained and `SKEW_REFUSAL`,
 * never a door. `gone` is the answer once the attempt closed while that body arrived.
 */
export async function serveToolRoute(
    call: { request: IncomingMessage; reply: ServerResponse; open: () => boolean },
    attempt: { door: GateRunDoor | undefined; tools: readonly ToolSpec[] | undefined; gone: ToolAnswer }
): Promise<ToolAnswer | null> {
    const url = call.request.url;
    if (url === TOOLS_PATH) return toolsAnswer(attempt.tools);
    if (url === TOOLS_CALL_PATH) return serveGateRun(attempt.door, call);
    const raw = await readBody(call.request, LEGACY_BODY_LIMIT);
    if (raw === null) return { status: HTTP_PAYLOAD_TOO_LARGE, body: { error: 'body too large' } };
    return call.open() ? SKEW_REFUSAL : attempt.gone;
}
