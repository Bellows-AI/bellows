import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { createBoard } from '../src/board/board.js';
import { type PublishStep, publishCheckout, publishRetryable } from '../src/publish/publish.js';
import { type FakePr, fakePullRequests } from './fixtures/fake-pull-requests.js';
import type { PrOperationWrite as PrOperationNote } from '../src/board/board-pr-operations.js';
import { StepChannelClosed, StepTimedOut, stepLost } from '../src/step-control.js';
import { ForgeWait } from '../src/supervised-steps.js';
import { githubRef } from './fixtures/repo-ref.js';

/**
 * Publication reconciliation: a publish is a chain of effects on a remote, and each can
 * land while its answer is lost. The world below is a stateful fake of the checkout, the remote and
 * the PR list, with one fault injector: an effect that LANDS and then answers with an error — the
 * lost response. What it pins is that a retried (or adopted) publish asks the remote what it has
 * before it repeats anything, so the push and the pull request each happen once.
 */
const USER = '44444444-4444-4444-8444-444444444444';
const JOB = {
    id: '11111111-1111-4111-8111-111111111111',
    command: '/fix https://github.com/Bellows-AI/bellows/issues/10',
    attempts: 1,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    repo: githubRef('Bellows-AI/bellows'),
    env: { GITHUB_TOKEN: 't0k-3n' },
} as unknown as BoardJob;
const PR_URL = 'https://github.com/Bellows-AI/bellows/pull/1';
const COMMIT = 'a'.repeat(40);

type Effect = 'git push' | 'git ls-remote';

/**
 * The checkout, the remote and the board's PR write, and the effects that ran against them. The PR is never a step:
 * the runner holds no `gh`, and every PR effect is an ask of the board (`fakePullRequests`).
 */
function world(options: { dirty?: boolean; existing?: Partial<FakePr>[] } = {}) {
    const state = {
        dirty: options.dirty ?? true,
        committed: !(options.dirty ?? true),
        /** The remote's head for the task branch, and the checkout's own tracking ref of it. */
        remoteHead: null as string | null,
        trackingHead: null as string | null,
        ledger: new Map<string, { state?: string; prUrl?: string }>(),
        /** What actually happened on the remote, which is what must happen once. */
        pushes: 0,
        /** Effects whose next call lands and then answers with an error. */
        lostAnswer: new Set<Effect>(),
        /** Effects that fail without landing, whatever their answer. */
        down: new Set<Effect>(),
    };
    const pr = fakePullRequests(options.existing === undefined ? {} : { existing: options.existing });
    const steps: PublishStep[] = [];
    const lose = (effect: Effect): void => {
        if (state.lostAnswer.delete(effect)) throw new Error(`${effect}: connection reset by peer (answer lost)`);
    };
    const run = async (step: PublishStep): Promise<{ stdout: string }> => {
        steps.push(step);
        const { label } = step;
        if (state.down.has(label as Effect)) throw new Error(`${label}: Could not resolve host: github.com`);
        switch (label) {
            case 'probe':
                return {
                    stdout: `${JSON.stringify({
                        cloned: true,
                        branch: 'fix/10',
                        defaultBranch: 'main',
                        dirty: state.dirty,
                        unpushed: state.committed && state.trackingHead !== COMMIT ? 1 : 0,
                        hasIdentity: true,
                        fingerprint: 'fp',
                        conflicts: [],
                        rebasing: false,
                    })}\n`,
                };
            case 'git add':
            case 'git reset':
                return { stdout: '' };
            case 'git commit':
                state.dirty = false;
                state.committed = true;
                return { stdout: '' };
            case 'git rev-parse HEAD':
                return { stdout: `${COMMIT}\n` };
            case 'publication ledger': {
                const op = step.envLiterals!.OP!;
                if (step.envLiterals!.ACTION === 'read')
                    return { stdout: `${JSON.stringify(state.ledger.get(op) ?? {})}\n` };
                const record = {
                    ...state.ledger.get(op),
                    state: step.envLiterals!.STATE,
                    ...(JSON.parse(step.envLiterals!.DATA ?? '{}') as { prUrl?: string }),
                };
                state.ledger.set(op, record as { state?: string; prUrl?: string });
                return { stdout: `${JSON.stringify(record)}\n` };
            }
            case 'git push':
                // The remote takes the commit; the checkout's tracking ref only moves when git saw the answer.
                if (state.remoteHead !== COMMIT) state.pushes += 1;
                state.remoteHead = COMMIT;
                if (state.lostAnswer.has('git push')) {
                    lose('git push');
                }
                state.trackingHead = COMMIT;
                return { stdout: '' };
            case 'git ls-remote':
                return { stdout: state.remoteHead ? `${state.remoteHead}\trefs/heads/fix/10\n` : '' };
            case 'pr summary':
                return { stdout: JSON.stringify({ title: 'Fix the thing', body: 'body' }) };
            case 'git switch':
                return { stdout: '' };
            default:
                throw new Error(`unexpected step ${label}`);
        }
    };
    return { state, run, pr, steps };
}

