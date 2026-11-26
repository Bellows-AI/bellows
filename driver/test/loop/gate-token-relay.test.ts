import { describe, expect, it } from 'vitest';
import type { ForgeGrant } from '../../src/forge-credential-call.js';
import { newJobState } from '../../src/loop/loop-attempt.js';
import type { BoardJob } from '../../src/board/board.js';
import { askGithubToken, createGateTokenRelay } from '../../src/loop/loop-github.js';
import type { LoopRuntime } from '../../src/loop/loop-types.js';
import { boardJob } from '../fixtures/board-job.js';

/** The relay behind `POST /gate-token`: the board's grant under the attempt's lease, `gone` once the attempt is down. */
const never = new AbortController().signal;
const GH = 'github.com';
const GL = 'gitlab.example.com';
const gitlabJob = (): BoardJob => ({ ...boardJob(), repo: { forge: 'gitlab', host: GL, path: 'group/project' } });

function relayOn(grant: (signal: AbortSignal) => Promise<ForgeGrant>, job: BoardJob = boardJob()) {
    const calls: AbortSignal[] = [];
    const credentials: BoardJob[] = [];
    const rt = {
        board: {
            forgeGrant: async (_job: unknown, signal: AbortSignal) => {
                calls.push(signal);
                return grant(signal);
            },
            forgeCredential: async (asked: BoardJob) => {
                credentials.push(asked);
                return 'ghs_step';
            },
        },
        log: () => {},
    } as unknown as LoopRuntime;
    const state = newJobState();
    return { relay: createGateTokenRelay(rt, job, state), state, calls, credentials, rt };
}

describe('the gate token relay', () => {
    it('passes a live attempt’s grant through', async () => {
        const grant: ForgeGrant = { kind: 'token', token: 'ghs_1', expiresAt: null };
        const { relay, calls } = relayOn(async () => grant);
        expect(await relay.token(GH, never)).toEqual(grant);
        expect(calls).toHaveLength(1);
        const refused = relayOn(async () => ({ kind: 'refused' }));
        expect(await refused.relay.token(GH, never)).toEqual({ kind: 'refused' });
    });

    it('answers gone without a board call once the attempt ended or is down', async () => {
        const ended = relayOn(async () => ({ kind: 'unanswered' }));
        ended.state.phase = 'ended';
        expect(await ended.relay.token(GH, never)).toBe('gone');
        const down = relayOn(async () => ({ kind: 'unanswered' }));
        down.state.ending = { kind: 'lost', at: 1 };
        expect(await down.relay.token(GH, never)).toBe('gone');
        expect(ended.calls).toHaveLength(0);
        expect(down.calls).toHaveLength(0);
    });

    it('answers gone when the lease is lost during the call', async () => {
        const harness = relayOn(async () => {
            harness.state.ending = { kind: 'lost', at: 1 };
            return { kind: 'token', token: 'ghs_late', expiresAt: null };
        });
        expect(await harness.relay.token(GH, never)).toBe('gone');
    });

    it('aborts the board call when the attempt stands down, and answers gone', async () => {
        const waitsForAbort = (signal: AbortSignal) =>
            new Promise<ForgeGrant>((resolve) =>
                signal.addEventListener('abort', () => resolve({ kind: 'unanswered' }), { once: true })
            );
        const harness = relayOn(waitsForAbort);
        const pending = harness.relay.token(GH, never);
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
                new Promise<ForgeGrant>((resolve) =>
                    signal.addEventListener('abort', () => resolve({ kind: 'unanswered' }), { once: true })
                )
        );
        const pending = harness.relay.token(GH, hangup.signal);
        hangup.abort();
        expect(harness.calls[0]?.aborted).toBe(true);
        expect(await pending).toEqual({ kind: 'unanswered' });
    });

    it('answers gone without a board call for a host the job’s repository is not on', async () => {
        const github = relayOn(async () => ({ kind: 'token', token: 'ghs_1', expiresAt: null }));
        expect(await github.relay.token(GL, never)).toBe('gone');
        const gitlab = relayOn(async () => ({ kind: 'token', token: 'glpat_1', expiresAt: null }), gitlabJob());
        expect(await gitlab.relay.token(GH, never)).toBe('gone');
        expect(await gitlab.relay.token('other.example.com', never)).toBe('gone');
        expect(github.calls).toHaveLength(0);
        expect(gitlab.calls).toHaveLength(0);
        expect(await gitlab.relay.token(GL, never)).toEqual({ kind: 'token', token: 'glpat_1', expiresAt: null });
        expect(gitlab.calls).toHaveLength(1);
    });

    it('passes a waiting grant through: the route answers it retryable, never a verdict', async () => {
        const gitlab = relayOn(async () => ({ kind: 'waiting' }), gitlabJob());
        expect(await gitlab.relay.token(GL, never)).toEqual({ kind: 'waiting' });
    });
});

describe('askGithubToken', () => {
    it('asks the board for a github job, and never for a gitlab one: its token rides no step env', async () => {
        const github = relayOn(async () => ({ kind: 'unanswered' }));
        expect(await askGithubToken(github.rt, boardJob(), 'the sync')).toBe('ghs_step');
        expect(github.credentials).toHaveLength(1);
        const gitlab = relayOn(async () => ({ kind: 'unanswered' }), gitlabJob());
        expect(await askGithubToken(gitlab.rt, gitlabJob(), 'the sync')).toBeNull();
        expect(gitlab.credentials).toHaveLength(0);
    });
});
