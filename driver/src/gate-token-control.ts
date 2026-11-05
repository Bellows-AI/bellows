import type { GithubGrant } from './github-credential-call.js';
import { parseJsonObject } from './json-parse.js';

/**
 * The supervisor token's gate-token route: `POST /gate-token {step}` is a running gate step's GitHub token
 * ask, relayed by the task supervisor (docs/connections.md). Only a gate step the supervisor has pulled and
 * not yet answered may ask. The answer is the board's: a token with its expiry, `409` for a confirmed no,
 * `503 {retryable}` for anything the board did not confirm — never a 200 with an empty token.
 */

/** A step id and nothing else travels here. */
export const GATE_TOKEN_BODY_LIMIT = 1024;

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

/** The loop's end of the route: asks the board under the attempt's lease. `gone` is a lease lost or an attempt over. */
export interface GateTokenRelay {
    token(signal: AbortSignal): Promise<GithubGrant | 'gone'>;
}

/** The relay slot of one attempt; null until the loop attaches it. */
export interface GateTokenSlot {
    relay: GateTokenRelay | null;
}

export interface GateTokenAnswer {
    status: number;
    body: unknown;
}

/** What the route asks of the channel: whether a gate step of that id is still running, and whether the attempt is still open. */
export interface GateTokenCall {
    holds(step: string): boolean;
    open(): boolean;
    signal: AbortSignal;
}

const noGateRun = { status: HTTP_CONFLICT, body: { error: 'no gate run holds that step' } };

/** `POST /gate-token`: validate the step, ask the board once through the relay, answer what it said. */
export async function serveGateToken(slot: GateTokenSlot, raw: string, call: GateTokenCall): Promise<GateTokenAnswer> {
    const step = parseJsonObject(raw)?.step;
    if (typeof step !== 'string' || !STEP_ID.test(step)) {
        return { status: HTTP_BAD_REQUEST, body: { error: 'invalid step' } };
    }
    if (!slot.relay) return { status: HTTP_UNAVAILABLE, body: { error: 'no gate token relay yet' } };
    if (!call.holds(step)) return noGateRun;
    try {
        const grant = await slot.relay.token(call.signal);
        // The step may have settled, or the attempt closed, while the board answered: no grace after that.
        if (!call.open() || !call.holds(step)) return noGateRun;
        if (grant === 'gone' || grant.kind === 'refused') return noGateRun;
        if (grant.kind === 'unanswered') {
            return { status: HTTP_UNAVAILABLE, body: { error: 'the board did not answer', retryable: true } };
        }
        return { status: HTTP_OK, body: { token: grant.token, expiresAt: grant.expiresAt } };
    } catch {
        return { status: HTTP_UNAVAILABLE, body: { error: 'the board did not answer', retryable: true } };
    }
}
