import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONNECTION_BODY_LIMIT, CONNECTION_PATH, type ConnectionRelay, serveConnection } from './connection-control.js';
import { GATE_TOKEN_BODY_LIMIT, type GateTokenRelay, serveGateToken } from './gate-token-control.js';
import { CONTENT_TYPE_HEADER, OCTET_STREAM_CONTENT_TYPE, readBody, respondJson } from './http.js';
import { PUBLISH_BODY_LIMIT, type PublishRelay, servePublish } from './publish/publish-control.js';
import {
    type CheckpointRelay,
    type ExportRelay,
    type ExportSlot,
    CHECKPOINT_PATH,
    EXPORT_PATH,
    serveCheckpoint,
    serveExport,
} from './export-control.js';
import { INPUT_PATH, type InputAnswer, type InputDelivery, serveInput } from './input-control.js';
import { createStepBroker, serveReport, serveStepPoll, serveStepResult, type StepBroker } from './step-control.js';
import { GATE_TOKEN_PATH, REPORT_PATH, STEP_PATH } from './supervisor-contract.js';
import { REVIEW_BODY_LIMIT, type ReviewRelay, serveReviewRead, serveReviewRequest } from './review/review-control.js';
import {
    cancelPendingQuestions,
    type ControlEntry,
    hasPendingQuestion,
    newControl,
    QUESTION_BODY_LIMIT,
    type QuestionRelay,
    type QuestionResolution,
    readQuestion,
    recordQuestion,
    resolveQuestion,
} from './question-control.js';

/**
 * The per-attempt run-control channel the gate server hosts beside the ad-hoc gate route, keyed by
 * three tokens of one lease that open different doors:
 *
 *  - the SUPERVISOR token — held by the task supervisor alone — reads the run's stop and kill orders
 *    (`GET /control`), relays the agent's questions (`POST /question`, `GET /question/:id`) and pulls
 *    and answers the supervised steps (`/step`, `POST /report`), and reads the task's input files
 *    (`GET /input/<delivery>/<id>`), and relays a running gate step's GitHub token ask (`POST /gate-token`);
 *  - the EXPORTER token — all the transcript exporter holds — carries the transcript chunks
 *    (`/export`) and nothing else;
 *  - the AGENT token — all the agent container holds — reaches only the draft publication
 *    (`POST /publish`), the named reviewers (`/review`), the connection ask (`POST /connection`) and
 *    its ad-hoc gate runs (`POST /gate/run`), the routes the baked skills call.
 *
 * A token used on another's route is 403; a gate token is no key here, and an unknown or closed
 * token is 401. One entry per attempt, so one per lease.
 */

/** The run-control poll route the task supervisor reads (`scripts/supervisor.cjs`). */
export const CONTROL_PATH = '/control';
/** The draft-publication route beside it: `POST /publish`. */
export const PUBLISH_PATH = '/publish';
/** The question routes beside it: `POST /question`, `GET /question/:questionId`. */
export const QUESTION_PATH = '/question';
/** The reviewer routes beside them: `POST /review`, `GET /review/:key`. */
export const REVIEW_PATH = '/review';
/** The agent's ad-hoc gate run: `POST /gate/run {gate, filter?}`, served by the gate server's own run logic. */
export const GATE_RUN_PATH = '/gate/run';
export { CONNECTION_PATH, GATE_TOKEN_PATH };

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

/** What a route answers: its status and JSON body. */
export interface BodyAnswer {
    status: number;
    body: unknown;
}

/**
 * What serves an attempt's `POST /gate/run`: the gate server's ad-hoc run of the gate token registered for it, which
 * answers the reply itself, or `none` for a job that declares no gates (`404 no gates`).
 */
export type GateRunDoor = ((request: IncomingMessage, reply: ServerResponse) => Promise<void>) | 'none';

