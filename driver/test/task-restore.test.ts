import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board.js';
import type { CheckpointPointer, CheckpointRead } from '../src/board-checkpoint.js';
import { loadDriverConfig } from '../src/config.js';
import type { StepSink } from '../src/step-control.js';
import { runSyncStep } from '../src/supervised-steps.js';
import { SUPERVISOR_ENV, type StepRequest } from '../src/supervisor-contract.js';
import {
    CheckpointUnrestorable,
    planTaskVolume,
    restoreTaskTree,
    RESTORE_DEADLINE_MS,
    unrestorableResult,
} from '../src/task-restore.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const config = loadDriverConfig({});
const fresh = (over: Partial<BoardJob> = {}) =>
    ({
        id: '22222222-2222-4222-8222-222222222222',
        rootJobId: ROOT,
        repo: 'acme/widgets',
        claimSeq: 1,
        followUp: false,
        resumeSessionId: null,
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: 'tok' },
        ...over,
    }) as BoardJob;
const continuing = (over: Partial<BoardJob> = {}) => fresh({ followUp: true, ...over });
const POINTER: CheckpointPointer = {
    bytes: 10,
    truncated: false,
    chunks: [{ offset: 0, length: 10, sha256: 'a'.repeat(64) }],
};
const board = (read: CheckpointRead) => ({ checkpoint: vi.fn(async () => read) });
const found = (checkpoint: CheckpointPointer = POINTER): CheckpointRead => ({ state: 'found', checkpoint });

describe('planTaskVolume', () => {
    it('starts a first claim on generation 1 and creates it', async () => {
        const job = fresh();
        const source = board({ state: 'none' });
        expect(await planTaskVolume(source, job, { live: [], highest: 0, unschedulable: [] })).toEqual({
            create: true,
        });
        expect(job.taskGeneration).toBe(1);
        expect(job.taskRestore).toBeUndefined();
        expect(source.checkpoint).not.toHaveBeenCalled();
    });

    it('restores a continuing claim into the next generation when the only volume is unschedulable, deleting it after', async () => {
        const job = continuing();
        const source = board(found());
        expect(await planTaskVolume(source, job, { live: [], highest: 2, unschedulable: [2] })).toEqual({
            create: true,
        });
        expect(job.taskGeneration).toBe(3);
        expect(job.taskRestore).toEqual({ checkpoint: POINTER, older: [2], restored: false });
    });

    // Infrastructure loss interrupts a task; the labelled volume still holds the tree, so with no complete
    // checkpoint the claim adopts it again (label cleared) instead of failing unrestorable.
    // The plan cannot know whether an adopted volume was filled: the restore step decides (the checkout's .git is
    // there, or it is not). With no complete checkpoint the step is owed with no chunks.
    it.each([
        ['none', { state: 'none' } as CheckpointRead],
        ['gone', { state: 'gone' } as CheckpointRead],
        ['truncated', found({ ...POINTER, truncated: true })],
    ])('leaves the adopted restored generation to the restore step when the checkpoint is %s', async (_n, read) => {
        const job = continuing();
        expect(await planTaskVolume(board(read), job, { live: [2, 1], highest: 2, unschedulable: [] })).toEqual({
            create: false,
        });
        expect(job.taskGeneration).toBe(2);
        expect(job.taskRestore).toEqual({ checkpoint: null, older: [1], restored: false });
    });

    it('runs on the unschedulable volume that holds the tree, mark kept, and removes the live ones once it is verified', async () => {
        const job = continuing();
        expect(
            await planTaskVolume(board({ state: 'gone' }), job, { live: [3], highest: 3, unschedulable: [2] })
        ).toEqual({ create: false });
        expect(job.taskGeneration).toBe(2);
        expect(job.taskRestore).toEqual({ checkpoint: null, older: [3], restored: false });
    });

    it('restores into the live volume, not the unschedulable one, when a complete checkpoint exists', async () => {
        const job = continuing();
        await planTaskVolume(board(found()), job, { live: [3], highest: 3, unschedulable: [2] });
        expect(job.taskGeneration).toBe(3);
        expect(job.taskRestore).toEqual({ checkpoint: POINTER, older: [2], restored: false });
    });

    it.each([
        ['none', { state: 'none' } as CheckpointRead, /no checkpoint/],
        ['gone', { state: 'gone' } as CheckpointRead, /no longer stored/],
        ['truncated', found({ ...POINTER, truncated: true }), /size cap/],
    ])('fails checkpoint_unrestorable on %s', async (_name, read, message) => {
        const job = continuing();
        const error = await planTaskVolume(board(read), job, { live: [], highest: 0, unschedulable: [] }).catch(
            (e: unknown) => e
        );
        expect(error).toBeInstanceOf(CheckpointUnrestorable);
        expect((error as Error).message).toMatch(message);
        expect(unrestorableResult(error as CheckpointUnrestorable)).toEqual({
            ok: false,
            reason: (error as Error).message,
            kind: 'checkpoint_unrestorable',
        });
        expect(job.taskRestore).toBeUndefined();
    });

    it('refuses a continuing claim with no checkpoint source rather than starting it empty', async () => {
        await expect(
            planTaskVolume(undefined, continuing(), { live: [], highest: 0, unschedulable: [] })
        ).rejects.toThrow(/no checkpoint source/);
    });
});

