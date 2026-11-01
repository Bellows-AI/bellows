import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { BoardJob, ReviewClaim } from '../src/board/board.js';
import { REVIEWER_HOME, REVIEWER_TREE_PATH } from '../src/claim.js';
import type { ClaimAttachment } from '../src/board/board-attachments.js';
import { claudeExportScript, opencodeReadoutScript } from '../src/container-scripts.js';
import { loadDriverConfig } from '../src/config.js';
import { REVIEW_ROOTS_DIR, reviewWorktreeDir, checkoutDir } from '../src/publish/publish.js';
import { reviewBudgetMs, reviewRestoreEnv, reviewStepEnv, runReviewSteps } from '../src/review/review-step.js';
import { InputsUnconfirmed } from '../src/task-inputs.js';
import type { StepSink } from '../src/step-control.js';
import { type StepRequest, SUPERVISOR_ENV } from '../src/supervisor-contract.js';

/**
 * A named reviewer's steps in the caller's task group (issue #774): the restore starts at the
 * snapshot with no credential, the review's env is the plan and the grant and never a token, and
 * the wall-clock budget is the profile's, never past the operator's ceiling.
 */

const USER = '44444444-4444-4444-8444-444444444444';
const ROOT = '55555555-5555-4555-8555-555555555555';
const CALLER_ROOT = '88888888-8888-4888-8888-888888888888';
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
    repo: 'Bellows-AI/bellows',
    env: { JIRA_TOKEN: 'jira' },
    reviewRun: { profile: 'security', ref: REF, timeoutMinutes: 5 },
} as unknown as ReviewClaim;

const topCaller = {
    ...review,
    id: '77777777-7777-4777-8777-777777777777',
    rootJobId: CALLER_ROOT,
} as unknown as BoardJob;

describe('the reviewer’s restore step', () => {
    it('restores at the snapshot ref in the reviewer worktree, with no token and no credential helper', () => {
        const env = reviewRestoreEnv(review);
        expect(env).toMatchObject({ RESTORE: '1', REVIEW_REF: REF });
        expect(env?.REPO).toBe(checkoutDir(review));
        expect(env?.WORKTREE).toBe(`${REVIEW_ROOTS_DIR}/${ROOT}`);
        expect(env).not.toHaveProperty('CRED_HELPER');
        expect(JSON.stringify(env)).not.toMatch(/TOKEN|jira|ghs_/);
    });

    // The review root lives in the task volume's own review-roots directory, beside the checkout it
    // was linked from: it goes with the volume, and no reclaim has to find it.
    it('puts the reviewer worktree under the task volume’s review roots directory', () => {
        const env = reviewRestoreEnv(review);
        expect(env?.WORKTREE).toBe(reviewWorktreeDir(review));
        expect(env?.WORKTREE).toBe(`${REVIEW_ROOTS_DIR}/${ROOT}`);
    });

    it('is refused for a claim with no repository', () => {
        expect(reviewRestoreEnv({ ...review, repo: undefined } as unknown as ReviewClaim)).toBeNull();
    });
});

describe('the reviewer’s review step', () => {
    it('carries the grant and its own home, and no publish token or credential helper', () => {
        const step = reviewStepEnv(host, review, { id: 'sess-1', resume: false });
        expect(step?.env).toMatchObject({ JIRA_TOKEN: 'jira', HOME: REVIEWER_HOME });
        expect(step?.env.WORKDIR).toBe(`${REVIEW_ROOTS_DIR}/${ROOT}`);
        for (const name of ['CRED_HELPER', 'GITHUB_TOKEN', 'GH_TOKEN', 'PUBLISH_TOKEN', 'BELLOWS_PUBLISH_TOKEN']) {
            expect(step?.env, name).not.toHaveProperty(name);
        }
        expect(step?.env.FACTORY_TRANSCRIPT_DIR).toBe(`${REVIEWER_HOME}/transcripts/${ROOT}`);
        expect(step?.argv.length).toBeGreaterThan(0);
    });

    // The existing branch reporter and the usage attribution key on the run's OWN board identity:
    // the review row's id and lease token and the board's URL — never the caller's.
    it.each(['claude-code', 'opencode'] as const)(
        'carries the review row’s own board identity on %s',
        (executorType) => {
            const own = { ...review, executorType, leaseToken: 'review-lease' } as unknown as ReviewClaim;
            const step = reviewStepEnv(host, own, executorType === 'opencode' ? null : { id: 'sess-1', resume: false });
            expect(step?.env).toMatchObject({
                FACTORY_STATS_URL: host.config.statsUrl,
                RUNNER_JOB_ID: review.id,
                RUNNER_LEASE_TOKEN: 'review-lease',
            });
            expect(JSON.stringify(step?.env)).not.toContain(topCaller.id);
        }
    );
});

