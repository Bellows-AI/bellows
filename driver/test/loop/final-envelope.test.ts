import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { BoardHttpError } from '../../src/board/board-retry.js';
import type { GateClaim } from '../../src/gates.js';
import { StepChannelClosed } from '../../src/step-control.js';
import type { PublishResult } from '../../src/publish/publish.js';
import type { Loop } from '../../src/loop/loop.js';
import { drive, gatedJob, job, ok, stubBoard, stubGateStack, stubRunner } from '../fixtures/loop-stubs.js';

// Issue #821 (D1): the final envelope is staged under the lease, then completed, and only then is
// the attempt torn down — the heartbeat renewing the lease meanwhile, the order the reproduction
// found inverted (`finish → complete`). A board that takes neither leaves the group for the next
// claim to adopt.
describe('final envelope (issue #821 D1)', () => {
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const landed: PublishResult = {
        ok: true,
        published: true,
        branch: 'fix/1',
        prUrl: 'https://github.com/o/r/pull/1',
        reason: null,
        cause: null,
        repository: 'o/r',
        baseBranch: 'main',
        prNumber: 1,
    };

    /** The board and runner of one attempt, recording the order of the stage, verdict and teardown. */
    function ordered(claimed: BoardJob, options: Parameters<typeof stubBoard>[1] = {}) {
        const order: string[] = [];
        const board = stubBoard([claimed], options);
        const stage = board.board.stageConclusion.bind(board.board);
        const complete = board.board.complete.bind(board.board);
        board.board.stageConclusion = async (j, result) => {
            order.push('stage');
            return stage(j, result);
        };
        board.board.complete = async (j, result) => {
            order.push('complete');
            return complete(j, result);
        };
        const runner = stubRunner(async () => ok(), { publish: landed });
        runner.finish = async () => {
            order.push('finish');
        };
        return { order, board, runner };
    }

    it('stages, then completes, then finishes the group — the staged body the very verdict', async () => {
        const { order, board, runner } = ordered({ ...job(1), repo: 'Bellows-AI/bellows' });

        await drive({ ...board, runner });

        expect(order).toEqual(['stage', 'complete', 'finish']);
        expect(board.board.staged).toEqual(board.board.completed);
        // The whole envelope rides the stage: a driver lost after it leaves the board everything.
        expect(board.board.staged[0]).toMatchObject({ status: 'succeeded', publication: { prNumber: 1 } });
    });

    it('stages a setup fault before its verdict and finishes after it', async () => {
        const claimed = job(1);
        const order: string[] = [];
        const board = stubBoard([claimed]);
        const stage = board.board.stageConclusion.bind(board.board);
        board.board.stageConclusion = async (j, result) => {
            order.push('stage');
            return stage(j, result);
        };
        const complete = board.board.complete.bind(board.board);
        board.board.complete = async (j, result) => {
            order.push('complete');
            return complete(j, result);
        };
        const runner = stubRunner(async () => ok(), { sync: { ok: false, reason: 'the remote said no' } });
        runner.finish = async () => {
            order.push('finish');
        };

        await drive({ ...board, runner });

        expect(order).toEqual(['stage', 'complete', 'finish']);
        expect(board.board.staged[0]).toMatchObject({
            status: 'failed',
            output: expect.stringContaining('remote said no'),
        });
    });

    it('keeps the heartbeat renewing while the verdict is in flight, and a lost or stop beat meanwhile acts on nothing', async () => {
        for (const beat of ['lost', 'stop'] as const) {
            const { order, board, runner } = ordered(job(1));
            let concluding = false;
            board.board.stageConclusion = async (j, result) => {
                order.push('stage');
                board.board.staged.push({ id: j.id, ...result });
                concluding = true;
                return 'held';
            };
            board.board.heartbeat = async () => {
                board.board.beats += 1;
                if (!concluding) return { result: 'held', cancelRequested: false };
                return beat === 'lost' ? 'lost' : { result: 'held', cancelRequested: true };
            };
            board.board.complete = async (j, result) => {
                order.push('complete');
                const before = board.board.beats;
                while (board.board.beats < before + 2) await tick();
                board.board.completed.push({ id: j.id, ...result });
                return { state: 'held', reclaimId: null };
            };

            await drive({ ...board, runner });

            expect(order).toEqual(['stage', 'complete', 'finish']);
            expect(runner.killed).toEqual([]);
            expect(board.board.suspended).toEqual([]);
            expect(board.board.completed).toHaveLength(1);
        }
    });

    it('never hands a concluding attempt over to a drain', async () => {
        const { board, runner } = ordered(job(1));
        let loop: Loop | null = null;
        const attach = board.attach;
        board.attach = (l) => {
            loop = l;
            attach(l);
        };
        const complete = board.board.complete.bind(board.board);
        board.board.complete = async (j, result) => {
            await (loop as Loop | null)?.handover('the driver was drained');
            return complete(j, result);
        };

        await drive({ ...board, runner });

        expect(board.board.interrupted).toEqual([]);
        expect(board.board.completed).toHaveLength(1);
    });

    it('reclaims a done thread’s tree only after the group finished', async () => {
        const { order, board, runner } = ordered(job(1), { reclaimId: 'reclaim-1' });
        const reclaim = runner.reclaimWorktree.bind(runner);
        runner.reclaimWorktree = async (j) => {
            order.push('reclaim');
            return reclaim(j);
        };

        await drive({ ...board, runner });
        for (let i = 0; i < 20 && board.board.reclaimAcks.length === 0; i++) await tick();

        expect(order).toEqual(['stage', 'complete', 'finish', 'reclaim']);
        expect(board.board.reclaimAcks).toEqual(['reclaim-1']);
    });

    it('tears the group down when the stage held but the verdict never landed', async () => {
        const logs: string[] = [];
        const { order, board, runner } = ordered(job(1));
        board.board.complete = async () => {
            order.push('complete');
            throw new BoardHttpError(503, '/api/jobs/x/complete answered 503: busy');
        };

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(order.at(-1)).toBe('finish');
        expect(logs.some((l) => l.includes('the succeeded verdict was not delivered'))).toBe(true);
    });

    // F5 and the stated limit: a board that takes neither the stage nor the verdict leaves the
    // group and the checkout claim to the next claim's adoption — no finish, no release.
    it('leaves the group and the claim when neither the stage nor the verdict was accepted', async () => {
        const logs: string[] = [];
        const { stack, gates } = stubGateStack({}, { control: true });
        const { order, board, runner } = ordered(job(1));
        const released: string[] = [];
        runner.releaseFence = async (j) => {
            released.push(j.id);
        };
        board.board.stageConclusion = async () => {
            order.push('stage');
            throw new BoardHttpError(503, '/api/jobs/x/conclusion answered 503: down');
        };
        board.board.complete = async () => {
            order.push('complete');
            throw new BoardHttpError(503, '/api/jobs/x/complete answered 503: down');
        };

        await drive({ ...board, runner, gates, log: (m) => logs.push(m) });

        expect(order).not.toContain('finish');
        expect(released).toEqual([]);
        expect(stack.controlDeparted).toHaveLength(1);
        expect(stack.controlClosed).toEqual([]);
        expect(
            logs.some((l) =>
                l.includes(
                    'neither the stage nor the verdict was accepted; the group and checkout claim are left for the next claim to adopt'
                )
            )
        ).toBe(true);
    });

    it('settles without a verdict when the stage answers the lease lost', async () => {
        const { order, board, runner } = ordered(job(1), { stageAnswer: 'lost' });

        await drive({ ...board, runner });

        // The lease is the new holder's: its adoption owns the finished runner, so this end finishes nothing (#828).
        expect(order).toEqual(['stage']);
        expect(board.board.completed).toEqual([]);
    });
});

