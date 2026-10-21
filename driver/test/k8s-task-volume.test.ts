import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board.js';
import type { CheckpointRead } from '../src/board-checkpoint.js';
import { loadDriverConfig } from '../src/config.js';
import {
    ensureTaskVolume,
    listTaskVolumes,
    markTaskVolumeUnschedulable,
    removeTaskVolumes,
    taskVolumesPath,
} from '../src/k8s-task-volume.js';
import type { K8sDeps, K8sMethod, K8sResponse } from '../src/k8s-transport.js';
import { CheckpointUnrestorable } from '../src/task-restore.js';
import { TASK_ROOT_LABEL, TASK_UNSCHEDULABLE_LABEL, taskVolumeName } from '../src/task-volume.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const config = loadDriverConfig({ EXECUTOR: 'kubernetes', RUNNER_SERVICES: '0' });
const PATH = taskVolumesPath(config.k8sNamespace);
const job = (over: Partial<BoardJob> = {}) =>
    ({
        id: '22222222-2222-4222-8222-222222222222',
        rootJobId: ROOT,
        executorType: 'claude-code',
        claimSeq: 1,
        followUp: false,
        resumeSessionId: null,
        workspacePath: 'acme/33333333-3333-4333-8333-333333333333',
        ...over,
    }) as BoardJob;
const continuing = () => job({ followUp: true });
const name = (generation: number) => taskVolumeName(job(), generation);
const claim = (generation: number, terminating = false) => ({
    metadata: {
        name: name(generation),
        labels: { [TASK_ROOT_LABEL]: ROOT },
        ...(terminating ? { deletionTimestamp: '2026-01-01T00:00:00Z' } : {}),
    },
});
const CHECKPOINT: CheckpointRead = {
    state: 'found',
    checkpoint: { bytes: 4, truncated: false, chunks: [{ offset: 0, length: 4, sha256: 'b'.repeat(64) }] },
};

/**
 * An apiserver for the thread's claims: the label LIST answers `listing` (a response, or a body), a
 * POST answers `create`, a DELETE answers `remove`. Every call is recorded.
 */
function server({
    listing = { items: [] } as unknown,
    create = { status: 201, body: '{}' } as K8sResponse,
    remove = { status: 200, body: '{}' } as K8sResponse,
    checkpoint = CHECKPOINT,
}: {
    listing?: unknown;
    create?: K8sResponse;
    remove?: K8sResponse;
    checkpoint?: CheckpointRead;
} = {}) {
    const calls: { method: K8sMethod; path: string; body?: unknown }[] = [];
    const checkpoints = { checkpoint: vi.fn(async () => checkpoint) };
    const deps: K8sDeps = {
        config,
        sleep: async () => undefined,
        checkpoints,
        request: async (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'GET') {
                return isResponse(listing) ? listing : { status: 200, body: JSON.stringify(listing) };
            }
            return method === 'POST' ? create : method === 'PATCH' ? { status: 200, body: '{}' } : remove;
        },
    };
    return { calls, deps, checkpoints };
}
const isResponse = (value: unknown): value is K8sResponse =>
    typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
const posts = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === 'POST');
const createdNames = (calls: { method: string; body?: unknown }[]) =>
    posts(calls).map((c) => (c.body as { metadata: { name: string } }).metadata.name);
const deletes = <T extends { method: string }>(calls: T[]) => calls.filter((c) => c.method === 'DELETE');

const stuck = (generation: number) => ({
    metadata: {
        ...claim(generation).metadata,
        labels: { [TASK_ROOT_LABEL]: ROOT, [TASK_UNSCHEDULABLE_LABEL]: 'true' },
    },
});

