import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import type { CheckpointRead } from '../src/board/board-checkpoint.js';
import { TASK_ROOT_LABEL, taskVolumeName } from '../src/task-volume.js';
import { k8sSyncRun } from './k8s-sync-step.js';

/**
 * The kubernetes runner restoring a thread's task tree (issue #775): the docker twins live in
 * docker.test.ts. The restore step precedes the sync step, the older claim goes only after the restore
 * reports ok, and a follow-up that cannot be rebuilt ends `checkpoint_unrestorable`.
 */

const ROOT = '55555555-5555-4555-8555-555555555555';
const OK = '{"ok":true,"reason":null}';
const job = (over: Partial<BoardJob> = {}): BoardJob =>
    ({
        id: ROOT,
        rootJobId: ROOT,
        command: 'do the work',
        rootCommand: 'do the work',
        attempts: 1,
        maxAttempts: 3,
        lastAttempt: false,
        claimSeq: 1,
        leaseToken: '22222222-2222-4222-8222-222222222222',
        leaseExpiresAt: '2026-08-29T12:05:00.000Z',
        executorType: 'claude-code',
        executorRefusal: null,
        planRefusal: null,
        skillRefusal: null,
        masterPrompt: 'Factory execution contract (factory-master-prompt/v1)',
        resumeSessionId: null,
        followUp: true,
        ownSession: false,
        continuesInterrupted: false,
        userId: '44444444-4444-4444-8444-444444444444',
        workspacePath: 'bellows/44444444-4444-4444-8444-444444444444',
        repo: 'acme/widgets',
        env: {},
        ...over,
    }) as BoardJob;
const FOUND: CheckpointRead = {
    state: 'found',
    checkpoint: { bytes: 4, truncated: false, chunks: [{ offset: 0, length: 4, sha256: 'd'.repeat(64) }] },
};
const claim = (generation: number) => ({
    metadata: { name: taskVolumeName(job(), generation), labels: { [TASK_ROOT_LABEL]: ROOT } },
});
const board = (read: CheckpointRead) => ({ checkpoint: async () => read });
const called = <T extends { method: string }>(calls: T[], method: string) => calls.filter((c) => c.method === method);
const claimsCreated = (calls: { method: string; path: string; body?: unknown }[]) =>
    called(calls, 'POST')
        .filter((c) => c.path.endsWith('/persistentvolumeclaims'))
        .map((c) => (c.body as { metadata: { name: string } }).metadata.name);
const claimsDeleted = (calls: { method: string; path: string }[]) =>
    called(calls, 'DELETE')
        .map((c) => c.path.split('/persistentvolumeclaims/')[1])
        .filter((name) => name !== undefined);

describe('the kubernetes runner restoring a task volume', () => {
    it('creates generation n+1, submits the restore step before the sync step and leaves nothing to delete', async () => {
        const run = await k8sSyncRun(job(), { checkpoints: board(FOUND), answer: () => OK, githubToken: 'ghs_x' });
        expect(run).toMatchObject({ value: { ok: true } });
        expect(claimsCreated(run.calls)).toEqual([taskVolumeName(job(), 2)]);
        expect(run.steps[0]?.id).toMatch(/-restore$/);
        expect(run.steps[0]).toMatchObject({ kind: 'sync', env: { RESTORE_FEED: '1' } });
        expect(run.steps[1]?.env).toMatchObject({ RESTORE: '1' });
        expect(claimsDeleted(run.calls)).toEqual([]);
    });

    it('deletes the older claim only after the restore reports ok', async () => {
        const run = await k8sSyncRun(job(), {
            checkpoints: board(FOUND),
            answer: () => OK,
            volumes: [claim(1), claim(2)],
        });
        expect(run).toMatchObject({ value: { ok: true } });
        expect(claimsCreated(run.calls)).toEqual([]);
        expect(claimsDeleted(run.calls)).toEqual([taskVolumeName(job(), 1)]);
    });

    it('keeps the older claim and the sync step when the restore fails', async () => {
        const run = await k8sSyncRun(job(), {
            checkpoints: board(FOUND),
            answer: (step) => (step.id.endsWith('-restore') ? '{"ok":false,"reason":"bundle unreadable"}' : OK),
            volumes: [claim(1), claim(2)],
        });
        expect(run).toMatchObject({ value: { ok: false } });
        expect((run as { value: { reason: string } }).value.reason).toContain('bundle unreadable');
        expect(run.steps).toHaveLength(1);
        expect(claimsDeleted(run.calls)).toEqual([]);
    });

    it.each([
        ['none', { state: 'none' } as CheckpointRead],
        ['gone', { state: 'gone' } as CheckpointRead],
        ['truncated', { state: 'found', checkpoint: { bytes: 1, truncated: true, chunks: [] } } as CheckpointRead],
    ])('ends a follow-up with checkpoint_unrestorable on a %s checkpoint and no claim', async (_n, read) => {
        const run = await k8sSyncRun(job(), { checkpoints: board(read), answer: () => OK });
        expect(run).toMatchObject({ value: { ok: false, kind: 'checkpoint_unrestorable' } });
        expect(run.steps).toEqual([]);
        expect(claimsCreated(run.calls)).toEqual([]);
    });

    it('starts a first claim on generation 1 with a fresh clone and no restore', async () => {
        const run = await k8sSyncRun(job({ followUp: false }), {
            checkpoints: board({ state: 'none' }),
            answer: () => OK,
        });
        expect(claimsCreated(run.calls)).toEqual([taskVolumeName(job(), 1)]);
        expect(run.steps.some((s) => s.id.endsWith('-restore'))).toBe(false);
    });
});