// Issue #773 (R1-2): a gate or setup whose supervisor was lost is the attempt's loss — handed back as
// an interruption on every path that runs one, never a failed gate or a failed setup.
describe('a lost supervisor under the gates and the setup', () => {
    const lost = () => new StepChannelClosed('its step was answered: the task group ended or was taken away');
    const setupJob = (n: number): BoardJob => ({ ...gatedJob(n), gates: { ...gatedJob(n).gates!, setup: 'npm ci' } });
    const interruptedOnly = (board: ReturnType<typeof stubBoard>) => {
        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([
            { id: job(1).id, reason: expect.stringContaining('infrastructure loss'), release: true },
        ]);
    };

    it('interrupts an attempt whose setup before the agent lost its supervisor, and launches nothing', async () => {
        const board = stubBoard([setupJob(1)]);
        const { stack, gates } = stubGateStack();
        stack.manager.runSetup = async () => {
            throw lost();
        };
        let launched = false;
        const runner = stubRunner(async () => {
            launched = true;
            return ok();
        });
        await drive({ ...board, runner, gates });
        expect(launched).toBe(false);
        interruptedOnly(board);
    });

    it('interrupts an agent-less attempt whose setup lost its supervisor', async () => {
        const board = stubBoard([{ ...setupJob(1), agent: false }]);
        const { stack, gates } = stubGateStack();
        stack.manager.runSetup = async () => {
            throw lost();
        };
        await drive({ ...board, runner: stubRunner(async () => ok()), gates });
        interruptedOnly(board);
    });

    it('interrupts an attempt whose end-of-run setup retry lost its supervisor', async () => {
        const board = stubBoard([{ ...setupJob(1), gates: { image: 'node:24', setup: 'npm ci', gates: [] } }]);
        const { stack, gates } = stubGateStack();
        let setups = 0;
        stack.manager.runSetup = async () => {
            setups += 1;
            if (setups === 1) return { exitCode: 1, output: 'registry down' };
            throw lost();
        };
        await drive({ ...board, runner: stubRunner(async () => ok()), gates });
        expect(setups).toBe(2);
        interruptedOnly(board);
    });

    it('interrupts an attempt whose declared gate lost its supervisor, with no gate-failed verdict', async () => {
        const board = stubBoard([gatedJob(1)]);
        const { stack, gates } = stubGateStack();
        stack.manager.runGate = async () => {
            throw lost();
        };
        await drive({ ...board, runner: stubRunner(async () => ok()), gates });
        interruptedOnly(board);
    });

    it('interrupts an attempt once its run is over when an ad-hoc gate found the supervisor lost', async () => {
        const board = stubBoard([gatedJob(1)]);
        const { stack, gates } = stubGateStack();
        let claim: GateClaim | undefined;
        stack.server.register = (_token, registered) => {
            claim = registered;
        };
        const runner = stubRunner(async () => {
            claim?.onInfraLoss?.('the task supervisor running the gate was lost');
            return ok();
        });
        await drive({ ...board, runner, gates });
        expect(stack.ran.names).toEqual([]);
        interruptedOnly(board);
    });
});