const publish = (w: ReturnType<typeof world>) => publishCheckout(JOB, { pullRequests: w.pr.port }, w.run);

describe('publication reconciliation after an uncertain response', () => {
    it('does not push twice when the push landed and its answer was lost', async () => {
        const w = world();
        w.state.lostAnswer.add('git push');

        const result = await publish(w);

        // The remote was asked what it has before anything was repeated: it has the commit.
        expect(result).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(w.state.pushes).toBe(1);
        expect(w.pr.state.creates).toBe(1);
    });

    it('does not open a second PR when the creation landed and its answer was lost: the retry finds it on the board', async () => {
        const w = world();
        w.pr.state.lostAnswer = true;

        // The create landed on the board and its answer never came back: no answer is no verdict, the publish is a
        // transport failure the loop retries — and it stays unfinished in the ledger (pushed, not opened).
        const first = await publish(w);
        expect(first).toMatchObject({ ok: false, published: false, cause: 'transport' });
        expect(publishRetryable(first, false)).toBe(true);
        expect(w.pr.state.creates).toBe(1);
        expect(w.state.ledger.get(`fix/10@${COMMIT}`)).toMatchObject({ state: 'pushed' });

        // The retry resumes from the ledger: the push is not repeated and the board's view by head finds the PR.
        const second = await publish(w);
        expect(second).toMatchObject({ ok: true, published: true, prUrl: PR_URL, prNumber: 1 });
        expect(w.pr.state.creates).toBe(1);
        expect(w.pr.state.prs).toHaveLength(1);
        expect(w.state.pushes).toBe(1);
    });

    it("never runs `gh`: the PR is the board's to write, and the runner steps hold none of it", async () => {
        const w = world();
        await publish(w);
        expect(w.steps.map((step) => step.entrypoint as string)).not.toContain('gh');
    });

    it('records the operation as it goes, under the branch and the exact commit it pushes', async () => {
        const w = world();
        await publish(w);
        expect(w.state.ledger.get(`fix/10@${COMMIT}`)).toMatchObject({ state: 'opened', prUrl: PR_URL });
    });

    it('a retried publish after the remote could not even be asked pushes nothing new and opens one PR', async () => {
        const w = world();
        // First attempt: the push lands, its answer is lost, and the remote is unreachable for the reconcile.
        w.state.lostAnswer.add('git push');
        w.state.down.add('git ls-remote');
        const first = await publish(w);
        expect(first).toMatchObject({ ok: false, published: false });
        expect(w.state.pushes).toBe(1);
        expect(w.pr.state.creates).toBe(0);

        // The retry — the same attempt again, or an adopted one: the remote is reachable now.
        w.state.down.clear();
        const second = await publish(w);

        expect(second).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(w.state.pushes).toBe(1);
        expect(w.pr.state.creates).toBe(1);
    });

    it('opens the missing PR for a clean tree whose own push landed, instead of reporting nothing to publish', async () => {
        const w = world({ dirty: false });
        // The push landed and git saw it (the tracking ref moved); the PR was never opened, and the
        // ledger remembers the operation as pushing.
        w.state.remoteHead = COMMIT;
        w.state.trackingHead = COMMIT;
        w.state.ledger.set(`fix/10@${COMMIT}`, { state: 'pushing' });

        const result = await publish(w);

        expect(result).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(w.state.pushes).toBe(0);
        expect(w.pr.state.creates).toBe(1);
    });

    it('leaves a clean, fully pushed tree with no operation of its own alone', async () => {
        const w = world({ dirty: false });
        w.state.remoteHead = COMMIT;
        w.state.trackingHead = COMMIT;

        const result = await publish(w);

        expect(result).toMatchObject({ ok: true, published: false });
        expect(w.pr.state.creates).toBe(0);
    });

    it('a third publish of an opened operation reuses the PR and repeats nothing', async () => {
        const w = world();
        await publish(w);
        const again = await publish(w);

        expect(again).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(w.state.pushes).toBe(1);
        expect(w.pr.state.creates).toBe(1);
    });

    it('still fails a push the remote does not hold: the original refusal stands', async () => {
        const w = world();
        const failing = async (step: PublishStep) => {
            if (step.label === 'git push')
                throw new Error('git push: remote: Permission to Bellows-AI/bellows.git denied');
            return w.run(step);
        };
        const result = await publishCheckout(JOB, { pullRequests: w.pr.port }, failing);
        expect(result).toMatchObject({ ok: false, cause: 'denied' });
        expect(w.pr.state.creates).toBe(0);
    });

    // #925: a lost supervisor is no verdict on the publish; the caller records the attempt's interruption.
    it.each([
        ['channel closed', () => new StepChannelClosed('the publish')],
        ['answer never came', () => new StepTimedOut('the publish')],
    ])('rethrows a step lost mid-publish (%s) instead of answering a failure', async (_name, lost) => {
        const w = world();
        const losing = async (step: PublishStep) => {
            if (step.label === 'git push') throw lost();
            return w.run(step);
        };
        await expect(publishCheckout(JOB, { pullRequests: w.pr.port }, losing)).rejects.toSatisfy(
            (e) => e instanceof StepChannelClosed || e instanceof StepTimedOut
        );
    });

    // An unconfirmed read never licenses a negative verdict: the reconcile after a failed push, the HEAD read and the
    // ledger read each rethrow a credential wait or a lost step instead of answering the push's failure.
    it.each([
        ['a credential wait', () => new ForgeWait('git ls-remote')],
        ['a lost step', () => new StepChannelClosed('git ls-remote')],
    ])('rethrows %s during the reconcile after an ordinary push failure', async (_name, lost) => {
        const w = world();
        const failing = async (step: PublishStep) => {
            if (step.label === 'git push') throw new Error('git push: the remote end hung up unexpectedly');
            if (step.label === 'git ls-remote') throw lost();
            return w.run(step);
        };
        await expect(publishCheckout(JOB, { pullRequests: w.pr.port }, failing)).rejects.toSatisfy(stepLost);
        expect(w.pr.state.creates).toBe(0);
    });

    it('rethrows a lost HEAD read instead of failing the publish as a checkout with no HEAD', async () => {
        const w = world();
        const losing = async (step: PublishStep) => {
            if (step.label === 'git rev-parse HEAD') throw new StepChannelClosed('git rev-parse HEAD');
            return w.run(step);
        };
        await expect(publishCheckout(JOB, { pullRequests: w.pr.port }, losing)).rejects.toBeInstanceOf(
            StepChannelClosed
        );
    });

    it('rethrows a lost ledger read on a clean, pushed tree instead of reporting nothing to publish', async () => {
        const w = world({ dirty: false });
        w.state.remoteHead = COMMIT;
        w.state.trackingHead = COMMIT;
        w.state.ledger.set(`fix/10@${COMMIT}`, { state: 'pushing' });
        const losing = async (step: PublishStep) => {
            if (step.label === 'publication ledger') throw new StepChannelClosed('publication ledger');
            return w.run(step);
        };
        await expect(publishCheckout(JOB, { pullRequests: w.pr.port }, losing)).rejects.toBeInstanceOf(
            StepChannelClosed
        );
        expect(w.pr.state.creates).toBe(0);
    });
});