describe('a volume no pod can be scheduled onto', () => {
    it('is listed apart: never live, still counted in the highest generation, so its name is not reused', async () => {
        const { deps } = server({ listing: { items: [stuck(2)] } });
        expect(await listTaskVolumes(deps, job())).toEqual({ live: [], highest: 2, unschedulable: [2] });
    });

    it('is marked by a label patch on its claim', async () => {
        const { deps, calls } = server();
        await markTaskVolumeUnschedulable(deps, job({ taskGeneration: 2 }));
        expect(calls).toEqual([
            {
                method: 'PATCH',
                path: `${PATH}/${name(2)}`,
                body: { metadata: { labels: { [TASK_UNSCHEDULABLE_LABEL]: 'true' } } },
            },
        ]);
    });

    it('leaves the next generation to be created and restored, and the stuck one for the restore to delete', async () => {
        const { deps, calls } = server({ listing: { items: [stuck(1)] } });
        const next = continuing();
        await ensureTaskVolume(deps, next);
        expect(createdNames(calls)).toEqual([name(2)]);
        expect(next.taskRestore).toMatchObject({ older: [1], restored: false });
    });
});

describe('a volume no pod can be scheduled onto, with no checkpoint to restore from', () => {
    it.each([{ state: 'none' }, { state: 'gone' }] as CheckpointRead[])(
        'is adopted again with its label cleared, never failed unrestorable (%o)',
        async (checkpoint) => {
            const { deps, calls } = server({ listing: { items: [stuck(2)] }, checkpoint });
            const next = continuing();
            await ensureTaskVolume(deps, next);
            expect(next.taskGeneration).toBe(2);
            expect(next.taskRestore).toBeUndefined();
            expect(calls.filter((c) => c.method !== 'GET')).toEqual([
                {
                    method: 'PATCH',
                    path: `${PATH}/${name(2)}`,
                    body: { metadata: { labels: { [TASK_UNSCHEDULABLE_LABEL]: null } } },
                },
            ]);
        }
    );
});

describe('listTaskVolumes', () => {
    it('lists by the thread root label and reports live generations and the highest, terminating included', async () => {
        const { deps, calls } = server({ listing: { items: [claim(1), claim(2), claim(3, true)] } });
        expect(await listTaskVolumes(deps, job())).toEqual({ live: [1, 2], highest: 3, unschedulable: [] });
        expect(calls).toHaveLength(1);
        expect(decodeURIComponent(calls[0]?.path ?? '')).toBe(`${PATH}?labelSelector=${TASK_ROOT_LABEL}=${ROOT}`);
    });

    it.each([
        ['a refusal', { status: 403, body: '{"kind":"Status"}' }],
        ['a body that is not JSON', { status: 200, body: 'nope' }],
        ['a body with no items', { status: 200, body: '{}' }],
        [
            'an item of another thread',
            { status: 200, body: JSON.stringify({ items: [{ metadata: { name: 'x', labels: {} } }] }) },
        ],
    ])('throws on %s: an inconclusive list proves nothing', async (_what, listing) => {
        const { deps } = server({ listing });
        await expect(listTaskVolumes(deps, job())).rejects.toThrow();
    });
});