/** A sink recording each step; `answer` is the step's outcome. */
const sink = (answer: (step: StepRequest) => { stdout?: string; timedOut?: boolean; exitCode?: number }) => {
    const steps: StepRequest[] = [];
    const impl: StepSink = {
        submit: async (_token, step) => {
            steps.push(step);
            const out = answer(step);
            return {
                exitCode: out.exitCode ?? 0,
                stdout: out.stdout ?? '',
                stderr: '',
                timedOut: out.timedOut ?? false,
            };
        },
        awaitReport: () => new Promise(() => undefined),
        contacted: () => true,
        release: () => undefined,
        attach: () => undefined,
        cancel: () => undefined,
    };
    return { steps, host: { config, sink: impl } };
};
const owed = () => {
    const job = continuing();
    job.taskRestore = { checkpoint: POINTER, older: [1], restored: false };
    return job;
};
const OK = '{"ok":true,"reason":null}';

describe('restoreTaskTree', () => {
    it('does nothing when no restore is owed', async () => {
        const { steps, host } = sink(() => ({ stdout: OK }));
        const removeOlder = vi.fn(async () => undefined);
        expect(await restoreTaskTree(host, continuing(), { removeOlder })).toBeNull();
        expect(steps).toEqual([]);
        expect(removeOlder).not.toHaveBeenCalled();
    });

    it('submits one sync step carrying the chunks and the feed switch, then removes the older generations', async () => {
        const { steps, host } = sink(() => ({ stdout: OK }));
        const order: string[] = [];
        const removeOlder = vi.fn(async () => {
            order.push(`remove after ${steps.length} steps`);
        });
        const job = owed();
        expect(await restoreTaskTree(host, job, { removeOlder })).toEqual({ ok: true, reason: null });
        expect(steps).toHaveLength(1);
        const [step] = steps;
        expect(step).toMatchObject({ kind: 'sync', timeoutMs: RESTORE_DEADLINE_MS });
        expect(step?.id).toMatch(/-restore$/);
        expect(step?.argv.slice(0, 2)).toEqual(['node', '-e']);
        expect(step?.env).toMatchObject({
            CHUNKS: JSON.stringify(POINTER.chunks),
            RESTORE_FEED: '1',
            CHECKOUT: '/task/widgets',
        });
        expect(removeOlder).toHaveBeenCalledExactlyOnceWith([1]);
        expect(order).toEqual(['remove after 1 steps']);
        expect(job.taskRestore?.restored).toBe(true);
        // Owed no more: a second ask runs nothing.
        expect(await restoreTaskTree(host, job, { removeOlder })).toBeNull();
        expect(steps).toHaveLength(1);
    });

    it('names where a claude run reads its sessions from, the working directory munged as the CLI does', async () => {
        const { steps, host } = sink(() => ({ stdout: OK }));
        const job = owed();
        job.executorType = 'claude-code';
        await restoreTaskTree(host, job, { removeOlder: async () => undefined });
        const env = steps[0]?.env;
        expect(env).toMatchObject({ SESSIONS_DIR: `/task/.factory/transcripts/${ROOT}/projects/-task-widgets` });
        expect(env).not.toHaveProperty('OPENCODE_DB');
    });

    it('names the OpenCode database an opencode run reads, and no sessions directory', async () => {
        const { steps, host } = sink(() => ({ stdout: OK }));
        const job = owed();
        job.executorType = 'opencode';
        await restoreTaskTree(host, job, { removeOlder: async () => undefined });
        const env = steps[0]?.env;
        expect(env).toMatchObject({ OPENCODE_DB: `/task/.factory/opencode/${ROOT}/opencode/opencode.db` });
        expect(env).not.toHaveProperty('SESSIONS_DIR');
    });

    it.each([
        ['a failed verdict', { stdout: '{"ok":false,"reason":"boom"}' }],
        ['a timeout', { timedOut: true }],
        ['an unparseable result', { stdout: 'garbage', exitCode: 1 }],
    ])('keeps the older generations on %s', async (_name, outcome) => {
        const { host } = sink(() => outcome);
        const removeOlder = vi.fn(async () => undefined);
        const job = owed();
        const result = await restoreTaskTree(host, job, { removeOlder });
        expect(result).toMatchObject({ ok: false });
        expect(result?.reason).toMatch(/checkpoint restore failed|boom/);
        expect(removeOlder).not.toHaveBeenCalled();
        expect(job.taskRestore?.restored).toBe(false);
    });

    it('swallows a failed delete: the restore stands and the next claim removes the leftover', async () => {
        const { host } = sink(() => ({ stdout: OK }));
        const removeOlder = vi.fn(async () => {
            throw new Error('apiserver down');
        });
        expect(await restoreTaskTree(host, owed(), { removeOlder })).toEqual({ ok: true, reason: null });
    });

    it('runs the step with no chunks when no complete checkpoint is owed, and removes the older ones when it is ok', async () => {
        const job = continuing();
        job.taskRestore = { checkpoint: null, older: [3], restored: false };
        const { steps, host } = sink(() => ({ stdout: OK }));
        const removeOlder = vi.fn(async () => undefined);

        expect(await restoreTaskTree(host, job, { removeOlder })).toEqual({ ok: true, reason: null });

        expect(steps[0]?.env).toMatchObject({ CHUNKS: '[]' });
        expect(removeOlder).toHaveBeenCalledWith([3]);
    });

    it('carries the credential helper only beside a token', async () => {
        const { steps, host } = sink(() => ({ stdout: OK }));
        await restoreTaskTree(host, owed(), { removeOlder: async () => undefined });
        await restoreTaskTree(host, owed(), { removeOlder: async () => undefined, githubToken: 'ghs_x' });
        expect(steps[0]?.env).not.toHaveProperty('CRED_HELPER');
        expect(steps[1]?.env).toHaveProperty('CRED_HELPER');
    });
});

describe('runSyncStep after a restore', () => {
    it('syncs in RESTORE mode even for a claim that did not look continuing', async () => {
        const job = fresh();
        job.taskRestore = { checkpoint: POINTER, older: [], restored: true };
        const { steps, host } = sink(() => ({ stdout: OK }));
        await runSyncStep(host, job, 'ghs_x');
        expect(steps[0]?.env).toMatchObject({ RESTORE: '1' });
        expect(steps[0]?.env).not.toHaveProperty('CRED_HELPER');
    });

    it('fetches as a starting claim does when nothing was restored', async () => {
        const { steps, host } = sink(() => ({ stdout: OK }));
        await runSyncStep(host, fresh(), 'ghs_x');
        expect(steps[0]?.env).not.toHaveProperty('RESTORE');
        expect(steps[0]?.env).toHaveProperty('CRED_HELPER');
    });
});