/**
 * The record of each managed PR operation: written at execution time from the publish
 * itself, with an id minted per operation, never derived from the verdict afterwards. A PR the driver
 * opened is `created`; one it found (an earlier publish, the agent, or a create whose answer was lost)
 * is `reused`. The recorder is best effort: its failure must never fail the publish or open a second PR.
 */
describe('the PR operation record (issue #983)', () => {
    const recording = (w: ReturnType<typeof world>, fail?: 'reject' | 'throw') => {
        const notes: PrOperationNote[] = [];
        const options = {
            async recordPrOperation(note: PrOperationNote): Promise<void> {
                notes.push(note);
                if (fail === 'reject') throw new Error('the board is down');
            },
        };
        return { notes, run: () => publishCheckout(JOB, { ...options, pullRequests: w.pr.port }, w.run) };
    };
    const NOTE = { repo: 'Bellows-AI/bellows', prNumber: 1, prUrl: PR_URL, branch: 'fix/10' };

    it('a new PR is `created`, and the reply names the operation', async () => {
        const w = world();
        const { notes, run } = recording(w);
        const result = await run();
        expect(notes).toEqual([{ ...NOTE, operation: 'created', operationId: expect.any(String) }]);
        expect(result.operationId).toBe(notes[0]!.operationId);
    });

    it('an existing branch PR is `reused`', async () => {
        const w = world({ existing: [{}] });
        const { notes, run } = recording(w);
        const result = await run();
        expect(w.pr.state.creates).toBe(0);
        expect(notes).toEqual([{ ...NOTE, operation: 'reused', operationId: expect.any(String) }]);
        expect(result.operationId).toBe(notes[0]!.operationId);
    });

    it('a PR the agent opened on a clean, pushed tree is `reused`: there is no `agent` operation', async () => {
        const w = world({ dirty: false, existing: [{}] });
        w.state.remoteHead = COMMIT;
        w.state.trackingHead = COMMIT;
        const { notes, run } = recording(w);
        const result = await run();
        expect(w.pr.state.creates).toBe(0);
        expect(notes).toEqual([{ ...NOTE, operation: 'reused', operationId: expect.any(String) }]);
        expect(result.operationId).toBe(notes[0]!.operationId);
    });

    it('a retry after a lost create answer reconciles to `reused` and opens no second PR', async () => {
        const w = world();
        w.pr.state.lostAnswer = true;
        const { notes, run } = recording(w);
        expect(await run()).toMatchObject({ ok: false, cause: 'transport' });
        // nothing was confirmed, so nothing is recorded: the board never said what it did
        expect(notes).toEqual([]);
        const result = await run();
        expect(w.pr.state.creates).toBe(1);
        expect(w.pr.state.prs).toHaveLength(1);
        expect(notes).toEqual([{ ...NOTE, operation: 'reused', operationId: expect.any(String) }]);
        expect(result.operationId).toBe(notes[0]!.operationId);
    });

    it('two genuine operations on one PR are two notes with their own ids', async () => {
        const w = world();
        const { notes, run } = recording(w);
        await run();
        await run();
        expect(notes.map((n) => n.operation)).toEqual(['created', 'reused']);
        expect(new Set(notes.map((n) => n.operationId)).size).toBe(2);
    });

    it('a push that landed on a board with no GitHub App is published with no PR, and nothing is recorded', async () => {
        const w = world();
        w.pr.state.answer = { kind: 'no-forge' };
        const { notes, run } = recording(w);
        expect(await run()).toMatchObject({ ok: true, published: true, prUrl: null, prNumber: null });
        expect(notes).toEqual([]);
        expect(w.state.ledger.get(`fix/10@${COMMIT}`)).toEqual({ state: 'opened' });
    });

    it('a failed record write never fails the publish or opens a second PR: the operation is just unrecorded', async () => {
        const w = world();
        const { notes, run } = recording(w, 'reject');
        const result = await run();
        expect(result).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(notes).toHaveLength(1);
        expect(w.pr.state.creates).toBe(1);
        expect(w.state.ledger.get(`fix/10@${COMMIT}`)).toMatchObject({ state: 'opened', prUrl: PR_URL });
    });

    it('carries no operation id when nothing records it', async () => {
        const w = world();
        expect(await publish(w)).not.toHaveProperty('operationId');
    });
});