export interface ControlChannel {
    /**
     * Opens the supervisor token (idempotent); `relay` carries its questions to the board,
     * `publisher` the agent's draft publishes and `reviewer` its named-reviewer requests (none on a
     * run that may not invoke one).
     */
    open(token: string, relay?: QuestionRelay, publisher?: PublishRelay, reviewer?: ReviewRelay): void;
    /** Opens the agent's own token beside the open supervisor `token`: the publish and review routes, no other. */
    grantAgent(token: string, agentToken: string): void;
    /**
     * Opens the transcript exporter's own token beside the open supervisor `token`: the export routes, no
     * other. With `exporter` the token is bound to that relay instead of the attempt's own — a review's
     * close-time export rides the caller's group under the review row's identity.
     */
    grantExporter(token: string, exporterToken: string, exporter?: ExportRelay): void;
    /** Closes a bound exporter token once its step is over; the attempt's own tokens are not touched. */
    revokeExporter(exporterToken: string): void;
    /** Gives an open token its transcript exporter's relay: the `/export` routes answer 400 until then. */
    attachExporter(token: string, exporter: ExportRelay): void;
    /** Gives an open token the relay of its supervisor's checkpoint: the `/checkpoint` routes answer 400 until then. */
    attachCheckpoint(token: string, checkpoint: CheckpointRelay): void;
    /** Gives an open token the relay of its agent's connection ask: `/connection` answers 503 until then. */
    attachConnection(token: string, connection: ConnectionRelay): void;
    /** Gives an open token the relay of its supervisor's gate token ask: `/gate-token` answers 503 until then. */
    attachGateToken(token: string, gateToken: GateTokenRelay): void;
    /**
     * Gives an open token the door of its agent's ad-hoc gate runs (`POST /gate/run`): 503 retryable until then, so a run
     * asked for in the takeover window, before the new holder registers its gate claim, is retried and never read as
     * "no gates".
     */
    attachGateRun(token: string, door: GateRunDoor): void;
    /**
     * Registers a delivery of task inputs on an open token (the task's own as `task`, a review's under its row id):
     * `GET /input/<name>/<id>` serves only the files of its manifest, read from the board under its row's lease.
     */
    attachInputs(token: string, name: string, delivery: InputDelivery): void;
    /** Drops a delivery once its step is over; unknown tokens and names do nothing. */
    detachInputs(token: string, name: string): void;
    /** Whether the supervisor has contacted this token — its control poll, or a question POST. */
    polled(token: string): boolean;
    /** Raises the stop; repeated calls and unknown tokens do nothing. */
    raiseStop(token: string): void;
    /** Raises the kill order — the stop, and the supervisor ends the agent now; repeated calls do nothing. */
    raiseKill(token: string): void;
    /** Ends the attempt: its stop flag and its questions are dropped, and every token of it gets 401. */
    close(token: string): void;
    /**
     * Leaves the attempt to a newer holder: like `close`, but every token of it — the supervisor's, the
     * agent's, the exporter's — is hung up on for `forMs` instead of answered 401, which a live supervisor
     * reads as the end of its attempt. Past the bound the tokens are unknown, as any closed token is.
     */
    depart(token: string, forMs: number): void;
    /** Drops every token — the server is closing. */
    clear(): void;
    /** Settles a pending question; false and no change for an unknown token or id or a settled question. */
    resolveQuestion(token: string, questionId: string, resolution: QuestionResolution): boolean;
    /** Whether a question is pending on the token — the wait a Stop must drain rather than kill. */
    hasPendingQuestion(token: string): boolean;
    /** Turns every pending question of the token into `cancelled`. */
    cancelQuestions(token: string): void;
    /** Serves a control or question request; false when the request is neither. */
    serve(request: IncomingMessage, reply: ServerResponse, auth: string): Promise<boolean>;
}

type Route =
    | 'checkpoint'
    | 'connection'
    | 'control'
    | 'export'
    | 'gate-run'
    | 'gate-token'
    | 'input'
    | 'publish'
    | 'question'
    | 'report'
    | 'review'
    | 'step';

/** A path that is a POST of its own, or a GET of `<path>/<id>`: the shape the question and review routes share. */
const isPostOrGetOf = (request: IncomingMessage, path: string): boolean => {
    const url = request.url ?? '';
    return url === path ? request.method === 'POST' : request.method === 'GET' && url.startsWith(`${path}/`);
};

/** The supervised steps' routes (`GET /step`, `POST /step/:id`, `POST /report`), or null for any other request. */
function stepRouteOf(request: IncomingMessage, url: string): 'step' | 'report' | null {
    if (request.method === 'POST') {
        if (url === REPORT_PATH) return 'report';
        return url.startsWith(`${STEP_PATH}/`) ? 'step' : null;
    }
    return request.method === 'GET' && (url === STEP_PATH || url.startsWith(`${STEP_PATH}?`)) ? 'step' : null;
}

