import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { helperEffectId } from '../src/helper-receipts.js';
import type { HelperPlan } from '../src/helpers.js';
import { worktreeDir } from '../src/publish.js';
import { REVIEW_COLLECT_PROBE_ID, REVIEW_REPLY_PROBE_ID } from '../src/review-helpers.js';
import { StepChannelClosed, type StepSink, StepTimedOut } from '../src/step-control.js';
import { runHelperStep } from '../src/supervised-steps.js';
import { SUPERVISOR_ENV, type StepRequest, type StepResult } from '../src/supervisor-contract.js';

/**
 * Block-helper receipts across claims (issue #826). Two claims of one job — a lost one and its
 * replacement, each with its own lease and so its own step ids — share the task volume (a temp
 * directory here) and nothing else. The ledger steps run the real script, as the supervisor would;
 * the helper's external write is a counter, and the "crash" is the supervisor channel closing at a
 * chosen step. The remote-marker reconciliation a re-run relies on is pinned in
 * `review-helpers.test.ts`; nothing here assumes an exactly-once write.
 */
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const REPLIED = JSON.stringify({
    schema: 'review-reply-probe/v1',
    version: 1,
    ok: true,
    output: 'REVIEW-REPLIED',
    control: 'conclude',
});
const EFFECT = 'effect-of-the-reply';
const plan: HelperPlan = { helperId: REVIEW_REPLY_PROBE_ID, phase: 'pre', input: {}, githubWriting: true };

function volume() {
    const mount = mkdtempSync(join(tmpdir(), 'receipts-'));
    dirs.push(mount);
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', WORKSPACE_MOUNT: mount, JOB_BOARD_TOKEN: 'board-key' });
    return { config };
}

const claim = (seq: number, over: Partial<BoardJob> = {}): BoardJob =>
    ({
        id: '11111111-1111-4111-8111-111111111111',
        command: 'reply to the review',
        attempts: seq,
        maxAttempts: 3,
        claimSeq: seq,
        leaseToken: `2222222${seq}-2222-4222-8222-222222222222`,
        userId: '44444444-4444-4444-8444-444444444444',
        workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
        repo: 'octo/factory',
        env: {},
        supervisorEnv: { [SUPERVISOR_ENV.controlToken]: `control-${seq}` },
        ...over,
    }) as BoardJob;

type Crash = 'helper-unrun' | 'helper-answer' | 'done-write' | null;

/**
 * One claim's supervisor: runs ledger steps for real, counts the helper's external write, and
 * closes its channel at `crash` — before the helper ran, after it ran (its answer lost), or on the
 * receipt write that follows it.
 */
function supervisor(config: ReturnType<typeof volume>['config'], remote: { writes: number }, crash: Crash = null) {
    const submitted: StepRequest[] = [];
    const sink: StepSink = {
        submit: async (_token, step) => {
            submitted.push(step);
            if (step.env.LEDGER) {
                if (crash === 'done-write' && step.env.STATE === 'done') throw new StepChannelClosed('the receipt');
                const run = spawnSync(step.argv[0]!, step.argv.slice(1), {
                    env: { PATH: process.env.PATH!, ...step.env },
                });
                return {
                    exitCode: run.status,
                    stdout: run.stdout.toString(),
                    stderr: run.stderr.toString(),
                    timedOut: false,
                } satisfies StepResult;
            }
            if (crash === 'helper-unrun') throw new StepChannelClosed('the helper');
            remote.writes += 1;
            if (crash === 'helper-answer') throw new StepChannelClosed('the helper');
            return { exitCode: 0, stdout: `${REPLIED}\n`, stderr: '', timedOut: false };
        },
        awaitReport: () => Promise.reject(new Error('not used')),
        contacted: () => true,
        release: () => undefined,
        attach: () => undefined,
    };
    const helperSteps = () => submitted.filter((s) => s.env.HELPER_INPUT !== undefined);
    return { host: { config, sink }, submitted, helperSteps };
}

const receiptOf = (config: ReturnType<typeof volume>['config'], job: BoardJob, op = EFFECT) => {
    const file = `${worktreeDir(config, job)}/.factory/helpers.json`;
    if (!existsSync(file)) return;
    return (JSON.parse(readFileSync(file, 'utf8')) as { operations: Record<string, { state?: string }> }).operations[
        op
    ];
};

