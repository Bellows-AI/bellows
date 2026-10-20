import { describe, expect, it } from 'vitest';
import type { BoardJob, ReviewClaim } from '../src/board.js';
import { REVIEWER_HOME } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { reviewBudgetMs, reviewRestoreEnv, reviewStepEnv, runReviewSteps } from '../src/review-step.js';
import type { StepSink } from '../src/step-control.js';
import { type StepRequest, SUPERVISOR_ENV } from '../src/supervisor-contract.js';

/**
 * A named reviewer's steps in the caller's task group (issue #774): the restore starts at the
 * snapshot with no credential, the review's env is the plan and the grant and never a token, and
 * the wall-clock budget is the profile's, never past the operator's ceiling.
 */

const USER = '44444444-4444-4444-8444-444444444444';
const ROOT = '55555555-5555-4555-8555-555555555555';
const REF = `refs/factory/review/${ROOT}/sec-1`;
const host = { config: loadDriverConfig({}) };

const review = {
    id: '66666666-6666-4666-8666-666666666666',
    rootJobId: ROOT,
    command: 'review the work',
    rootCommand: 'review the work',
    executorType: 'claude-code',
    masterPrompt: 'Factory execution contract (factory-master-prompt/v1)',
    resumeSessionId: null,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    repo: 'Bellows-AI/factory',
    env: { JIRA_TOKEN: 'jira' },
    reviewRun: { profile: 'security', ref: REF, timeoutMinutes: 5 },
} as unknown as ReviewClaim;

describe('the reviewer’s restore step', () => {
    it('restores at the snapshot ref in the reviewer worktree, with no token and no credential helper', () => {
        const env = reviewRestoreEnv(host, review);
        expect(env).toMatchObject({ RESTORE: '1', REVIEW_REF: REF });
        expect(env?.WORKTREE).toContain(`bellows/${USER}`);
        expect(env).not.toHaveProperty('CRED_HELPER');
        expect(JSON.stringify(env)).not.toMatch(/TOKEN|jira|ghs_/);
    });

    it('is refused for a claim with no repository', () => {
        expect(reviewRestoreEnv(host, { ...review, repo: undefined } as unknown as ReviewClaim)).toBeNull();
    });
});

describe('the reviewer’s review step', () => {
    it('carries the grant and its own home, and no publish token or credential helper', () => {
        const step = reviewStepEnv(host, review, { id: 'sess-1', resume: false });
        expect(step?.env).toMatchObject({ JIRA_TOKEN: 'jira', HOME: REVIEWER_HOME });
        expect(step?.env.WORKDIR).toContain(`bellows/${USER}`);
        for (const name of ['CRED_HELPER', 'GITHUB_TOKEN', 'GH_TOKEN', 'PUBLISH_TOKEN', 'BELLOWS_PUBLISH_TOKEN']) {
            expect(step?.env, name).not.toHaveProperty(name);
        }
        expect(step?.env.FACTORY_TRANSCRIPT_DIR).toBe(`${REVIEWER_HOME}/transcripts/${ROOT}`);
        expect(step?.argv.length).toBeGreaterThan(0);
    });
});

describe('reviewBudgetMs', () => {
    it('is the profile’s, never past the operator’s ceiling', () => {
        const ceiling = { jobTimeoutMs: 2 * 3_600_000 };
        expect(reviewBudgetMs(ceiling, review)).toBe(5 * 60_000);
        expect(reviewBudgetMs({ jobTimeoutMs: 2 * 60_000 }, review)).toBe(2 * 60_000);
        expect(reviewBudgetMs(ceiling, { ...review, reviewRun: { ...review.reviewRun, timeoutMinutes: 600 } })).toBe(
            ceiling.jobTimeoutMs
        );
    });
});

describe('runReviewSteps', () => {
    const caller = {
        ...review,
        id: '77777777-7777-4777-8777-777777777777',
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: 'tok' },
    } as unknown as BoardJob;
    const RESTORED = '{"ok":true,"reason":null}';

    function sinkOf(answer: (step: StepRequest) => Promise<{ exitCode: number | null; stdout: string }>) {
        const steps: StepRequest[] = [];
        const cancelled: string[] = [];
        const sink = {
            submit: async (_token: string, step: StepRequest) => {
                steps.push(step);
                const { exitCode, stdout } = await answer(step);
                return { exitCode, stdout, stderr: '', timedOut: false };
            },
            cancel: (_token: string, id: string) => cancelled.push(id),
        } as unknown as StepSink;
        return { steps, cancelled, host: { config: host.config, sink } };
    }

    it('makes the home, restores the worktree, then runs the review for its budget over the worktree', async () => {
        const { steps, host: stepHost } = sinkOf(async (step) =>
            step.kind === 'review' ? { exitCode: 0, stdout: 'verdict' } : { exitCode: 0, stdout: RESTORED }
        );
        const result = await runReviewSteps(stepHost, { caller, review, session: { id: 'sess-1', resume: false } });
        expect(result).toMatchObject({ exitCode: 0, stdout: 'verdict' });
        expect(steps.map((step) => step.kind)).toEqual(['sync', 'sync', 'review']);
        const [home, restore, run] = steps;
        expect(home!.argv.slice(0, 4)).toEqual(['mkdir', '-p', '-m', '2775']);
        expect(restore!.env).toMatchObject({ RESTORE: '1', REVIEW_REF: REF });
        expect(restore!.env).not.toHaveProperty('CRED_HELPER');
        expect(run!.timeoutMs).toBe(5 * 60_000);
        expect(run!.cwd).toBe(restore!.env.WORKTREE);
        expect(run!.env).not.toHaveProperty('CRED_HELPER');
    });

    it('runs no review when the worktree could not be restored', async () => {
        const { steps, host: stepHost } = sinkOf(async () => ({
            exitCode: 0,
            stdout: '{"ok":false,"reason":"ref is gone"}',
        }));
        const result = await runReviewSteps(stepHost, { caller, review, session: { id: 'sess-1', resume: false } });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toMatch(/ref is gone/);
        expect(steps.map((step) => step.kind)).toEqual(['sync', 'sync']);
    });

    it('cancels the review step through the channel when its signal aborts', async () => {
        const stop = new AbortController();
        const { cancelled, host: stepHost } = sinkOf(async (step) => {
            if (step.kind !== 'review') return { exitCode: 0, stdout: RESTORED };
            stop.abort();
            return { exitCode: 130, stdout: '' };
        });
        await runReviewSteps(stepHost, { caller, review, session: { id: 'sess-1', resume: false } }, stop.signal);
        expect(cancelled).toHaveLength(1);
    });
});