/** The routes that are a POST of one exact path. */
const POST_ROUTES = new Map<string, Route>([
    [PUBLISH_PATH, 'publish'],
    [CONNECTION_PATH, 'connection'],
    [GATE_TOKEN_PATH, 'gate-token'],
    [GATE_RUN_PATH, 'gate-run'],
]);

/** Which control route a request is, or null when it is none of them. */
function routeOf(request: IncomingMessage): Route | null {
    const url = request.url ?? '';
    if (request.method === 'GET' && url === CONTROL_PATH) return 'control';
    if (url === EXPORT_PATH || url.startsWith(`${EXPORT_PATH}/`)) return 'export';
    if (url === CHECKPOINT_PATH || url.startsWith(`${CHECKPOINT_PATH}/`)) return 'checkpoint';
    if (url.startsWith(`${INPUT_PATH}/`)) return 'input';
    const post = request.method === 'POST' ? POST_ROUTES.get(url) : undefined;
    if (post) return post;
    if (isPostOrGetOf(request, QUESTION_PATH)) return 'question';
    const stepRoute = stepRouteOf(request, url);
    if (stepRoute) return stepRoute;
    return isPostOrGetOf(request, REVIEW_PATH) ? 'review' : null;
}

type RelayRoute = 'checkpoint' | 'export' | 'gate-run' | 'input';
const isRelayRoute = (route: Route): route is RelayRoute =>
    route === 'export' || route === 'checkpoint' || route === 'input' || route === 'gate-run';

/** The routes each token opens: the supervisor's, the exporter's one and the agent's four. */
const SUPERVISOR_ROUTES: readonly Route[] = [
    'checkpoint',
    'control',
    'gate-token',
    'input',
    'question',
    'report',
    'step',
];
const EXPORTER_ROUTES: readonly Route[] = ['export'];
const AGENT_ROUTES: readonly Route[] = ['connection', 'gate-run', 'publish', 'review'];

/** `GET /step`, `POST /step/:id` and `POST /report`: the supervised steps' routes, under the supervisor token. */
function serveSupervisorStep(
    route: 'step' | 'report',
    channel: { steps: StepBroker; token: string },
    request: IncomingMessage,
    reply: ServerResponse
) {
    const { steps, token } = channel;
    if (route === 'report') return serveReport(steps, token, request);
    if (request.method === 'POST') return serveStepResult(steps, token, request);
    // A long poll the supervisor may hang up on (its own timeout, its container ending): the wait ends with it.
    const hangup = new AbortController();
    reply.on('close', () => {
        if (!reply.writableFinished) hangup.abort();
    });
    return serveStepPoll(steps, token, request, hangup.signal);
}

/**
 * `GET /control`'s answer: the stop and kill orders, the gate steps the driver cancelled when there are any,
 * and `agentEnded` once the runner read the agent container over.
 */
function controlAnswer(steps: StepBroker, token: string, orders: { stop: boolean; kill: boolean }) {
    const cancel = steps.cancels(token);
    const ended = steps.agentWasEnded(token) ? { agentEnded: true } : {};
    return cancel.length > 0 ? { ...orders, ...ended, cancel } : { ...orders, ...ended };
}

/**
 * A token with no control entry: refused, unless it is a supervisor-only token (a reclaim's group,
 * no attempt) open on the step broker alone — it polls its orders and answers its steps, and has
 * no stop to read.
 */
async function serveWithoutEntry(
    route: Route,
    channel: { steps: StepBroker; token: string },
    request: IncomingMessage,
    reply: ServerResponse
): Promise<void> {
    if (!channel.steps.has(channel.token) || !(route === 'step' || route === 'report' || route === 'control')) {
        respondJson(reply, HTTP_UNAUTHORIZED, { error: 'unknown token' });
    } else if (route === 'control') {
        respondJson(reply, HTTP_OK, controlAnswer(channel.steps, channel.token, { stop: false, kill: false }));
    } else {
        const answer = await serveSupervisorStep(route, channel, request, reply);
        respondJson(reply, answer.status, answer.body);
    }
}

/** A route that reads a bounded body: 413 past the bound, `stale` once the attempt closed meanwhile, else its answer. */
async function afterBody(
    request: IncomingMessage,
    limit: number,
    stale: () => BodyAnswer | null,
    answer: (raw: string) => BodyAnswer | Promise<BodyAnswer>
): Promise<BodyAnswer> {
    const raw = await readBody(request, limit);
    if (raw === null) return { status: HTTP_PAYLOAD_TOO_LARGE, body: { error: 'body too large' } };
    return stale() ?? answer(raw);
}

