import type { BoardJob } from './board/board.js';
import type { ForgeGrant } from './forge-credential-call.js';
import { parseJsonObject } from './json-parse.js';

/**
 * The supervisor token's gate-token route: `POST /gate-token {step, host}` is a running step's forge token
 * ask for `host`, relayed by the task supervisor (docs/connections.md). Only a step the supervisor has pulled
 * and not yet answered may ask: a gate, or a forge step for its own host (`StepBroker.holdsForgeAsk`). The
 * answer is the board's: a token with its expiry, `409` for a confirmed no, `503 {retryable}` for anything the
 * board did not confirm, `503 {retryable, waiting}` while the starter's grant is waited on — never a 200 with an
 * empty token, and never a verdict from a wait.
 */

/** A step id and a host, nothing else, travel here. */
export const GATE_TOKEN_BODY_LIMIT = 1024;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;
/** A DNS name in lowercase, with an optional port: what a forge host is once normalized. */
const FORGE_HOST =
    /^(?=.{1,253}(:|$))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/;
const HTTPS_PORT_SUFFIX = ':443';

/** A host as git names it, normalized (lowercase, no `:443`), or null for anything that is not a host name. */
export function normalizeForgeHost(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const lower = raw.toLowerCase();
    const host = lower.endsWith(HTTPS_PORT_SUFFIX) ? lower.slice(0, -HTTPS_PORT_SUFFIX.length) : lower;
    return FORGE_HOST.test(host) ? host : null;
}

const GITHUB_HOST = 'github.com';

/** The host the job's repository is on, normalized: github.com for a job naming none; null for a malformed one. */
export const repoForgeHost = (job: BoardJob): string | null =>
    job.repo ? normalizeForgeHost(job.repo.host) : GITHUB_HOST;

/** The host a GitLab job's git asks its token for through a mailbox; null for any other job. */
export const gitlabForgeHost = (job: BoardJob): string | null =>
    job.repo?.forge === 'gitlab' ? repoForgeHost(job) : null;

/**
 * The loop's end of the route: asks the board under the attempt's lease for `host`'s token. `gone` is a lease
 * lost, an attempt over, or a host the attempt's repository is not on.
 */
export interface GateTokenRelay {
    token(host: string, signal: AbortSignal): Promise<ForgeGrant | 'gone'>;
}

/** The relay slot of one attempt; null until the loop attaches it. */
export interface GateTokenSlot {
    relay: GateTokenRelay | null;
}

export interface GateTokenAnswer {
    status: number;
    body: unknown;
}

/** What the route asks of the channel: whether a step of that id still runs and may ask for `host`, and whether the attempt is still open. */
export interface GateTokenCall {
    holds(step: string, host: string): boolean;
    open(): boolean;
    signal: AbortSignal;
}

const noGateRun = { status: HTTP_CONFLICT, body: { error: 'no running step may ask for that host' } };

/** `POST /gate-token`: validate the step and host, ask the board once through the relay, answer what it said. */
export async function serveGateToken(slot: GateTokenSlot, raw: string, call: GateTokenCall): Promise<GateTokenAnswer> {
    const body = parseJsonObject(raw);
    const step = body?.step;
    if (typeof step !== 'string' || !STEP_ID.test(step)) {
        return { status: HTTP_BAD_REQUEST, body: { error: 'invalid step' } };
    }
    const host = normalizeForgeHost(body?.host);
    if (host === null) return { status: HTTP_BAD_REQUEST, body: { error: 'invalid host' } };
    if (!slot.relay) return { status: HTTP_UNAVAILABLE, body: { error: 'no gate token relay yet' } };
    if (!call.holds(step, host)) return noGateRun;
    try {
        const grant = await slot.relay.token(host, call.signal);
        // The step may have settled, or the attempt closed, while the board answered: no grace after that.
        if (!call.open() || !call.holds(step, host)) return noGateRun;
        if (grant === 'gone' || grant.kind === 'refused') return noGateRun;
        if (grant.kind === 'waiting') {
            return {
                status: HTTP_UNAVAILABLE,
                body: { error: "the starter's forge grant is waited on", retryable: true, waiting: true },
            };
        }
        if (grant.kind === 'unanswered') {
            return { status: HTTP_UNAVAILABLE, body: { error: 'the board did not answer', retryable: true } };
        }
        return { status: HTTP_OK, body: { token: grant.token, expiresAt: grant.expiresAt } };
    } catch {
        return { status: HTTP_UNAVAILABLE, body: { error: 'the board did not answer', retryable: true } };
    }
}