// The reviewer has no control channel: its container mounts neither `in` nor `out` and its step
// names neither, so claude-bridge.cjs denies a question outright (`claude-bridge.test.ts`, "when
// FACTORY_CTL_IN is unset") and the opencode executor's ctl-agent never starts. Pinned on both executors.
describe('the reviewer’s question channel', () => {
    it.each(['claude-code', 'opencode'] as const)('is absent from a %s review step', (executorType) => {
        const session = executorType === 'opencode' ? null : { id: 'sess-1', resume: false };
        const step = reviewStepEnv(host, { ...review, executorType }, session);
        expect(step).not.toBeNull();
        for (const name of ['FACTORY_CTL_IN', 'FACTORY_CTL_OUT', 'FACTORY_CTL_GO', 'FACTORY_STOP_MARKER']) {
            expect(step?.env, name).not.toHaveProperty(name);
        }
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
        expect(run!.cwd).toBe(reviewWorktreeDir(review));
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

    it.each(['null', '[]', '"ok"', '{}', '{"ok":"yes"}', 'not json', ''])(
        'runs no review when the restore answers %j: an unreadable answer is no go-ahead',
        async (stdout) => {
            const { steps, host: stepHost } = sinkOf(async (step) =>
                step.argv[0] === 'mkdir' ? { exitCode: 0, stdout: '' } : { exitCode: 0, stdout }
            );
            const result = await runReviewSteps(stepHost, { caller, review, session: { id: 'sess-1', resume: false } });
            expect(result.exitCode).toBe(1);
            expect(steps.map((step) => step.kind)).toEqual(['sync', 'sync']);
        }
    );

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

describe('the reviewer’s input files', () => {
    const FILE: ClaimAttachment = {
        id: '99999999-9999-4999-8999-999999999999',
        name: 'spec.txt',
        mediaType: 'text/plain',
        size: 5,
        sha256: 'b'.repeat(64),
        originJobId: CALLER_ROOT,
    };
    const withFiles = {
        ...review,
        leaseToken: 'review-lease',
        claimSeq: 3,
        attachments: [FILE],
    } as unknown as ReviewClaim;
    const caller = {
        ...review,
        id: '77777777-7777-4777-8777-777777777777',
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: 'tok' },
    } as unknown as BoardJob;

    function sinkOf(inputs: string) {
        const steps: StepRequest[] = [];
        const sink = {
            submit: async (_token: string, step: StepRequest) => {
                steps.push(step);
                const stdout = step.id.endsWith('-inputs')
                    ? inputs
                    : step.kind === 'review'
                      ? 'verdict'
                      : '{"ok":true,"reason":null}';
                return { exitCode: 0, stdout, stderr: '', timedOut: false };
            },
            cancel: () => {},
        } as unknown as StepSink;
        return { steps, host: { config: host.config, sink } };
    }
    const run = (stepHost: ReturnType<typeof sinkOf>['host'], row = withFiles) =>
        runReviewSteps(stepHost, { caller, review: row, session: { id: 'sess-1', resume: false } });

    it('delivers the review row’s manifest into the reviewer home after the restore and before the review', async () => {
        const { steps, host: stepHost } = sinkOf('{"ok":true}');
        await run(stepHost);
        expect(steps.map((step) => step.kind)).toEqual(['sync', 'sync', 'sync', 'review']);
        const inputs = steps[2]!;
        expect(inputs.id).toMatch(/-inputs$/);
        expect(inputs.id).toBe(steps[1]!.id.replace(/review-restore$/, 'inputs'));
        expect(inputs.env).toMatchObject({
            TARGET_DIR: `${REVIEWER_TREE_PATH}/attachments/${ROOT}`,
            INPUT_DELIVERY: withFiles.id,
            INPUT_FEED: '1',
            MANIFEST: JSON.stringify([FILE]),
        });
        expect(inputs.env).not.toHaveProperty('RESTORE_URL');
    });

    it('names the inputs step by the review’s own lease, never the caller’s', async () => {
        const a = sinkOf('{"ok":true}');
        await run(a.host);
        const b = sinkOf('{"ok":true}');
        await run(b.host, { ...withFiles, leaseToken: 'other-lease' } as unknown as ReviewClaim);
        expect(a.steps[2]!.id).not.toBe(b.steps[2]!.id);
    });

    it('fails the review with attachment_unavailable and runs no review when a file is gone for good', async () => {
        const { steps, host: stepHost } = sinkOf('{"ok":false,"reason":"gone","kind":"attachment_unavailable"}');
        const result = await run(stepHost);
        expect(result).toMatchObject({ exitCode: 1, failureKind: 'attachment_unavailable' });
        expect(steps.map((step) => step.kind)).toEqual(['sync', 'sync', 'sync']);
    });

    it.each(['', 'not json', '{"ok":false,"reason":"board 503","transient":true}'])(
        'gives no verdict and runs no review when the fetch is unconfirmed (%j)',
        async (stdout) => {
            const { steps, host: stepHost } = sinkOf(stdout);
            await expect(run(stepHost)).rejects.toBeInstanceOf(InputsUnconfirmed);
            expect(steps.map((step) => step.kind)).toEqual(['sync', 'sync', 'sync']);
        }
    );

    it('submits no inputs step for a review with no attachments', async () => {
        const { steps, host: stepHost } = sinkOf('');
        await run(stepHost, review);
        expect(steps.map((step) => step.kind)).toEqual(['sync', 'sync', 'review']);
    });
});

// Issue #774 (B5): after the review the caller's supervisor runs one more step, the review's
// transcript export, under the REVIEW row's own exporter token — never the caller's control or
// export token — and whatever it answers never changes the review's verdict.
describe('the reviewer’s close-time export step', () => {
    const caller = {
        ...review,
        id: '77777777-7777-4777-8777-777777777777',
        supervisorEnv: {
            [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130',
            [SUPERVISOR_ENV.controlToken]: 'caller-control',
            [SUPERVISOR_ENV.exportToken]: 'caller-export',
        },
    } as unknown as BoardJob;
    const RESTORED = '{"ok":true,"reason":null}';
    const session = { id: 'sess-1', resume: false };

    function sinkOf(answer: (step: StepRequest) => { exitCode: number | null; stdout: string }) {
        const steps: StepRequest[] = [];
        const sink = {
            submit: async (_token: string, step: StepRequest) => {
                steps.push(step);
                return { ...answer(step), stderr: '', timedOut: false };
            },
            cancel: () => undefined,
        } as unknown as StepSink;
        return { steps, host: { config: host.config, sink } };
    }
    const reviewed = (exitCode: number) => (step: StepRequest) =>
        step.kind === 'review' ? { exitCode, stdout: 'verdict' } : { exitCode: 0, stdout: RESTORED };
    const exporter = () => ({ token: 'review-export', readout: vi.fn(async () => undefined) });

    it('exports a claude-code transcript from the reviewer’s store under the review’s token', async () => {
        const { steps, host: stepHost } = sinkOf(reviewed(0));
        const result = await runReviewSteps(stepHost, { caller, review, session, exporter: exporter() });
        expect(result).toMatchObject({ exitCode: 0, stdout: 'verdict' });
        // The reviewer's store is private to the reviewer uid (the entrypoints narrow it to 0700), so
        // the export is served by the reviewer container itself — a `review` step — never by the
        // supervisor's uid, which cannot read it.
        expect(steps.map((step) => step.kind)).toEqual(['sync', 'sync', 'review', 'review']);
        const exportStep = steps[3]!;
        expect(exportStep.id).toMatch(/review-export$/);
        expect(exportStep.cwd).toBe(REVIEWER_HOME);
        expect(exportStep.argv).toEqual(['node', '-e', claudeExportScript]);
        expect(exportStep.env).toMatchObject({
            CLAUDE_TRANSCRIPT_DIR: `${REVIEWER_HOME}/transcripts/${ROOT}`,
            BELLOWS_CONTROL_URL: 'http://driver:8130',
            BELLOWS_CONTROL_TOKEN: 'review-export',
            EXPORT_ONCE: 'complete',
        });
        expect(JSON.stringify(exportStep)).not.toMatch(/caller-control|caller-export/);
    });

    it('closes a failed review’s stream partial, with the cause, and leaves the verdict alone', async () => {
        const { steps, host: stepHost } = sinkOf((step) =>
            step.id.endsWith('review-export') ? { exitCode: 1, stdout: '' } : reviewed(2)(step)
        );
        const result = await runReviewSteps(stepHost, { caller, review, session, exporter: exporter() });
        expect(result).toMatchObject({ exitCode: 2, stdout: 'verdict' });
        expect(steps[3]!.env).toMatchObject({ EXPORT_ONCE: 'partial', EXPORT_ONCE_CAUSE: 'review_failed' });
    });

    it('hands an opencode review’s readout to the exporter, from the reviewer’s own database', async () => {
        const opencode = { ...review, executorType: 'opencode' } as unknown as ReviewClaim;
        const { steps, host: stepHost } = sinkOf((step) =>
            step.id.endsWith('review-export') ? { exitCode: 0, stdout: '{"session":"ses_1"}' } : reviewed(0)(step)
        );
        const given = exporter();
        await runReviewSteps(stepHost, { caller, review: opencode, session: null, exporter: given });
        const exportStep = steps[3]!;
        expect(exportStep.kind).toBe('review');
        expect(exportStep.cwd).toBe(REVIEWER_HOME);
        expect(exportStep.argv).toEqual(['node', '-e', opencodeReadoutScript]);
        expect(exportStep.env).toMatchObject({ OPENCODE_DB: `${REVIEWER_HOME}/data/${ROOT}/opencode/opencode.db` });
        expect(exportStep.env.OPENCODE_DIR).toBe(steps[1]!.env.WORKTREE);
        expect(given.readout).toHaveBeenCalledWith('{"session":"ses_1"}');
    });

    it('runs no export step without an exporter', async () => {
        const plain = sinkOf(reviewed(0));
        await runReviewSteps(plain.host, { caller, review, session });
        expect(plain.steps.map((step) => step.kind)).toEqual(['sync', 'sync', 'review']);
    });

    it('is not run when the restore failed, so no review ran', async () => {
        const { steps, host: stepHost } = sinkOf(() => ({ exitCode: 0, stdout: '{"ok":false,"reason":"gone"}' }));
        await runReviewSteps(stepHost, { caller, review, session, exporter: exporter() });
        expect(steps).toHaveLength(2);
    });
});

// Why the export is the reviewer container's step: both real entrypoints narrow the reviewer's session
// store to its own uid, so the supervisor's uid (group 1000) cannot read what a review wrote. If an
// entrypoint ever relaxes that, this pin is where to revisit the choice.
describe('the reviewer’s stores, as the real entrypoints leave them', () => {
    const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

    it.each([
        ['docker/claude-executor/entrypoint.sh', /chmod 0700 "\$CLAUDE_CONFIG_DIR"/],
        ['docker/opencode-executor/entrypoint.sh', /chmod 0700 "\$XDG_DATA_HOME"/],
    ])('%s narrows the store to the running uid', (path, narrowing) => {
        expect(read(path)).toMatch(narrowing);
    });
});