type Stale = () => BodyAnswer | null;

/** `POST /question` / `GET /question/:id`, once the token is known. */
const serveQuestion = (control: ControlEntry, request: IncomingMessage, stale: Stale) =>
    request.method === 'GET'
        ? readQuestion(control, (request.url ?? '').slice(QUESTION_PATH.length + 1))
        : afterBody(request, QUESTION_BODY_LIMIT, stale, (raw) => recordQuestion(control, raw));

/** `POST /publish`: the body names nothing and is only drained, bounded. */
const serveDraftPublish = (control: ControlEntry, request: IncomingMessage, stale: Stale) =>
    afterBody(request, PUBLISH_BODY_LIMIT, stale, () => servePublish(control.publishing, control.publisher));

/** `POST /connection`: the provider the agent's helper needs, relayed to the board. */
const serveConnectionAsk = (control: ControlEntry, request: IncomingMessage, stale: Stale) =>
    afterBody(request, CONNECTION_BODY_LIMIT, stale, (raw) => serveConnection(control.connecting, raw));

/** `POST /gate-token`: a running gate step's token ask, answered only while the supervisor still holds that step. */
const serveGateTokenAsk = (
    control: ControlEntry,
    call: { request: IncomingMessage; reply: ServerResponse; stale: Stale },
    steps: StepBroker,
    token: string
) =>
    afterBody(call.request, GATE_TOKEN_BODY_LIMIT, call.stale, (raw) => {
        // The supervisor hanging up ends the board call; the request's own close fires once its body is read.
        const gone = new AbortController();
        // A token in the body: no cache keeps it.
        call.reply.setHeader('cache-control', 'no-store');
        call.reply.once('close', () => {
            if (!call.reply.writableFinished) gone.abort();
        });
        return serveGateToken(control.gateToken, raw, {
            holds: (step) => steps.holdsGate(token, step),
            open: () => call.stale() === null,
            signal: gone.signal,
        });
    });

/** What `POST /gate/run` answers while no gate claim is open for the attempt: retryable, never "no gates". */
const GATE_RUN_NOT_OPEN: BodyAnswer = {
    status: HTTP_SERVICE_UNAVAILABLE,
    body: { error: 'the gate run is not open yet', retryable: true },
};

/**
 * A gate server's `attachGateRun`: opens `POST /gate/run` of a control token on `run`, the ad-hoc run of a registered gate
 * token (`null`: the job declares no gates). A gate token no longer in `claims` is the attempt's end: a retryable 503, never a run.
 */