describe('ensureTaskVolume', () => {
    it('creates generation 1 for the first claim and restores nothing', async () => {
        const { deps, calls, checkpoints } = server();
        const j = job();
        await ensureTaskVolume(deps, j);
        expect(j.taskGeneration).toBe(1);
        expect(j.taskRestore).toBeUndefined();
        expect(posts(calls)).toHaveLength(1);
        expect(createdNames(calls)).toEqual([name(1)]);
        expect(checkpoints.checkpoint).not.toHaveBeenCalled();
    });

    it('adopts the highest live generation and creates nothing', async () => {
        const { deps, calls } = server({ listing: { items: [claim(1), claim(2)] } });
        const j = continuing();
        await ensureTaskVolume(deps, j);
        expect(j.taskGeneration).toBe(2);
        expect(j.taskRestore).toMatchObject({ older: [1], restored: false });
        expect(posts(calls)).toEqual([]);
        expect(deletes(calls)).toEqual([]);
    });

    it('creates generation n+1 and owes the restore when a continuing claim finds its volume gone', async () => {
        const { deps, calls } = server({ listing: { items: [claim(1, true)] } });
        const j = continuing();
        await ensureTaskVolume(deps, j);
        // A terminating claim is not adopted, and its name is not reused.
        expect(j.taskGeneration).toBe(2);
        expect(j.taskRestore).toMatchObject({ older: [], restored: false });
        expect(createdNames(calls)).toEqual([name(2)]);
    });

    it('does not reuse the name of a terminating claim for a fresh start either', async () => {
        const { deps, calls } = server({ listing: { items: [claim(1, true)] } });
        const j = job();
        await ensureTaskVolume(deps, j);
        expect(j.taskGeneration).toBe(2);
        expect(j.taskRestore).toBeUndefined();
        expect(posts(calls)).toHaveLength(1);
    });

    it('creates and restores nothing on a failed list, and never asks the board', async () => {
        const { deps, calls, checkpoints } = server({ listing: { status: 500, body: '{}' } });
        await expect(ensureTaskVolume(deps, continuing())).rejects.toThrow();
        expect(posts(calls)).toEqual([]);
        expect(deletes(calls)).toEqual([]);
        expect(checkpoints.checkpoint).not.toHaveBeenCalled();
    });

    it('creates and restores nothing on a malformed list', async () => {
        const { deps, calls, checkpoints } = server({ listing: { items: 'x' } });
        await expect(ensureTaskVolume(deps, continuing())).rejects.toThrow();
        expect(posts(calls)).toEqual([]);
        expect(checkpoints.checkpoint).not.toHaveBeenCalled();
    });

    it.each([
        ['none', { state: 'none' } as CheckpointRead],
        ['gone', { state: 'gone' } as CheckpointRead],
        ['truncated', { state: 'found', checkpoint: { bytes: 1, truncated: true, chunks: [] } } as CheckpointRead],
    ])(
        'fails checkpoint_unrestorable, creating nothing, on a follow-up with a %s checkpoint',
        async (_n, checkpoint) => {
            const { deps, calls } = server({ checkpoint });
            await expect(ensureTaskVolume(deps, continuing())).rejects.toBeInstanceOf(CheckpointUnrestorable);
            expect(posts(calls)).toEqual([]);
        }
    );

    it('adopts the volume a racing creation made when the create answers 409', async () => {
        let listed = 0;
        const { deps, calls } = server({ create: { status: 409, body: '{"reason":"AlreadyExists"}' } });
        const request = deps.request;
        deps.request = async (method, path, body) => {
            if (method === 'GET') {
                listed += 1;
                return { status: 200, body: JSON.stringify({ items: listed === 1 ? [] : [claim(1)] }) };
            }
            return request(method, path, body);
        };
        await ensureTaskVolume(deps, job());
        expect(listed).toBe(2);
        expect(posts(calls)).toHaveLength(1);
    });

    it('fails a 409 whose volume is not there when listed again', async () => {
        const { deps } = server({ create: { status: 409, body: '{}' } });
        await expect(ensureTaskVolume(deps, job())).rejects.toThrow();
    });
});

describe('removeTaskVolumes', () => {
    it('deletes each older generation by name', async () => {
        const { deps, calls } = server();
        await removeTaskVolumes(deps, job(), [2, 1]);
        expect(deletes(calls).map((c) => c.path)).toEqual([`${PATH}/${name(2)}`, `${PATH}/${name(1)}`]);
    });

    it('counts a claim already gone as deleted and throws on any other refusal', async () => {
        await removeTaskVolumes(server({ remove: { status: 404, body: '{}' } }).deps, job(), [1]);
        await expect(
            removeTaskVolumes(server({ remove: { status: 500, body: '{}' } }).deps, job(), [1])
        ).rejects.toThrow();
    });
});