/**
 * What each answer of the board's PR write means for the publish (`board-pull-request.ts`): a PR, a wait, a refusal
 * and no answer. Only an answer is a verdict; a board that did not answer is a transport failure, retried.
 */
describe('the board answers the PR ask', () => {
    it('asks once after the push, with the title and body the branch summary gave, a base and the draft flag', async () => {
        const w = world();
        await publishCheckout(JOB, { pullRequests: w.pr.port, draft: true }, w.run);
        expect(w.pr.state.asks).toEqual([
            {
                branch: 'fix/10',
                base: null,
                create: {
                    title: expect.stringContaining('Fix the thing'),
                    body: expect.any(String),
                    draft: true,
                    base: 'main',
                },
                edit: { title: expect.stringContaining('Fix the thing'), body: expect.any(String) },
            },
        ]);
        expect(w.pr.state.prs[0]).toMatchObject({ draft: true, base: 'main' });
    });

    it("rewrites the title and body of a PR the branch already has, and moves it to the claim's base", async () => {
        const w = world({ existing: [{ base: 'release', title: 'old', body: 'old' }] });
        const job = { ...JOB, baseBranch: 'main' } as BoardJob;
        await publishCheckout(job, { pullRequests: w.pr.port }, w.run);
        expect(w.pr.state.creates).toBe(0);
        expect(w.pr.state.prs[0]).toMatchObject({ base: 'main', title: 'Fix the thing (#10)' });
        expect(w.pr.state.prs[0]!.body).toContain('Published by the factory board after the declared gates passed.');
    });

    it('does not retarget a reused PR when the claim names no base', async () => {
        const w = world({ existing: [{ base: 'release' }] });
        await publish(w);
        expect(w.pr.state.asks[0]).toMatchObject({ base: null });
        expect(w.pr.state.prs[0]!.base).toBe('release');
    });

    it('a wait is not a failure: the branch is pushed, nothing is retried, and the ledger stops at pushed', async () => {
        const w = world();
        w.pr.state.answer = { kind: 'waiting', forge: 'github', reason: 'reconnect' };
        const result = await publish(w);
        expect(result).toMatchObject({
            ok: false,
            published: true,
            branch: 'fix/10',
            cause: null,
            waiting: { forge: 'github', reason: 'reconnect' },
        });
        expect(publishRetryable(result, false)).toBe(false);
        expect(w.state.pushes).toBe(1);
        expect(w.state.ledger.get(`fix/10@${COMMIT}`)).toMatchObject({ state: 'pushed' });
    });

    it('the next claim of a waiting publish resumes from the pushed ledger and asks again, pushing nothing', async () => {
        const w = world();
        w.pr.state.answer = { kind: 'waiting', forge: 'github', reason: 'missing' };
        await publish(w);
        w.pr.state.answer = null;
        const again = await publish(w);
        expect(again).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(w.state.pushes).toBe(1);
        expect(w.pr.state.creates).toBe(1);
    });

    it('waits on a clean, pushed tree that carries an agent PR the board cannot read yet', async () => {
        const w = world({ dirty: false });
        w.state.remoteHead = COMMIT;
        w.state.trackingHead = COMMIT;
        w.pr.state.answer = { kind: 'waiting', forge: 'github', reason: 'reconnect' };
        expect(await publish(w)).toMatchObject({ ok: false, published: true, waiting: { forge: 'github' } });
    });

    it('a refused member is `denied`, and never retried', async () => {
        const w = world();
        w.pr.state.answer = { kind: 'denied' };
        const result = await publish(w);
        expect(result).toMatchObject({ ok: false, cause: 'denied' });
        expect(publishRetryable(result, false)).toBe(false);
    });

    it('a board that did not answer is transport, and retried', async () => {
        const w = world();
        w.pr.state.down = true;
        const result = await publish(w);
        expect(result).toMatchObject({ ok: false, cause: 'transport' });
        expect(result.reason).toContain('the board did not answer');
        expect(publishRetryable(result, false)).toBe(true);
    });

    it('a PR GitHub declined carries its words', async () => {
        const w = world();
        w.pr.state.answer = { kind: 'refused', detail: 'No commits between main and fix/10' };
        expect(await publish(w)).toMatchObject({ ok: false, reason: expect.stringContaining('No commits between') });
    });

    it.each([{ kind: 'lost' }, { kind: 'removed' }] as const)(
        'a %o answer fails the publish, never publishes',
        async (answer) => {
            const w = world();
            w.pr.state.answer = answer;
            expect(await publish(w)).toMatchObject({ ok: false, published: false });
        }
    );

    it('refuses to publish a repository with no way to ask the board', async () => {
        const w = world();
        await expect(publishCheckout(JOB, undefined, w.run)).rejects.toThrow('pullRequests');
    });
});

