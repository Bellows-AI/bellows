import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import type { DaemonState, Read } from '../../src/runner.js';
import { drive, gatedJob, ok, stubBoard, stubGateStack, stubRunner } from '../fixtures/loop-stubs.js';

/**
 * A docker class's `dockerd` sidecar lost during the verdict gates: the gate's failure is no
 * verdict. A restart the pod confirms is an infrastructure interruption the next claim redoes —
 * refunded like a node loss, never a `failed` gate, never a rerun inside the attempt — and a pod
 * read that proves nothing is a blocked interruption that spends no budget.
 */
const value = (count: number, running = true): Read<DaemonState> => ({
    kind: 'value',
    value: { restartCount: count, running },
});
const unread: Read<DaemonState> = { kind: 'inconclusive', reason: 'the task pod could not be listed (HTTP 503)' };

async function gatesWithDaemon(reads: Read<DaemonState>[], outcomes: Record<string, number> = { test: 1 }) {
    const board = stubBoard([gatedJob(1)]);
    const { stack, gates } = stubGateStack(outcomes);
    const runner = stubRunner(async () => ok({ output: 'agent did the work' }));
    const asked: BoardJob[] = [];
    const queue = [...reads];
    runner.dockerdRestarts = async (asking) => {
        asked.push(asking);
        return queue.shift() ?? { kind: 'absent' };
    };
    await drive({ ...board, runner, gates });
    return { board: board.board, stack, runner, asked };
}

describe('a dockerd loss during the verdict gates', () => {
    it('ends the attempt as an infrastructure interruption, refunded, with no failure', async () => {
        const { board, stack, runner, asked } = await gatesWithDaemon([value(0), value(1)]);

        expect(board.completed).toEqual([]);
        expect(board.interrupted).toHaveLength(1);
        expect(board.interrupted[0]).toMatchObject({ release: true, nodeLoss: true });
        expect(board.interrupted[0]).not.toHaveProperty('blocked');
        expect(board.interrupted[0]?.reason).toMatch(/infrastructure loss: .*dockerd.* restarted/);
        // The failed gate ran once: no rerun inside the attempt.
        expect(stack.ran.names).toEqual(['test']);
        // Re-read per gates phase, never a baseline kept from elsewhere.
        expect(asked).toHaveLength(2);
        // The runner-loss path's own group end, nothing more: the group is finished once.
        expect(runner.finished).toEqual([gatedJob(1).id]);
        expect(stack.released).toHaveLength(1);
    });

    // An OOM-killed daemon the kubelet has not restarted yet: the count has not moved, the state proves the loss.
    it.each([
        ['terminated, its restart count unchanged', [value(0), value(0, false)]],
        ['not running when the gates began', [value(0, false), value(0, false)]],
    ])('interrupts, refunded, a daemon %s', async (_name, reads) => {
        const { board } = await gatesWithDaemon(reads);

        expect(board.completed).toEqual([]);
        expect(board.interrupted).toHaveLength(1);
        expect(board.interrupted[0]).toMatchObject({ release: true, nodeLoss: true });
        expect(board.interrupted[0]?.reason).toMatch(/infrastructure loss: .*dockerd.* not running/);
    });

    it('lets the gate verdict stand on an unchanged restart count', async () => {
        const { board } = await gatesWithDaemon([value(2), value(2)]);

        expect(board.interrupted).toEqual([]);
        expect(board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
    });

    it.each([
        ['after the gates', [value(0), unread]],
        ['before the gates', [unread, value(1)]],
        ['as a pod that lists no dockerd after one did', [value(0), { kind: 'absent' } as Read<DaemonState>]],
    ])('holds a pod read that proves nothing %s as a blocked interruption, never a failure', async (_when, reads) => {
        const { board } = await gatesWithDaemon(reads);

        expect(board.completed).toEqual([]);
        expect(board.interrupted).toHaveLength(1);
        expect(board.interrupted[0]).toMatchObject({ release: true, blocked: true });
        expect(board.interrupted[0]).not.toHaveProperty('nodeLoss');
    });

    it('never questions passing gates: a restart under a green verdict is no loss', async () => {
        const { board } = await gatesWithDaemon([value(0), value(3)], {});

        expect(board.interrupted).toEqual([]);
        expect(board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('reads nothing more of a class with no daemon: the verdict stands', async () => {
        const { board } = await gatesWithDaemon([{ kind: 'absent' }, { kind: 'absent' }]);

        expect(board.interrupted).toEqual([]);
        expect(board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
    });
});
