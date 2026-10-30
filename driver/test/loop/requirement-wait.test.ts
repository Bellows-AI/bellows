import { describe, expect, it } from 'vitest';
import type { RequirementVerdict } from '../../src/board/board.js';
import { serveConnection } from '../../src/connection-control.js';
import type { ControlEntry } from '../../src/question-control.js';
import type { HelperPlan } from '../../src/helpers.js';
import type { PublishResult } from '../../src/publish/publish.js';
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
 * A runtime connection requirement through the real loop and the real connection route: the agent's
 * helper asks for a connection its task lacks, the board records the requirement, the driver stops the agent
 * itself and hands the attempt back as a requirement wait — released, outside the interruption budget, never a
 * failed or blocked verdict — so the board holds the row until the user binds or dismisses.
 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const until = async (condition: () => boolean) => {
    for (let i = 0; i < 2_000 && !condition(); i++) await tick();
    expect(condition()).toBe(true);
};
const ask = (control: ControlEntry, provider = 'jira', target?: string) =>
    serveConnection(control.connecting, JSON.stringify({ provider, ...(target === undefined ? {} : { target }) }));
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
const postPlan: HelperPlan = { helperId: 'noop', phase: 'post', input: null, githubWriting: false };

async function driveRun(
    body: (ctx: {
        control: ControlEntry;
        board: BoardStub;
        stack: ReturnType<typeof stubGateStack>['stack'];
        runner: ReturnType<typeof stubRunner>;
    }) => Promise<ReturnType<typeof ok>>,
    options: {
        board?: Parameters<typeof stubBoard>[1];
        job?: Parameters<typeof stubBoard>[0][number];
        runner?: Parameters<typeof stubRunner>[1];
        stopGraceMs?: number;
        tune?: (board: BoardStub) => void;
    } = {}
) {
    const board = stubBoard([options.job ?? job(1)], options.board);
    options.tune?.(board.board);
    const { stack, gates } = stubGateStack({}, { control: true, polled: true });
    const runner: ReturnType<typeof stubRunner> = stubRunner(async (running) => {
        const control = stack.controls.get(running.supervisorEnv?.SUPERVISOR_AGENT_TOKEN ?? '');
        if (!control) throw new Error('no control entry');
        return body({ control, board: board.board, stack, runner });
    }, options.runner);
    const loop = createLoop({
        board: board.board,
        runner,
        config: config(),
        gates,
        sleep,
        ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
    });
    board.attach(loop);
    await loop.start();
    return { board: board.board, runner, stack };
}