// Issue #925: the supervisor lost while the end-of-run publish ran is the attempt's loss, never a failed publish.
describe('a lost supervisor under the end-of-run publish', () => {
    it('interrupts the attempt instead of failing it, and reports no verdict', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        runner.publishGit = async () => {
            throw new StepChannelClosed('its step was answered: the task group ended or was taken away');
        };
        await drive({ ...board, runner });
        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([
            { id: job(1).id, reason: expect.stringContaining('infrastructure loss'), release: true },
        ]);
    });

    it('still fails an attempt whose publish threw for any other reason', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        runner.publishGit = async () => {
            throw new Error('git exploded');
        };
        await drive({ ...board, runner });
        expect(board.board.interrupted).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
    });
});

// Issue #773 (D6): the gate container is sized for verify before the setup and the declared gates;
// a resize is best-effort and never what decides whether they run.
describe('the gate container resize around the setup and the gates', () => {
    it('asks for the verify size before the setup and again before the declared gates', async () => {
        const board = stubBoard([{ ...gatedJob(1), gates: { ...gatedJob(1).gates!, setup: 'npm ci' } }]);
        const { stack, gates } = stubGateStack({}, { setup: { exitCode: 0, output: '' } });
        const order: string[] = [];
        const runner = stubRunner(async () => {
            order.push('run');
            return ok();
        });
        const resize = runner.resizeGate.bind(runner);
        runner.resizeGate = async (resizedJob, phase) => {
            order.push(`resize ${phase}`);
            return resize(resizedJob, phase);
        };
        const runSetup = stack.manager.runSetup.bind(stack.manager);
        stack.manager.runSetup = async (key, setupOptions) => {
            order.push('setup');
            return runSetup(key, setupOptions);
        };
        const runGate = stack.manager.runGate.bind(stack.manager);
        stack.manager.runGate = async (key, name, command, gateOptions) => {
            order.push(`gate ${name}`);
            return runGate(key, name, command, gateOptions);
        };
        await drive({ ...board, runner, gates });
        expect(order).toEqual(['resize verify', 'setup', 'run', 'resize verify', 'gate test', 'gate lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it.each([
        ['refused', async () => false],
        ['rejected', async () => Promise.reject(new Error('the API server is unreachable'))],
    ])('runs the gates whatever a %s resize answered', async (_how, answer) => {
        const board = stubBoard([gatedJob(1)]);
        const { stack, gates } = stubGateStack();
        const runner = stubRunner(async () => ok());
        runner.resizeGate = answer;
        await drive({ ...board, runner, gates });
        expect(stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });
});