/**
 * The real board client against a scripted board, through a real publish: what the board's status and code say reaches
 * the publish as the right verdict. An App-less (offline) board answers 409 GITHUB_UNAVAILABLE: the push landed, there is
 * no PR to write, and the publish still completes, as published with no URL.
 */
describe('a publish through the board client', () => {
    const publishThrough = async (respond: () => Response) => {
        const w = world();
        const fetch = (async () => respond()) as unknown as typeof globalThis.fetch;
        const board = createBoard({ url: 'http://board', leaseSeconds: 300, fetch });
        const pullRequests = (ask: Parameters<typeof w.pr.port>[0]) =>
            board.pullRequest(JOB, ask, AbortSignal.timeout(300));
        const result = await publishCheckout(JOB, { pullRequests }, w.run);
        return { w, result };
    };

    it('an App-less board (409 GITHUB_UNAVAILABLE) completes as published with no URL after the push', async () => {
        const { w, result } = await publishThrough(() =>
            Response.json({ error: 'no app', code: 'GITHUB_UNAVAILABLE' }, { status: 409 })
        );
        expect(result).toMatchObject({ ok: true, published: true, prUrl: null, prNumber: null, branch: 'fix/10' });
        expect(w.state.pushes).toBe(1);
        expect(w.state.ledger.get(`fix/10@${COMMIT}`)).toEqual({ state: 'opened' });
    });

    it('a lost lease (409 LEASE_LOST) fails the publish: it is not a published verdict', async () => {
        const { result } = await publishThrough(() => Response.json({ code: 'LEASE_LOST' }, { status: 409 }));
        expect(result).toMatchObject({ ok: false, published: false });
    });

    it.each([
        ['an unknown 409 code', () => Response.json({ code: 'SOMETHING_NEW' }, { status: 409 })],
        ['a 503', () => new Response('later', { status: 503 })],
    ])('%s is no answer: the publish fails as transport, never as published', async (_name, respond) => {
        const { result } = await publishThrough(respond);
        expect(result).toMatchObject({ ok: false, cause: 'transport' });
        expect(publishRetryable(result, false)).toBe(true);
    });

    it('a wait answer reaches the publish as the hand-back, not a failure', async () => {
        const { result } = await publishThrough(() =>
            Response.json({ answer: 'waiting', forge: 'github', reason: 'reconnect' })
        );
        expect(result).toMatchObject({ ok: false, published: true, waiting: { forge: 'github', reason: 'reconnect' } });
    });
});