describe('a runtime connection requirement', () => {
    it('carries what the helper needs (a site) from the ask to the board', async () => {
        const { board } = await driveRun(async ({ control, stack }) => {
            await ask(control, 'jira', 'b.example.net');
            await until(() => stack.stopsRaised.length > 0);
            return ok();
        });
        expect(board.connectionAsks).toEqual([{ id: job(1).id, provider: 'jira', target: 'b.example.net' }]);
    });

    it('a helper refusal ends the run as a requirement wait, not failed or blocked', async () => {
        let answer: Awaited<ReturnType<typeof ask>> | undefined;
        const { board, runner, stack } = await driveRun(async ({ control, stack }) => {
            answer = await ask(control);
            // The helper exits 3 with its guidance; the agent finishes its step and the Stop ends it.
            await until(() => stack.stopsRaised.length > 0);
            return ok();
        });

        expect(answer).toEqual({ status: 200, body: { answer: 'waiting' } });
        expect(board.connectionAsks).toEqual([{ id: job(1).id, provider: 'jira' }]);
        expect(board.interrupted).toEqual([
            { id: job(1).id, reason: expect.stringContaining('jira'), release: true, requirement: true },
        ]);
        expect(board.interrupted[0]).not.toHaveProperty('blocked');
        expect(board.completed).toEqual([]);
        expect(board.suspended).toEqual([]);
        // A cooperative stop on the attempt's own control token: the agent is never killed.
        expect(stack.stopsRaised).toEqual(stack.controlOpened);
        expect(runner.killed).toEqual([]);
    });

    it('raises the control Stop and runs no gate, post-helper, publish or completion', async () => {
        const gated = { ...job(1), repo: 'Bellows-AI/factory', helperPlans: [postPlan] };
        const { board, runner } = await driveRun(
            async ({ control, stack }) => {
                await ask(control);
                await until(() => stack.stopsRaised.length > 0);
                return ok();
            },
            { job: gated, runner: { publish: landed } }
        );

        expect(board.interrupted).toHaveLength(1);
        expect(runner.published).toEqual([]);
        expect(board.completed).toEqual([]);
    });

    it('releases the fence and closes the control once for the hand-back', async () => {
        const { board, stack } = await driveRun(async ({ control, stack }) => {
            await ask(control);
            await until(() => stack.stopsRaised.length > 0);
            return ok();
        });

        expect(board.interrupted).toHaveLength(1);
        expect(stack.controlClosed).toEqual(stack.controlOpened);
    });

    it.each(['bound', 'unavailable'] as const)(
        'a %s answer changes nothing: the run goes on to its verdict',
        async (verdict) => {
            let answer: Awaited<ReturnType<typeof ask>> | undefined;
            const { board, stack } = await driveRun(
                async ({ control }) => {
                    answer = await ask(control);
                    return ok();
                },
                { board: { connectionVerdict: verdict } }
            );

            expect(answer).toEqual({ status: 200, body: { answer: verdict } });
            expect(stack.stopsRaised).toEqual([]);
            expect(board.interrupted).toEqual([]);
            expect(board.completed).toHaveLength(1);
        }
    );

    it('the heartbeat flag alone, on an adopter, stops the running agent and hands back the same way', async () => {
        let flagged = false;
        const { board, runner, stack } = await driveRun(
            async ({ stack }) => {
                flagged = true;
                await until(() => stack.stopsRaised.length > 0);
                return ok();
            },
            {
                tune: (stub) => {
                    stub.heartbeat = async () => ({
                        result: 'held',
                        cancelRequested: false,
                        ...(flagged ? { requirementWait: true } : {}),
                    });
                },
            }
        );

        expect(board.connectionAsks).toEqual([]);
        expect(board.interrupted).toEqual([
            { id: job(1).id, reason: expect.any(String), release: true, requirement: true },
        ]);
        expect(board.completed).toEqual([]);
        expect(board.suspended).toEqual([]);
        expect(stack.stopsRaised).toEqual(stack.controlOpened);
        expect(runner.killed).toEqual([]);
    });

    it('a flag that lands before the agent runs stands the attempt down without launching it', async () => {
        let launched = false;
        const { board } = await driveRun(
            async () => {
                launched = true;
                return ok();
            },
            { board: { requirementWait: true } }
        );

        expect(launched).toBe(false);
        expect(board.interrupted).toEqual([
            { id: job(1).id, reason: expect.any(String), release: true, requirement: true },
        ]);
        expect(board.completed).toEqual([]);
    });

    it('force-kills an agent that has not stopped when the grace passes, and still hands back the requirement', async () => {
        const { board, runner } = await driveRun(
            async ({ control, runner }) => {
                await ask(control);
                await until(() => runner.killed.length > 0);
                return ok({ exitCode: 137 });
            },
            { stopGraceMs: 30 }
        );

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.interrupted).toEqual([
            { id: job(1).id, reason: expect.stringContaining('jira'), release: true, requirement: true },
        ]);
        expect(board.suspended).toEqual([]);
        expect(board.completed).toEqual([]);
    });

    it.each(['lost', 'removed'] as const satisfies RequirementVerdict[])(
        'a %s answer from the board is the end of the attempt, not a wait',
        async (verdict) => {
            let answer: Awaited<ReturnType<typeof ask>> | undefined;
            const { board, stack } = await driveRun(
                async ({ control }) => {
                    answer = await ask(control);
                    return ok();
                },
                { board: { connectionVerdict: verdict } }
            );

            expect(answer?.status).toBe(409);
            expect(stack.stopsRaised).toEqual([]);
            expect(board.interrupted).toEqual([]);
        }
    );

    it('a provider the board refuses is a 400 and no wait', async () => {
        let answer: Awaited<ReturnType<typeof ask>> | undefined;
        const { board, stack } = await driveRun(
            async ({ control }) => {
                answer = await ask(control, 'nope');
                return ok();
            },
            { board: { connectionVerdict: 'refused' } }
        );

        expect(answer?.status).toBe(400);
        expect(stack.stopsRaised).toEqual([]);
        expect(board.interrupted).toEqual([]);
    });

    it('a board that cannot be reached is a 502 the helper retries, never a verdict', async () => {
        let answer: Awaited<ReturnType<typeof ask>> | undefined;
        const { board, stack } = await driveRun(
            async ({ control }) => {
                answer = await ask(control);
                return ok();
            },
            {
                board: {
                    connectionVerdict: async () => {
                        throw new Error('board unreachable');
                    },
                },
            }
        );

        expect(answer?.status).toBe(502);
        expect(board.connectionAsks.length).toBeGreaterThan(1);
        expect(stack.stopsRaised).toEqual([]);
        expect(board.interrupted).toEqual([]);
    });

    it('rejects a body that names no provider, and a route with no relay attached', async () => {
        await driveRun(async ({ control }) => {
            expect((await serveConnection(control.connecting, '{}')).status).toBe(400);
            expect((await serveConnection(control.connecting, 'not json')).status).toBe(400);
            expect(
                (await serveConnection(control.connecting, JSON.stringify({ provider: 'x'.repeat(65) }))).status
            ).toBe(400);
            expect((await serveConnection({ relay: null }, JSON.stringify({ provider: 'jira' }))).status).toBe(503);
            return ok();
        });
    });

    it('an interrupt that does not land leaves the attempt to the lease, never a failed verdict', async () => {
        const { board } = await driveRun(
            async ({ control, stack }) => {
                await ask(control);
                await until(() => stack.stopsRaised.length > 0);
                return ok();
            },
            {
                tune: (stub) => {
                    stub.interrupt = async () => {
                        throw new Error('board unreachable');
                    };
                },
            }
        );

        expect(board.completed).toEqual([]);
        expect(board.suspended).toEqual([]);
    });
});
