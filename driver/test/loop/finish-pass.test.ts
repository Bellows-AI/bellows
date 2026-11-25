import { describe, expect, it } from 'vitest';
import type { BoardJob, HeartbeatVerdict } from '../../src/board/board.js';
import type { FinishAnswer } from '../../src/control-channel.js';
import type { DeadService } from '../../src/runner.js';
import { StepChannelClosed } from '../../src/step-control.js';
import { SUPERVISOR_ENV } from '../../src/supervisor-contract.js';
import { SAME_TREE } from '../fixtures/gate-runs.js';
import {
    type BoardLedger,
    boardLedger,
    drive,
    gatedJob,
    ok,
    stubBoard,
    stubGateStack,
    stubRunner,
} from '../fixtures/loop-stubs.js';

/**
 * The finish pass: the agent's stop asks `POST /gate/finish`, and the driver runs the declared gates
 * inside the run with the close-time pass's own body — reuse, dead-service restart, records — under the
 * round cap frozen on the root. The stub runner's `run` plays the agent: it asks the relay the loop attached.
 * Both executors share the loop: the two `EXECUTOR` values pin that parity.
 *
 * The case marked GUARD passes before the change too: an agent that never asks is gated at close.
 */

const EXECUTORS = [
    ['docker', {}],
    ['kubernetes', { EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory', RUNNER_SERVICES: '0' }],
] as const;

const claimedJob = (over: Partial<BoardJob> = {}): BoardJob => ({ ...gatedJob(1), finishRounds: 3, ...over });

/** One stop's ask; `requestId` is the id the helper sends on every retry of that stop. */
type Ask = (requestId?: string) => Promise<FinishAnswer>;

interface AgentView {
    ask: Ask;
    ran: () => string[];
    /** The runtime budget pauses asked so far: true paused, false resumed. */
    paused: () => boolean[];
    board: ReturnType<typeof stubBoard>['board'];
    stack: ReturnType<typeof stubGateStack>['stack'];
    claimed: BoardJob;
}

interface Scene {
    job?: BoardJob;
    /** Further claims handed out after the first: a takeover's. */
    more?: BoardJob[];
    outcomes?: Record<string, number | number[]>;
    board?: Parameters<typeof stubBoard>[1];
    stack?: Parameters<typeof stubGateStack>[1];
    runner?: Parameters<typeof stubRunner>[1];
    ledger?: BoardLedger;
    /** The agent: asks as often as it likes. Absent asks never. */
    agent?: (view: AgentView) => Promise<void>;
    heartbeat?: (claimed: BoardJob) => HeartbeatVerdict | 'lost';
    env?: Record<string, string>;
}

const RUNS_PER_GATE = (names: string[], gate: string) => names.filter((name) => name === gate).length;

describe.each(EXECUTORS)('the finish pass on the %s executor', (_executor, env) => {
    async function run(scene: Scene = {}) {
        const claimed = scene.job ?? claimedJob();
        const ledger = scene.ledger ?? boardLedger();
        const board = stubBoard([claimed, ...(scene.more ?? [])], { ledger, ...scene.board });
        if (scene.heartbeat) {
            const beat = scene.heartbeat;
            board.board.heartbeat = async (beaten: BoardJob) => {
                board.board.beats += 1;
                return beat(beaten);
            };
        }
        const { stack, gates } = stubGateStack(scene.outcomes ?? {}, { control: true, measure: true, ...scene.stack });
        const answers: FinishAnswer[] = [];
        const runner: ReturnType<typeof stubRunner> = stubRunner(
            async (running) => {
                const ask: Ask = async (requestId) => {
                    const relay = stack.finishRelays.get(running.supervisorEnv?.[SUPERVISOR_ENV.controlToken] ?? '');
                    if (!relay) throw new Error('no finish relay attached');
                    const answer = await relay(requestId);
                    answers.push(answer);
                    return answer;
                };
                await scene.agent?.({
                    ask,
                    ran: () => [...stack.ran.names],
                    paused: () => runner.paused.map(({ paused }) => paused),
                    board: board.board,
                    stack,
                    claimed: running,
                });
                return ok();
            },
            {
                sync: { ok: true, reason: null, fingerprint: 'h:before' },
                probeTree: SAME_TREE,
                gateTree: () => ({ fingerprint: SAME_TREE, content: SAME_TREE, mutatedSince: false }),
                ...scene.runner,
            }
        );
        await drive({ ...board, runner, gates }, { ...env, ...scene.env });
        return { board: board.board, stack, runner, answers, ledger };
    }

    const verdicts = (answers: FinishAnswer[]) => answers.map((answer) => answer.verdict);
    const lastReports = (r: Awaited<ReturnType<typeof run>>) => r.board.gatesReported.at(-1)!.results;

    it('hands the agent the failed tests of the red gate, and reports the structured result to the board', async () => {
        const result = {
            failures: [{ file: 'a.test.ts', test: 'adds two numbers', message: 'expected 3 to be 4' }],
            selection: { mode: 'all', reason: 'a shared file changed' },
        };
        const r = await run({
            outcomes: { test: [1, 0] },
            stack: { results: { test: result } },
            agent: async ({ ask }) => {
                await ask();
            },
        });

        const failed = r.answers[0] as Extract<FinishAnswer, { verdict: 'fail' }>;
        expect(failed.message).toContain('Failed tests (1):');
        expect(failed.message).toContain('a.test.ts > adds two numbers: expected 3 to be 4');
        expect(failed.message).toContain('Selection: all, a shared file changed');
        expect(lastReports(r).find((gate) => gate.name === 'test')?.result).toEqual(result);
    });

    it('red, red, green ends in one run', async () => {
        const r = await run({
            outcomes: { test: [1, 1, 0] },
            agent: async ({ ask }) => {
                await ask();
                await ask();
                await ask();
            },
        });

        expect(verdicts(r.answers)).toEqual(['fail', 'fail', 'pass']);
        expect(r.answers[0]).toMatchObject({ verdict: 'fail', gate: 'test', exitCode: 1, round: 1, limit: 3 });
        expect(r.answers[1]).toMatchObject({ round: 2, limit: 3 });
        const failed = r.answers[0] as Extract<FinishAnswer, { verdict: 'fail' }>;
        expect(failed.output).toContain('test failed badly');
        expect(failed.message).toContain('"test"');
        expect(failed.message).toContain('round 1 of 3');
        expect(r.board.finishPassesWritten.map((round) => [round.verdict, round.gate])).toEqual([
            ['failed', 'test'],
            ['failed', 'test'],
            ['passed', null],
        ]);
        expect(r.board.finishPassesWritten.every((round) => round.runClaimSeq === r.board.completed.length)).toBe(true);
        // One run: the gates ran three times inside it, never again at close.
        expect(r.stack.ran.names).toEqual(['test', 'test', 'test', 'lint']);
        expect(r.board.completed).toHaveLength(1);
        expect(r.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(lastReports(r).every((gate) => 'reused' in gate)).toBe(true);
        expect(r.board.gateRunsWritten.every((row) => row.source === 'finish')).toBe(true);
    });

    it('a workflow-mode claim gates its finish the same way', async () => {
        const r = await run({
            job: claimedJob({ publish: false }),
            outcomes: { test: [1, 0] },
            agent: async ({ ask }) => {
                await ask();
                await ask();
            },
        });

        expect(verdicts(r.answers)).toEqual(['fail', 'pass']);
        expect(r.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('cap reached allows the stop and the verdict fails', async () => {
        const r = await run({
            job: claimedJob({ finishRounds: 1 }),
            outcomes: { test: 1 },
            agent: async ({ ask }) => {
                await ask();
                await ask();
            },
        });

        expect(r.answers).toEqual([
            expect.objectContaining({ verdict: 'fail', round: 1, limit: 1 }),
            { verdict: 'cap', rounds: 1, limit: 1 },
        ]);
        // The cap ran nothing; the close-time pass ran the gate again and judged the run.
        expect(r.stack.ran.names).toEqual(['test', 'test']);
        expect(r.board.finishPassesWritten).toHaveLength(1);
        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
        expect(r.runner.publishOptions).toEqual([
            { draft: true, recordPrOperation: expect.any(Function), pullRequests: expect.any(Function) },
        ]);
    });

    it('an on_demand gate never runs in the finish pass', async () => {
        let ranInRun: string[] = [];
        const r = await run({
            job: claimedJob({
                gates: {
                    image: 'node:24',
                    gates: [
                        { name: 'test', command: 'npm test' },
                        { name: 'e2e', command: 'npm run e2e', onDemand: true },
                        { name: 'lint', command: 'npm run lint' },
                    ],
                },
            }),
            agent: async ({ ask, ran }) => {
                await ask();
                ranInRun = ran();
            },
        });

        expect(verdicts(r.answers)).toEqual(['pass']);
        expect(ranInRun).toEqual(['test', 'lint']);
        expect(r.stack.ran.names).not.toContain('e2e');
    });

    it('cap 0 never runs a gate in the run', async () => {
        let ranInRun: string[] = [];
        const r = await run({
            job: claimedJob({ finishRounds: 0 }),
            agent: async ({ ask, ran }) => {
                await ask();
                ranInRun = ran();
            },
        });

        expect(r.answers).toEqual([{ verdict: 'cap', rounds: 0, limit: 0 }]);
        expect(ranInRun).toEqual([]);
        expect(r.stack.ran.names).toEqual(['test', 'lint']);
        expect(r.board.finishPassesWritten).toEqual([]);
    });

    it('a claim without finishRounds answers unavailable, never cap', async () => {
        let ranInRun: string[] = [];
        const { finishRounds: _absent, ...withoutCap } = claimedJob();
        const r = await run({
            job: withoutCap,
            agent: async ({ ask, ran }) => {
                await ask();
                ranInRun = ran();
            },
        });

        expect(verdicts(r.answers)).toEqual(['unavailable']);
        expect(ranInRun).toEqual([]);
        expect(r.board.finishRoundReads).toBe(0);
        expect(r.stack.ran.names).toEqual(['test', 'lint']);
    });

    it('GUARD hook fails open: the close-time verifier runs the gates', async () => {
        const r = await run({ outcomes: { test: 1 } });

        expect(r.stack.ran.names).toEqual(['test']);
        expect(r.board.finishPassesWritten).toEqual([]);
        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'gate' });
    });

    it('covering record: close-time reports reused and starts nothing', async () => {
        const r = await run({ agent: async ({ ask }) => void (await ask()) });

        expect(verdicts(r.answers)).toEqual(['pass']);
        expect(r.stack.ran.names).toEqual(['test', 'lint']);
        expect(new Set(r.board.gateRunsWritten.map((row) => row.source))).toEqual(new Set(['finish']));
        expect(lastReports(r).map((gate) => [gate.name, gate.status, 'reused' in gate])).toEqual([
            ['test', 'passed', true],
            ['lint', 'passed', true],
        ]);
        expect(r.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('takeover mid-pass keeps the counter and the records', async () => {
        const first = claimedJob({ finishRounds: 2 });
        const second: BoardJob = {
            ...first,
            claimSeq: 2,
            leaseToken: '22222222-2222-4222-8222-222222222222',
        };
        let lose = false;
        let asks = 0;
        let secondReads = 0;
        const r = await run({
            job: first,
            more: [second],
            // One claim at a time: the second is the takeover of the first, never beside it.
            env: { DRIVER_CONCURRENCY: '1' },
            outcomes: { test: 1 },
            heartbeat: (beaten) =>
                beaten.claimSeq === 1 && lose ? 'lost' : { result: 'held', cancelRequested: false },
            stack: {
                // The first claim's second pass: the lease goes while the gate runs, and the gate is cancelled.
                hold: async (_name, signal) => {
                    if (asks !== 2) return;
                    lose = true;
                    await new Promise<void>((resolve) => {
                        if (signal?.aborted) return resolve();
                        signal?.addEventListener('abort', () => resolve(), { once: true });
                    });
                },
            },
            agent: async ({ ask, claimed, board }) => {
                if (claimed.claimSeq === 1) {
                    asks = 1;
                    await ask();
                    asks = 2;
                    await ask();
                    return;
                }
                const reads = board.finishRoundReads;
                asks = 3;
                await ask();
                secondReads = board.finishRoundReads - reads;
                await ask();
            },
        });

        // First claim: one failed round, then a pass cut short — no round for it, an incomplete gate row.
        expect(r.answers.map((answer) => answer.verdict)).toEqual(['fail', 'skip', 'fail', 'cap']);
        expect(r.answers[2]).toMatchObject({ round: 2, limit: 2 });
        expect(secondReads).toBe(1);
        expect(r.ledger.finishPasses.map((round) => [round.verdict, round.runClaimSeq])).toEqual([
            ['failed', 1],
            ['failed', 2],
        ]);
        const testRows = r.ledger.gateRuns.filter((row) => row.gate === 'test' && row.outcome !== 'running');
        expect(testRows.map((row) => [row.outcome, row.claimSeq])).toEqual([
            ['failed', 1],
            ['incomplete', 1],
            ['failed', 2],
            ['failed', 2],
        ]);
        // The second claim reran the gate: the latest row was incomplete, never reusable.
        expect(RUNS_PER_GATE(r.stack.ran.names, 'test')).toBe(4);
    });

    it('budget: a slow gate does not spend the runtime', async () => {
        let paused: () => boolean[] = () => [];
        let pausedDuringGate: boolean[] = [];
        let pausedAfter: boolean[] = [];
        const r = await run({
            stack: {
                hold: async (name) => {
                    if (name !== 'test') return;
                    pausedDuringGate = paused();
                    await new Promise((resolve) => setTimeout(resolve, 30));
                },
            },
            agent: async (view) => {
                ({ paused } = view);
                await view.ask();
                pausedAfter = paused();
            },
        });

        expect(verdicts(r.answers)).toEqual(['pass']);
        expect(pausedDuringGate).toEqual([true]);
        expect(pausedAfter).toEqual([true, false]);
    });

    it('a stop raised while the agent asks answers skip and runs nothing', async () => {
        let stop = false;
        let ranInRun: string[] = [];
        const r = await run({
            heartbeat: () => ({ result: 'held', cancelRequested: stop }),
            agent: async ({ ask, ran, stack }) => {
                stop = true;
                for (let i = 0; i < 2_000 && stack.stopsRaised.length === 0; i++) await tick();
                await ask();
                ranInRun = ran();
            },
        });

        expect(r.answers).toEqual([{ verdict: 'skip', reason: expect.any(String) }]);
        expect(ranInRun).toEqual([]);
        expect(r.board.finishPassesWritten).toEqual([]);
    });

    it('unconfirmed round read answers unavailable and runs nothing', async () => {
        let ranInRun: string[] = [];
        const r = await run({
            board: { finishRounds: 'unreadable' },
            agent: async ({ ask, ran }) => {
                await ask();
                ranInRun = ran();
            },
        });

        expect(verdicts(r.answers)).toEqual(['unavailable']);
        expect(ranInRun).toEqual([]);
        expect(r.board.finishPassesWritten).toEqual([]);
    });

    it('unconfirmed round write after a red answers unavailable', async () => {
        const r = await run({
            board: { finishPassWrite: 'rejected' },
            outcomes: { test: 1 },
            agent: async ({ ask }) => void (await ask()),
        });

        expect(verdicts(r.answers)).toEqual(['unavailable']);
        expect(r.board.finishPassesWritten).toHaveLength(1);
    });

    it('a change after a green pass re-arms it', async () => {
        let tree = SAME_TREE;
        let ranAfterFirst: string[] = [];
        const r = await run({
            runner: {
                sync: { ok: true, reason: null, fingerprint: 'h:before' },
                probeTree: () => tree,
                gateTree: () => ({ fingerprint: tree, content: tree, mutatedSince: false }),
            },
            agent: async ({ ask, ran }) => {
                await ask();
                ranAfterFirst = ran();
                tree = 'h:edited';
                await ask();
            },
        });

        expect(verdicts(r.answers)).toEqual(['pass', 'pass']);
        expect(ranAfterFirst).toEqual(['test', 'lint']);
        expect(r.stack.ran.names).toEqual(['test', 'lint', 'test', 'lint']);
    });

    it('no change from base answers skip', async () => {
        const r = await run({
            runner: { noChange: true },
            agent: async ({ ask }) => void (await ask()),
        });

        expect(r.answers).toEqual([{ verdict: 'skip', reason: expect.stringContaining('no change') }]);
        expect(r.stack.ran.names).toEqual([]);
        expect(r.board.finishPassesWritten).toEqual([]);
    });

    it('dead service that will not restart answers unavailable', async () => {
        const mongo: DeadService = {
            name: 'test-mongo',
            image: 'mongo:8.0.11',
            state: 'failed',
            exitCode: 1,
            reason: 'Error',
            logTail: 'gone',
        };
        let ranInRun: string[] = [];
        const r = await run({
            runner: {
                deadServices: async () => [mongo],
                restartServices: async () => {
                    throw new Error('service "test-mongo" is not running after 300s');
                },
            },
            agent: async ({ ask, ran }) => {
                await ask();
                ranInRun = ran();
            },
        });

        expect(verdicts(r.answers)).toEqual(['unavailable']);
        expect(ranInRun).toEqual([]);
        expect(r.board.finishPassesWritten).toEqual([]);
    });

    it('ad-hoc admission is reopened on every exit', async () => {
        let throwing = false;
        const r = await run({
            outcomes: { test: 1 },
            stack: {
                hold: async () => {
                    if (throwing) throw new StepChannelClosed('the gate answered');
                },
            },
            agent: async ({ ask }) => {
                await ask();
                throwing = true;
                await ask();
            },
        });

        expect(verdicts(r.answers)).toEqual(['fail', 'unavailable']);
        expect(r.stack.reopened).toHaveLength(2);
        expect(r.runner.resized.filter((phase) => phase === 'idle').length).toBeGreaterThanOrEqual(2);
        // The lost supervisor is the attempt's loss: interrupted, never a verdict.
        expect(r.board.completed).toEqual([]);
    });

    // ---- a retried request: the answer was lost on its way to the agent ----------------------
    const STOP_A = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const STOP_B = '16fd2706-8baf-433b-82eb-8c7fada847da';

    it('a retried request replays its round: the same id answers fail again, a new id answers cap', async () => {
        let ranInRun: string[] = [];
        const r = await run({
            job: claimedJob({ finishRounds: 1 }),
            outcomes: { test: 1 },
            agent: async ({ ask, ran }) => {
                // The first answer never reaches the agent: its helper asks again under the same id.
                await ask(STOP_A);
                await ask(STOP_A);
                ranInRun = ran();
                await ask(STOP_B);
            },
        });

        expect(r.answers[1]).toMatchObject({ verdict: 'fail', gate: 'test', round: 1, limit: 1 });
        const replayed = r.answers[1] as Extract<FinishAnswer, { verdict: 'fail' }>;
        expect(replayed.output).toContain('test failed badly');
        expect(replayed.message).toContain('round 1 of 1');
        expect(r.answers[2]).toEqual({ verdict: 'cap', rounds: 1, limit: 1 });
        expect(r.ledger.finishPasses.map((round) => [round.passId, round.verdict])).toEqual([[STOP_A, 'failed']]);
        expect(r.board.finishRoundReadIds.slice(0, 3)).toEqual([STOP_A, STOP_A, STOP_B]);
        // The replay reran the red gate for its output; the new stop ran nothing.
        expect(ranInRun).toEqual(['test', 'test']);
    });

    it('a request id recorded passed answers pass and runs nothing', async () => {
        let ranInRun: string[] = [];
        const ledger = boardLedger();
        ledger.finishPasses.push({ passId: STOP_A, runClaimSeq: 1, verdict: 'passed', gate: null });
        const r = await run({
            ledger,
            outcomes: { test: 1 },
            agent: async ({ ask, ran }) => {
                await ask(STOP_A);
                ranInRun = ran();
            },
        });

        expect(r.answers).toEqual([{ verdict: 'pass' }]);
        expect(ranInRun).toEqual([]);
        expect(r.ledger.finishPasses).toHaveLength(1);
    });

    it('a retry across a takeover replays the round the first holder spent', async () => {
        const first = claimedJob({ finishRounds: 1 });
        const second: BoardJob = { ...first, claimSeq: 2, leaseToken: '22222222-2222-4222-8222-222222222222' };
        let lose = false;
        const r = await run({
            job: first,
            more: [second],
            env: { DRIVER_CONCURRENCY: '1' },
            outcomes: { test: 1 },
            heartbeat: (beaten) =>
                beaten.claimSeq === 1 && lose ? 'lost' : { result: 'held', cancelRequested: false },
            agent: async ({ ask, claimed }) => {
                if (claimed.claimSeq === 1) {
                    await ask(STOP_A);
                    // The holder is lost before its answer reached the agent.
                    lose = true;
                    for (let i = 0; i < 200; i++) await tick();
                    return;
                }
                await ask(STOP_A);
                await ask(STOP_B);
            },
        });

        expect(r.answers.map((answer) => answer.verdict)).toEqual(['fail', 'fail', 'cap']);
        expect(r.answers[1]).toMatchObject({ round: 1, limit: 1 });
        expect(r.ledger.finishPasses.map((round) => [round.passId, round.verdict, round.runClaimSeq])).toEqual([
            [STOP_A, 'failed', 1],
        ]);
    });

    it('an unconfirmed read of a request id answers unavailable, runs nothing and writes nothing', async () => {
        let ranInRun: string[] = [];
        const r = await run({
            board: { finishRounds: 'unreadable' },
            agent: async ({ ask, ran }) => {
                await ask(STOP_A);
                ranInRun = ran();
            },
        });

        expect(verdicts(r.answers)).toEqual(['unavailable']);
        expect(r.board.finishRoundReadIds).toEqual([STOP_A]);
        expect(ranInRun).toEqual([]);
        expect(r.board.finishPassesWritten).toEqual([]);
    });
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
