import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { type PublishStep, publishCheckout } from '../src/publish.js';

/**
 * Publication reconciliation (issue #771): a publish is a chain of effects on a remote, and each can
 * land while its answer is lost. The world below is a stateful fake of the checkout, the remote and
 * the PR list, with one fault injector: an effect that LANDS and then answers with an error — the
 * lost response. What it pins is that a retried (or adopted) publish asks the remote what it has
 * before it repeats anything, so the push and the pull request each happen once.
 */
const USER = '44444444-4444-4444-8444-444444444444';
const JOB = {
    id: '11111111-1111-4111-8111-111111111111',
    command: '/fix https://github.com/Bellows-AI/factory/issues/10',
    attempts: 1,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    repo: 'Bellows-AI/factory',
    env: { GITHUB_TOKEN: 't0k-3n' },
} as unknown as BoardJob;
const PR_URL = 'https://github.com/Bellows-AI/factory/pull/42';
const COMMIT = 'a'.repeat(40);

type Effect = 'git push' | 'gh pr create' | 'git ls-remote';

/** The checkout, the remote and the PR list, and the effects that ran against them. */
function world(options: { dirty?: boolean } = {}) {
    const state = {
        dirty: options.dirty ?? true,
        committed: !(options.dirty ?? true),
        /** The remote's head for the task branch, and the checkout's own tracking ref of it. */
        remoteHead: null as string | null,
        trackingHead: null as string | null,
        prs: [] as string[],
        ledger: new Map<string, { state?: string; prUrl?: string }>(),
        /** What actually happened on the remote, which is what must happen once. */
        pushes: 0,
        prCreates: 0,
        /** Effects whose next call lands and then answers with an error. */
        lostAnswer: new Set<Effect>(),
        /** Effects that fail without landing, whatever their answer. */
        down: new Set<Effect>(),
    };
    const lose = (effect: Effect): void => {
        if (state.lostAnswer.delete(effect)) throw new Error(`${effect}: connection reset by peer (answer lost)`);
    };
    const run = async (step: PublishStep): Promise<{ stdout: string }> => {
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
                    prUrl: step.envLiterals!.PR_URL,
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
            case 'gh pr view':
                if (state.prs[0]) return { stdout: `${state.prs[0]}\n` };
                throw new Error('no pull requests found');
            case 'pr summary':
                return { stdout: JSON.stringify({ title: 'Fix the thing', body: 'body' }) };
            case 'gh pr create':
                state.prCreates += 1;
                state.prs.push(PR_URL);
                lose('gh pr create');
                return { stdout: `${PR_URL}\n` };
            case 'gh pr base':
                return { stdout: 'OPEN main\n' };
            case 'git switch':
                return { stdout: '' };
            default:
                throw new Error(`unexpected step ${label}`);
        }
    };
    return { state, run };
}

const publish = (w: ReturnType<typeof world>) => publishCheckout(loadDriverConfig({}), JOB, undefined, w.run);

describe('publication reconciliation after an uncertain response', () => {
    it('does not push twice when the push landed and its answer was lost', async () => {
        const w = world();
        w.state.lostAnswer.add('git push');

        const result = await publish(w);

        // The remote was asked what it has before anything was repeated: it has the commit.
        expect(result).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(w.state.pushes).toBe(1);
        expect(w.state.prCreates).toBe(1);
    });

    it('does not open a second PR when the creation landed and its answer was lost', async () => {
        const w = world();
        w.state.lostAnswer.add('gh pr create');

        const result = await publish(w);

        expect(result).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(w.state.prCreates).toBe(1);
        expect(w.state.prs).toEqual([PR_URL]);
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
        expect(w.state.prCreates).toBe(0);

        // The retry — the same attempt again, or an adopted one: the remote is reachable now.
        w.state.down.clear();
        const second = await publish(w);

        expect(second).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(w.state.pushes).toBe(1);
        expect(w.state.prCreates).toBe(1);
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
        expect(w.state.prCreates).toBe(1);
    });

    it('leaves a clean, fully pushed tree with no operation of its own alone', async () => {
        const w = world({ dirty: false });
        w.state.remoteHead = COMMIT;
        w.state.trackingHead = COMMIT;

        const result = await publish(w);

        expect(result).toMatchObject({ ok: true, published: false });
        expect(w.state.prCreates).toBe(0);
    });

    it('a third publish of an opened operation reuses the PR and repeats nothing', async () => {
        const w = world();
        await publish(w);
        const again = await publish(w);

        expect(again).toMatchObject({ ok: true, published: true, prUrl: PR_URL });
        expect(w.state.pushes).toBe(1);
        expect(w.state.prCreates).toBe(1);
    });

    it('still fails a push the remote does not hold: the original refusal stands', async () => {
        const w = world();
        const failing = async (step: PublishStep) => {
            if (step.label === 'git push')
                throw new Error('git push: remote: Permission to Bellows-AI/factory.git denied');
            return w.run(step);
        };
        const result = await publishCheckout(loadDriverConfig({}), JOB, undefined, failing);
        expect(result).toMatchObject({ ok: false, cause: 'denied' });
        expect(w.state.prCreates).toBe(0);
    });
});
