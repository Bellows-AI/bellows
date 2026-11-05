import { describe, expect, it } from 'vitest';
import type { GithubGrant } from '../../src/github-credential-call.js';
import { newJobState } from '../../src/loop/loop-attempt.js';
import { createGateTokenRelay } from '../../src/loop/loop-github.js';
import type { LoopRuntime } from '../../src/loop/loop-types.js';
import { boardJob } from '../fixtures/board-job.js';

/** The relay behind `POST /gate-token`: the board's grant under the attempt's lease, `gone` once the attempt is down. */
const never = new AbortController().signal;

function relayOn(grant: (signal: AbortSignal) => Promise<GithubGrant>) {
    const calls: AbortSignal[] = [];
    const rt = {
        board: {
            githubGrant: async (_job: unknown, signal: AbortSignal) => {
                calls.push(signal);
                return grant(signal);
            },
        },
        log: () => {},
    } as unknown as LoopRuntime;
    const state = newJobState();
    return { relay: createGateTokenRelay(rt, boardJob(), state), state, calls };
}

describe('the gate token relay (BEL-258)', () => {
    it('passes a live attempt’s grant through', async () => {
        const grant: GithubGrant = { kind: 'token', token: 'ghs_1', expiresAt: null };
        const { relay, calls } = relayOn(async () => grant);
        expect(await relay.token(never)).toEqual(grant);
        expect(calls).toHaveLength(1);
        const refused = relayOn(async () => ({ kind: 'refused' }));
        expect(await refused.relay.token(never)).toEqual({ kind: 'refused' });
    });

    it('answers gone without a board call once the attempt ended or is down', async () => {
        const ended = relayOn(async () => ({ kind: 'unanswered' }));
        ended.state.phase = 'ended';
        expect(await ended.relay.token(never)).toBe('gone');
        const down = relayOn(async () => ({ kind: 'unanswered' }));
        down.state.ending = { kind: 'lost', at: 1 };
        expect(await down.relay.token(never)).toBe('gone');
        expect(ended.calls).toHaveLength(0);
        expect(down.calls).toHaveLength(0);
    });

    it('answers gone when the lease is lost during the call', async () => {
        const harness = relayOn(async () => {
            harness.state.ending = { kind: 'lost', at: 1 };
            return { kind: 'token', token: 'ghs_late', expiresAt: null };
        });
        expect(await harness.relay.token(never)).toBe('gone');
    });

    it('aborts the board call when the attempt stands down, and answers gone', async () => {
        const waitsForAbort = (signal: AbortSignal) =>
            new Promise<GithubGrant>((resolve) =>
                signal.addEventListener('abort', () => resolve({ kind: 'unanswered' }), { once: true })
            );
        const harness = relayOn(waitsForAbort);
        const pending = harness.relay.token(never);
        expect(harness.calls[0]?.aborted).toBe(false);
        harness.state.ending = { kind: 'stop', at: 1 };
        harness.state.abortNow();
        expect(harness.calls[0]?.aborted).toBe(true);
        expect(await pending).toBe('gone');
    });

    it('aborts the board call when the route’s caller hangs up', async () => {
        const hangup = new AbortController();
        const harness = relayOn(
            (signal) =>
                new Promise<GithubGrant>((resolve) =>
                    signal.addEventListener('abort', () => resolve({ kind: 'unanswered' }), { once: true })
                )
        );
        const pending = harness.relay.token(hangup.signal);
        hangup.abort();
        expect(harness.calls[0]?.aborted).toBe(true);
        expect(await pending).toEqual({ kind: 'unanswered' });
    });
});
