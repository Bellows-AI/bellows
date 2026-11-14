import { describe, expect, it } from 'vitest';
import type { HeartbeatVerdict } from '../../src/board/board.js';
import { createLoop } from '../../src/loop/loop.js';
import {
    config,
    job,
    ok,
    sleep,
    stubBoard,
    stubGateStack,
    stubRunner,
    type BoardStub,
} from '../fixtures/loop-stubs.js';

/**
 * An organization suspended while its task runs, through the real loop: the heartbeat answers
 * `release: 'org-suspended'`, the driver stops the agent on its control endpoint and hands the attempt back
 * flagged `orgSuspended` — released, after the session report, never a verdict, a park or a node loss — and
 * leaves the checkout to the next claim (no kill). The loop is shared by both executors, so each `EXECUTOR`
 * runs the same cases.
 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const until = async (condition: () => boolean) => {
    for (let i = 0; i < 2_000 && !condition(); i++) await tick();
    expect(condition()).toBe(true);
};

const EXECUTORS = [
    ['docker', {}],
    ['kubernetes', { EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory', RUNNER_SERVICES: '0' }],
] as const;

const SUSPENDED: HeartbeatVerdict = { result: 'held', cancelRequested: false, release: 'org-suspended' };
const HELD: HeartbeatVerdict = { result: 'held', cancelRequested: false };

describe.each(EXECUTORS)('an organization suspended mid-run on the %s executor', (_executor, env) => {
    async function driveRun(
        body: (ctx: { stack: ReturnType<typeof stubGateStack>['stack']; suspend: () => void }) => Promise<void>,
        heartbeat?: (suspended: boolean) => Promise<HeartbeatVerdict>
    ) {
        const board = stubBoard([job(1)]);
        let suspended = false;
        board.board.heartbeat = heartbeat
            ? () => heartbeat(suspended)
            : async () => {
                  (board.board as BoardStub).beats += 1;
                  return suspended ? SUSPENDED : HELD;
              };
        const { stack, gates } = stubGateStack({}, { control: true, polled: true });
        let launched = false;
        const runner = stubRunner(async () => {
            launched = true;
            await body({
                stack,
                suspend: () => {
                    suspended = true;
                },
            });
            return ok();
        });
        const loop = createLoop({ board: board.board, runner, config: config(env), gates, sleep });
        board.attach(loop);
        await loop.start();
        return { board: board.board, runner, stack, launched: () => launched };
    }

    it('stops the agent cooperatively and hands the attempt back as an org-suspended interruption', async () => {
        const { board, runner, stack } = await driveRun(async ({ stack, suspend }) => {
            suspend();
            await until(() => stack.stopsRaised.length > 0);
        });

        expect(board.interrupted).toEqual([
            { id: job(1).id, reason: 'the organization is suspended', release: true, orgSuspended: true },
        ]);
        expect(board.interrupted[0]).not.toHaveProperty('nodeLoss');
        expect(board.interrupted[0]).not.toHaveProperty('requirement');
        expect(board.completed).toEqual([]);
        expect(board.suspended).toEqual([]);
        // The session is reported before the hand-back, so the next claim resumes it.
        expect(board.sessions.map((s) => s.id)).toContain(job(1).id);
        // A cooperative stop on the attempt's own control token: the runner, and its checkout, are never killed.
        expect(stack.stopsRaised).toEqual(stack.controlOpened);
        expect(runner.killed).toEqual([]);
    });

    it('stands an attempt down before its launch when the suspension is already in force', async () => {
        const { board, launched } = await driveRun(
            async () => {},
            async () => SUSPENDED
        );
        expect(launched()).toBe(false);
        expect(board.interrupted).toEqual([
            { id: job(1).id, reason: 'the organization is suspended', release: true, orgSuspended: true },
        ]);
        expect(board.completed).toEqual([]);
    });

    it('reads no suspension into a heartbeat it could not get: the run goes on to its verdict', async () => {
        const { board, stack } = await driveRun(
            async () => {
                await sleep();
            },
            async () => {
                throw new Error('board unreachable');
            }
        );
        expect(stack.stopsRaised).toEqual([]);
        expect(board.interrupted).toEqual([]);
        expect(board.completed).toHaveLength(1);
    });
});
