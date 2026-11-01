import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import type { CheckpointPointer, CheckpointRead } from '../src/board/board-checkpoint.js';
import { loadDriverConfig } from '../src/config.js';
import type { StepSink } from '../src/step-control.js';
import { SUPERVISOR_ENV, type StepRequest } from '../src/supervisor-contract.js';
import { CheckpointUnrestorable, planTaskVolume, restoreTaskTree } from '../src/task-restore.js';

// A repository-free OpenCode thread checkpoints its session database; the restore plan and step carry it.
const ROOT = '11111111-1111-4111-8111-111111111111';
const config = loadDriverConfig({});
const job = (over: Partial<BoardJob> = {}) =>
    ({
        id: '22222222-2222-4222-8222-222222222222',
        rootJobId: ROOT,
        repo: null,
        executorType: 'opencode',
        claimSeq: 1,
        followUp: true,
        resumeSessionId: null,
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: 'tok' },
        ...over,
    }) as BoardJob;
const POINTER: CheckpointPointer = {
    bytes: 10,
    truncated: false,
    chunks: [{ offset: 0, length: 10, sha256: 'a'.repeat(64) }],
};
const board = (read: CheckpointRead) => ({ checkpoint: vi.fn(async () => read) });
const found = (checkpoint: CheckpointPointer = POINTER): CheckpointRead => ({ state: 'found', checkpoint });

describe('planTaskVolume for a repository-free OpenCode thread', () => {
    it('restores the database into the next generation from a complete checkpoint, with no tree', async () => {
        const j = job();
        expect(await planTaskVolume(board(found()), j, { live: [], highest: 2, unschedulable: [] })).toEqual({
            create: true,
        });
        expect(j.taskGeneration).toBe(3);
        expect(j.taskRestore).toEqual({ checkpoint: POINTER, older: [], restored: false, sessionsOnly: true });
    });

    it('hands the claim back when the checkpoint read throws', async () => {
        const source = { checkpoint: vi.fn(async () => Promise.reject(new Error('board down'))) };
        await expect(planTaskVolume(source, job(), { live: [], highest: 2, unschedulable: [] })).rejects.toThrow(
            'board down'
        );
    });

    it.each([
        ['found', found(), POINTER],
        ['none', { state: 'none' } as CheckpointRead, null],
        ['gone', { state: 'gone' } as CheckpointRead, null],
        ['truncated', found({ ...POINTER, truncated: true }), null],
    ])('owes an adopted generation the database check whatever the checkpoint says: %s', async (_n, read, pointer) => {
        const j = job();
        expect(await planTaskVolume(board(read), j, { live: [3, 2], highest: 3, unschedulable: [] })).toEqual({
            create: false,
        });
        expect(j.taskRestore).toEqual({ checkpoint: pointer, older: [2], restored: false, sessionsOnly: true });
    });

    it('hands the claim back when the checkpoint of an adopted generation cannot be read', async () => {
        const source = { checkpoint: vi.fn(async () => Promise.reject(new Error('board down'))) };
        await expect(planTaskVolume(source, job(), { live: [3, 2], highest: 3, unschedulable: [] })).rejects.toThrow(
            'board down'
        );
    });

    it('does not mistake a missing source for a confirmed absence', async () => {
        await expect(planTaskVolume(undefined, job(), { live: [3, 2], highest: 3, unschedulable: [] })).rejects.toThrow(
            /no checkpoint source/
        );
    });

    it('refuses an empty lost volume with no complete checkpoint', async () => {
        await expect(
            planTaskVolume(board({ state: 'none' }), job(), { live: [], highest: 2, unschedulable: [] })
        ).rejects.toBeInstanceOf(CheckpointUnrestorable);
    });
});

describe('restoreTaskTree for a repository-free OpenCode thread', () => {
    const sink = (stdout: string) => {
        const steps: StepRequest[] = [];
        const impl: StepSink = {
            submit: async (_token, step) => {
                steps.push(step);
                return { exitCode: 0, stdout, stderr: '', timedOut: false };
            },
            awaitReport: () => new Promise(() => undefined),
            agentEnded: () => undefined,
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };
        return { steps, host: { config, sink: impl } };
    };

    it('submits the database path and the chunks, with no checkout, remote or sessions directory', async () => {
        const { steps, host } = sink('{"ok":true,"reason":null}');
        const j = job();
        j.taskRestore = { checkpoint: POINTER, older: [1], restored: false, sessionsOnly: true };
        const removeOlder = vi.fn(async () => undefined);
        expect(await restoreTaskTree(host, j, { removeOlder })).toEqual({ ok: true, reason: null });
        const env = steps[0]?.env;
        expect(env).toMatchObject({
            OPENCODE_DB: `/task/.factory/opencode/${ROOT}/opencode/opencode.db`,
            CHUNKS: JSON.stringify(POINTER.chunks),
        });
        for (const name of ['CHECKOUT', 'REMOTE', 'BRANCH', 'SESSIONS_DIR']) expect(env).not.toHaveProperty(name);
        expect(removeOlder).toHaveBeenCalledExactlyOnceWith([1]);
    });

    it('returns the step refusal when the database is confirmed absent and no checkpoint carries it', async () => {
        const { host } = sink('{"ok":false,"reason":"none","kind":"checkpoint_unrestorable"}');
        const j = job();
        j.taskRestore = { checkpoint: null, older: [1], restored: false, sessionsOnly: true };
        const removeOlder = vi.fn(async () => undefined);
        expect(await restoreTaskTree(host, j, { removeOlder })).toMatchObject({
            ok: false,
            kind: 'checkpoint_unrestorable',
        });
        expect(removeOlder).not.toHaveBeenCalled();
    });

    it('interrupts, never refuses, on an unconfirmed probe', async () => {
        const { host } = sink('{"ok":false,"reason":"EACCES","transient":true}');
        const j = job();
        j.taskRestore = { checkpoint: null, older: [], restored: false, sessionsOnly: true };
        await expect(restoreTaskTree(host, j, { removeOlder: async () => undefined })).rejects.toThrow(/EACCES/);
    });
});