export const gateRunAttacher =
    (
        channel: Pick<ControlChannel, 'attachGateRun'>,
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

/** An attempt's gate door; the entry is dropped with the attempt, and its door with it. */
const gateDoors = new WeakMap<ControlEntry, GateRunDoor>();

/** `POST /gate/run`: the attempt's door answers the reply itself (null); none open yet is a retryable 503, a run that throws a 500. */
async function serveGateRun(
    door: GateRunDoor | undefined,
    { request, reply }: { request: IncomingMessage; reply: ServerResponse }
): Promise<BodyAnswer | null> {
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

/** `POST /review` / `GET /review/:key`, once the token is known. */
const serveReview = (control: ControlEntry, request: IncomingMessage, stale: Stale) =>
    request.method === 'GET'
        ? serveReviewRead(control.reviewer, (request.url ?? '').slice(REVIEW_PATH.length + 1))
        : afterBody(request, REVIEW_BODY_LIMIT, stale, (raw) =>
              serveReviewRequest(control.reviewing, control.reviewer, raw)
          );

/** A relay route's answer: the input file's raw bytes beside the board's digest, or the JSON of any other answer; null when the route answered the reply itself. */
function respondAnswer(reply: ServerResponse, answer: BodyAnswer | InputAnswer | null): void {
    if (answer === null) return;
    if ('bytes' in answer) {
        reply.writeHead(HTTP_OK, {
            [CONTENT_TYPE_HEADER]: OCTET_STREAM_CONTENT_TYPE,
            'x-content-sha256': answer.sha256,
        });
        reply.end(Buffer.from(answer.bytes));
    } else {
        respondJson(reply, answer.status, answer.body);
    }
}

/** The tokens of attempts left to a newer holder: remembered, to be hung up on, until their bound passes. */
function createDepartures() {
    const timers = new Map<string, NodeJS.Timeout>();
    return {
        has: (token: string): boolean => timers.has(token),
        add(tokens: string[], forMs: number): void {
            // One timer per token: a token departed again must not clear the timer an earlier batch's others share.
            for (const each of tokens) {
                clearTimeout(timers.get(each));
                const forget = setTimeout(() => timers.delete(each), forMs);
                forget.unref();
                timers.set(each, forget);
            }
        },
        clear(): void {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
        },
    };
}
/** Gives a relay slot of an attempt its relay; nothing for an attempt that is gone. */
const attachRelay = <R>(slot: { relay: R | null } | undefined, relay: R): void => {
    if (slot) slot.relay = relay;
};

/** `/export` (the exporter's own slot where it has one), `/checkpoint` or `/input` (the supervisor's), or the agent's `/gate/run`, once the token holds that door. */
const serveRelayRoute = (
    route: RelayRoute,
    control: ControlEntry,
    slot: ExportSlot | undefined,
    call: { request: IncomingMessage; reply: ServerResponse; open: () => boolean }
): Promise<BodyAnswer | InputAnswer | null> => {
    if (route === 'gate-run') return serveGateRun(gateDoors.get(control), call);
    if (route === 'export') return serveExport(slot ?? control.exporting, call.request, call.open);
    if (route === 'input') return serveInput(control.inputs, call.request, call.open);
    return serveCheckpoint(control.checkpointing, call.request, call.open);
};

/** The `attach*` doors that hand an open token a relay for one of its routes. */
const relayAttachers = (
    controls: Map<string, ControlEntry>
): Pick<
    ControlChannel,
    'attachExporter' | 'attachCheckpoint' | 'attachConnection' | 'attachGateToken' | 'attachGateRun'
> => ({
    attachExporter: (token, exporter) => attachRelay(controls.get(token)?.exporting, exporter),
    attachCheckpoint: (token, checkpoint) => attachRelay(controls.get(token)?.checkpointing, checkpoint),
    attachConnection: (token, connection) => attachRelay(controls.get(token)?.connecting, connection),
    attachGateToken: (token, gateToken) => attachRelay(controls.get(token)?.gateToken, gateToken),
    attachGateRun(token, door) {
        const control = controls.get(token);
        if (control) gateDoors.set(control, door);
    },
});

export function createControlChannel(steps: StepBroker = createStepBroker()): ControlChannel {
    /** Every attempt, under its supervisor token. */
    const controls = new Map<string, ControlEntry>();
    /** An agent token, to the supervisor token of the attempt it belongs to. */
    const agents = new Map<string, string>();
    /** A transcript exporter's token, to the attempt it belongs to and, for a review's, the relay of its own. */
    const exporters = new Map<string, { owner: string; slot?: ExportSlot }>();
    const departed = createDepartures();

    const close = (token: string) => {
        controls.delete(token);
        steps.close(token);
        for (const [agent, owner] of agents) if (owner === token) agents.delete(agent);
        for (const [exporter, { owner }] of exporters) if (owner === token) exporters.delete(exporter);
    };

    /** A closed attempt's answer: 401, unless it departed, which no answer at all stands for. */
    const gone = (request: IncomingMessage, auth: string) => {
        if (departed.has(auth)) request.socket.destroy();
        return { status: HTTP_UNAUTHORIZED, body: { error: 'unknown token' } };
    };

    /** The attempt a token of any role belongs to, or undefined once it is closed. */
    const entryOf = (auth: string): ControlEntry | undefined =>
        controls.get(auth) ?? controls.get(agents.get(auth) ?? exporters.get(auth)?.owner ?? '');

    /** The doors a token of a known attempt opens. */
    const doorsOf = (auth: string): readonly Route[] => {
        if (controls.has(auth)) return SUPERVISOR_ROUTES;
        return exporters.has(auth) ? EXPORTER_ROUTES : AGENT_ROUTES;
    };

    return {
        open(token, relay, publisher, reviewer) {
            if (!controls.has(token)) {
                controls.set(token, newControl(relay ?? null, publisher ?? null, reviewer ?? null));
                steps.open(token);
            }
        },
        grantAgent(token, agentToken) {
            if (agentToken !== token) agents.set(agentToken, token);
        },
        grantExporter(token, exporterToken, exporter) {
            if (exporterToken === token) return;
            exporters.set(exporterToken, exporter ? { owner: token, slot: { relay: exporter } } : { owner: token });
        },
        revokeExporter: (exporterToken) => void exporters.delete(exporterToken),
        ...relayAttachers(controls),
        attachInputs: (token, name, delivery) => void controls.get(token)?.inputs.deliveries.set(name, delivery),
        detachInputs: (token, name) => void controls.get(token)?.inputs.deliveries.delete(name),
        polled: (token) => controls.get(token)?.polled ?? false,
        raiseStop(token) {
            const control = controls.get(token);
            if (control) control.stop = true;
        },
        raiseKill(token) {
            const control = controls.get(token);
            if (!control) return;
            control.stop = true;
            control.kill = true;
        },
        close,
        depart(token, forMs) {
            const tokens = [token];
            for (const [agent, owner] of agents) if (owner === token) tokens.push(agent);
            for (const [exporter, { owner }] of exporters) if (owner === token) tokens.push(exporter);
            close(token);
            departed.add(tokens, forMs);
        },
        clear() {
            departed.clear();
            for (const token of controls.keys()) steps.close(token);
            controls.clear();
            agents.clear();
            exporters.clear();
        },
        resolveQuestion: (token, id, resolution) => {
            const control = controls.get(token);
            return control ? resolveQuestion(control, id, resolution) : false;
        },
        hasPendingQuestion: (token) => {
            const control = controls.get(token);
            return control ? hasPendingQuestion(control) : false;
        },
        cancelQuestions(token) {
            const control = controls.get(token);
            if (control) cancelPendingQuestions(control);
        },
        async serve(request, reply, auth) {
            if (departed.has(auth)) {
                request.socket.destroy();
                return true;
            }
            const route = routeOf(request);
            if (route === null) return false;
            const control = entryOf(auth);
            if (!control) {
                await serveWithoutEntry(route, { steps, token: auth }, request, reply);
                return true;
            }
            const doors = doorsOf(auth);
            if (!doors.includes(route)) {
                respondJson(reply, HTTP_FORBIDDEN, { error: 'this token does not open that route' });
                return true;
            }
            if (isRelayRoute(route)) {
                // Not the supervisor's poll: neither the exporter's calls nor its finalize stage's say a Stop can be cooperative.
                const open = () => entryOf(auth) === control;
                const done = await serveRelayRoute(route, control, exporters.get(auth)?.slot, { request, reply, open });
                respondAnswer(reply, done);
                return true;
            }
            // Only the supervisor holds a door that gets here besides publish and review: its poll
            // or its question is what says a Stop can be cooperative.
            if (doors === SUPERVISOR_ROUTES) control.polled = true;
            if (route === 'control') {
                respondJson(reply, HTTP_OK, controlAnswer(steps, auth, { stop: control.stop, kill: control.kill }));
                return true;
            }
            const serveStep = async () =>
                serveSupervisorStep(route === 'report' ? 'report' : 'step', { steps, token: auth }, request, reply);
            const serveRoute = {
                publish: serveDraftPublish,
                connection: serveConnectionAsk,
                'gate-token': (entry: ControlEntry, req: IncomingMessage, isStale: Stale) =>
                    serveGateTokenAsk(entry, { request: req, reply, stale: isStale }, steps, auth),
                review: serveReview,
                question: serveQuestion,
                step: serveStep,
                report: serveStep,
            }[route];
            // Closed while a body arrived: the entry read before is the dead attempt's.
            const stale = (): BodyAnswer | null => (entryOf(auth) === control ? null : gone(request, auth));
            const answer = await serveRoute(control, request, stale);
            respondJson(reply, answer.status, answer.body);
            return true;
        },
    };
}

/** What a control token is given after it opens: the relays and the task inputs it serves (`GET /input/<name>/<id>`). */
export const attachersOf = ({
    attachExporter,
    attachCheckpoint,
    attachConnection,
    attachGateToken,
    attachInputs,
}: ControlChannel): Pick<
    ControlChannel,
    'attachExporter' | 'attachCheckpoint' | 'attachConnection' | 'attachGateToken' | 'attachInputs'
> => ({
    attachExporter,
    attachCheckpoint,
    attachConnection,
    attachGateToken,
    attachInputs,
});
