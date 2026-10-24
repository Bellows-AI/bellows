import { describe, expect, it } from 'vitest';
import type { BoardJob, ReviewClaim } from '../src/board/board.js';
import { RESERVED_ENV_NAMES } from '../src/claim.js';
import { reviewBudgetMs } from '../src/review/review-step.js';
import type { PublishStep } from '../src/publish/publish.js';
import { TASK_MOUNT } from '../src/task-volume.js';
import { gitReviewSnapshotScript, reviewRefOf, snapshotTree } from '../src/review/review-snapshot.js';

/** The review snapshot step and the claim rules a named reviewer's run follows (issue #549). */

const USER = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '11111111-1111-4111-8111-111111111111';
const ROOT = '55555555-5555-4555-8555-555555555555';

const job = {
    id: JOB_ID,
    rootJobId: ROOT,
    repo: 'Bellows-AI/factory',
    workspacePath: `bellows/${USER}`,
    followUp: false,
    resumeSessionId: null,
} as unknown as BoardJob;

describe('snapshotTree', () => {
    const run = (stdout: string, seen: PublishStep[] = []) =>
        snapshotTree(job, 'sec-1', async (step) => {
            seen.push(step);
            return { stdout };
        });

    it('runs the snapshot script over the task worktree with the ref as a literal, no claim env', async () => {
        const seen: PublishStep[] = [];
        const ref = `refs/factory/review/${JOB_ID}/sec-1`;
        await expect(run(JSON.stringify({ ok: true, ref, existed: false }), seen)).resolves.toEqual({ ok: true, ref });
        expect(seen).toEqual([
            {
                label: 'review snapshot',
                entrypoint: 'node',
                args: ['-e', gitReviewSnapshotScript],
                env: false,
                envLiterals: { REPO: `${TASK_MOUNT}/factory`, REVIEW_REF: ref },
                inRepo: false,
            },
        ]);
    });

    it('keys the ref by the caller row, so a follow-up or retry of the same thread never meets an earlier row’s ref', () => {
        expect(reviewRefOf(job, 'sec-1')).toBe(`refs/factory/review/${JOB_ID}/sec-1`);
        const followUp = { ...job, id: '66666666-6666-4666-8666-666666666666' } as BoardJob;
        expect(reviewRefOf(followUp, 'sec-1')).not.toBe(reviewRefOf(job, 'sec-1'));
    });

    it('answers the script’s own reason, and a named failure for anything it cannot read or run', async () => {
        await expect(
            run(JSON.stringify({ ok: false, reason: 'the review snapshot failed: no space' }))
        ).resolves.toEqual({
            ok: false,
            reason: 'the review snapshot failed: no space',
        });
        await expect(run('not json at all')).resolves.toMatchObject({ ok: false });
        await expect(
            snapshotTree(job, 'sec-1', async () => {
                throw new Error('daemon gone');
            })
        ).resolves.toEqual({ ok: false, reason: 'the review snapshot could not run: daemon gone' });
    });

    it('refuses a job with no worktree without running anything', async () => {
        const seen: PublishStep[] = [];
        const result = await snapshotTree({ ...job, repo: null } as unknown as BoardJob, 'k', async (step) => {
            seen.push(step);
            return { stdout: '' };
        });
        expect(result).toEqual({ ok: false, reason: 'this task has no worktree to snapshot' });
        expect(seen).toEqual([]);
    });
});

describe('a reviewer’s claim', () => {
    const review = { profile: 'security', ref: `refs/factory/review/${ROOT}/sec-1`, timeoutMinutes: 5 };

    it('runs for its profile’s budget, never past the operator’s ceiling', () => {
        const ceiling = { jobTimeoutMs: 2 * 3_600_000 };
        expect(reviewBudgetMs(ceiling, { ...job, reviewRun: review } as ReviewClaim)).toBe(5 * 60_000);
        expect(reviewBudgetMs(ceiling, { ...job, reviewRun: { ...review, timeoutMinutes: 600 } } as ReviewClaim)).toBe(
            ceiling.jobTimeoutMs
        );
    });

    it('reserves REVIEW_REF from member env, so no member value can point a reviewer’s tree at a commit', () => {
        expect(RESERVED_ENV_NAMES).toContain('REVIEW_REF');
    });
});