describe('the helper effect id', () => {
    const id = (job: BoardJob, over: Partial<HelperPlan> = {}, at: [number, number] = [0, 0]) =>
        helperEffectId(job, { ...plan, ...over }, at[0], at[1]);

    it('is the same on every claim of the job: no lease, claim sequence or attempt in it', () => {
        expect(id(claim(2))).toBe(id(claim(1)));
        expect(id(claim(1))).not.toContain(claim(1).leaseToken);
    });

    it('names another effect for another job, command, phase, position, helper or input', () => {
        const base = id(claim(1));
        const others = [
            id(claim(1, { id: '99999999-1111-4111-8111-111111111111' })),
            id(claim(1, { command: 'reply again' })),
            id(claim(1), { phase: 'post' }),
            id(claim(1), {}, [1, 0]),
            id(claim(1), {}, [0, 1]),
            id(claim(1), { helperId: 'noop' }),
            id(claim(1), { input: { publication: { prNumber: 8 } } }),
        ];
        expect(new Set([base, ...others]).size).toBe(others.length + 1);
    });
});

describe('block-helper receipts across claims', () => {
    it('crash after the receipt: the replacement claim answers the recorded result and writes nothing', async () => {
        const { config } = volume();
        const remote = { writes: 0 };
        const first = supervisor(config, remote);
        const firstResult = await runHelperStep(first.host, claim(1), plan, { effectId: EFFECT });
        const second = supervisor(config, remote);
        const secondResult = await runHelperStep(second.host, claim(2), plan, { effectId: EFFECT });

        expect(firstResult).toEqual({ ok: true, output: 'REVIEW-REPLIED', control: 'conclude' });
        expect(secondResult).toEqual(firstResult);
        expect(remote.writes).toBe(1);
        expect(second.helperSteps()).toEqual([]);
        // Not because the step ids matched: each claim's ids carry its own lease.
        const firstIds = new Set(first.submitted.map((s) => s.id));
        expect(second.submitted.some((s) => firstIds.has(s.id))).toBe(false);
    });

    it('crash before the write: the receipt says started, and the replacement claim runs the helper', async () => {
        const { config } = volume();
        const remote = { writes: 0 };
        const first = supervisor(config, remote, 'helper-unrun');
        await expect(runHelperStep(first.host, claim(1), plan, { effectId: EFFECT })).rejects.toBeInstanceOf(
            StepChannelClosed
        );
        expect(receiptOf(config, claim(1))).toMatchObject({ state: 'started' });

        const second = supervisor(config, remote);
        expect(await runHelperStep(second.host, claim(2), plan, { effectId: EFFECT })).toMatchObject({ ok: true });
        expect(remote.writes).toBe(1);
        expect(receiptOf(config, claim(2))).toMatchObject({ state: 'done' });
    });

    it.each<[string, Crash]>([
        ['its answer was lost', 'helper-answer'],
        ['its receipt write was lost', 'done-write'],
    ])(
        'crash after the write, before the receipt (%s): the replacement claim re-runs it to reconcile',
        async (_l, crash) => {
            const { config } = volume();
            const remote = { writes: 0 };
            const first = supervisor(config, remote, crash);
            // The lost claim is interrupted wherever its supervisor went, never handed a verdict.
            await expect(runHelperStep(first.host, claim(1), plan, { effectId: EFFECT })).rejects.toBeInstanceOf(
                StepChannelClosed
            );
            expect(receiptOf(config, claim(1))).toMatchObject({ state: 'started' });

            // An uncertain effect is never answered from the receipt: the helper runs again, and it is
            // the helper's own read of the remote that keeps it from writing twice.
            const second = supervisor(config, remote);
            expect(await runHelperStep(second.host, claim(2), plan, { effectId: EFFECT })).toMatchObject({ ok: true });
            expect(second.helperSteps()).toHaveLength(1);
            expect(receiptOf(config, claim(2))).toMatchObject({ state: 'done' });
        }
    );

    it('throws a supervisor lost on the receipt read: no receipt is taken for unrecorded, nothing runs', async () => {
        const { config } = volume();
        const remote = { writes: 0 };
        await runHelperStep(supervisor(config, remote).host, claim(1), plan, { effectId: EFFECT });
        const second = supervisor(config, remote);
        const losing: StepSink = {
            ...second.host.sink,
            submit: async (token, step, signal) => {
                if (step.env.ACTION === 'read') throw new StepTimedOut(step.id);
                return second.host.sink.submit(token, step, signal);
            },
        };
        await expect(
            runHelperStep({ config, sink: losing }, claim(2), plan, { effectId: EFFECT })
        ).rejects.toBeInstanceOf(StepTimedOut);
        expect(second.submitted).toEqual([]);
        expect(remote.writes).toBe(1);
    });

    it('keeps effects apart: another effect id is not answered from this one’s receipt', async () => {
        const { config } = volume();
        const remote = { writes: 0 };
        await runHelperStep(supervisor(config, remote).host, claim(1), plan, { effectId: EFFECT });
        await runHelperStep(supervisor(config, remote).host, claim(2), plan, { effectId: 'another-effect' });
        expect(remote.writes).toBe(2);
    });

    it('reads a receipt it cannot verify as never recorded: a forged result is never replayed', async () => {
        const { config } = volume();
        const job = claim(1);
        const ledger = `${worktreeDir(config, job)}/.factory/helpers.json`;
        mkdirSync(join(ledger, '..'), { recursive: true });
        const forged = { ok: true, output: 'REVIEW-CLEAN', control: 'conclude' };
        writeFileSync(
            ledger,
            JSON.stringify({ operations: { [EFFECT]: { state: 'done', result: forged, mac: 'x' } } })
        );

        const remote = { writes: 0 };
        expect(await runHelperStep(supervisor(config, remote).host, job, plan, { effectId: EFFECT })).toEqual({
            ok: true,
            output: 'REVIEW-REPLIED',
            control: 'conclude',
        });
        expect(remote.writes).toBe(1);
    });

    it('runs nothing when the started receipt cannot be written', async () => {
        const { config } = volume();
        const remote = { writes: 0 };
        const s = supervisor(config, remote);
        const failing: StepSink = {
            ...s.host.sink,
            submit: async (token, step, signal) =>
                step.env.STATE === 'started'
                    ? { exitCode: 1, stdout: '', stderr: 'disk full', timedOut: false }
                    : s.host.sink.submit(token, step, signal),
        };
        const result = await runHelperStep({ config, sink: failing }, claim(1), plan, { effectId: EFFECT });
        expect(result).toMatchObject({ ok: false, reason: 'runner_error' });
        expect(remote.writes).toBe(0);
    });

    it('keeps the answer when only its done receipt fails to write: the effect stays started', async () => {
        const { config } = volume();
        const remote = { writes: 0 };
        const s = supervisor(config, remote);
        const failing: StepSink = {
            ...s.host.sink,
            submit: async (token, step, signal) =>
                step.env.STATE === 'done'
                    ? { exitCode: 1, stdout: '', stderr: 'disk full', timedOut: false }
                    : s.host.sink.submit(token, step, signal),
        };
        const result = await runHelperStep({ config, sink: failing }, claim(1), plan, { effectId: EFFECT });
        expect(result).toMatchObject({ ok: true, output: 'REVIEW-REPLIED' });
        expect(receiptOf(config, claim(1))).toMatchObject({ state: 'started' });
    });

    it('keeps no receipt for a job with no worktree, a driver with no board token, or a helper not receipted', async () => {
        const { config } = volume();
        const remote = { writes: 0 };
        const repoless = supervisor(config, remote);
        await runHelperStep(repoless.host, claim(1, { repo: null } as Partial<BoardJob>), plan, { effectId: EFFECT });
        expect(repoless.submitted.filter((s) => s.env.LEDGER)).toEqual([]);

        // With no key, a receipt is one the agent could forge: none is kept, every claim runs it.
        const keyless = supervisor({ ...config, boardToken: '' }, remote);
        await runHelperStep(keyless.host, claim(1), plan, { effectId: EFFECT });
        expect(keyless.submitted.filter((s) => s.env.LEDGER)).toEqual([]);

        // A probe reads the PR and the tree as they are now; replaying its answer would be stale.
        for (const helperId of [REVIEW_COLLECT_PROBE_ID, 'merge-conflict-probe', 'noop']) {
            const s = supervisor(config, remote);
            await runHelperStep(s.host, claim(1), { ...plan, helperId }, { effectId: EFFECT });
            expect(s.submitted.filter((step) => step.env.LEDGER)).toEqual([]);
        }
    });

    it('throws a lost supervisor rather than failing the helper: the attempt was interrupted', async () => {
        const { config } = volume();
        const s = supervisor(config, { writes: 0 }, 'helper-unrun');
        await expect(runHelperStep(s.host, claim(1), { ...plan, helperId: 'noop' })).rejects.toBeInstanceOf(
            StepChannelClosed
        );
    });
});
