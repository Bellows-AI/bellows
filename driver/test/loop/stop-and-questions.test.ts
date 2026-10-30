import { describe, expect, it } from 'vitest';
import type { BoardJob, HeartbeatVerdict } from '../../src/board/board.js';
import { BOARD_CALL_ATTEMPTS, BoardHttpError } from '../../src/board/board-retry.js';
import type { RunOutcome, Runner } from '../../src/runner.js';
import { readQuestion, recordQuestion } from '../../src/question-control.js';
import type { ControlEntry } from '../../src/question-control.js';
import type { HelperPlan } from '../../src/helpers.js';
import type { PublishResult } from '../../src/publish/publish.js';
import { createLoop, type Loop } from '../../src/loop/loop.js';
import type { GateStack } from '../../src/loop/loop-types.js';
import { RUN_CONTROL_POLL_MS } from '../../src/loop/loop-attempt.js';
import {
    type BoardStub,
    config,
    drive,
    gatedJob,
    job,
    ok,
    sleep,
    stubBoard,
    stubGateStack,
    stubRunner,
} from '../fixtures/loop-stubs.js';

describe('a stand-down after the gates (issue #427)', () => {
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const ticks = async (n = 30) => {
        for (let i = 0; i < n; i++) await tick();
    };
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

    type Verdict = 'stop' | 'lost' | 'removed';
    /** Arms the board's heartbeat to answer `kind` once `fire()` is called. */
    function armHeartbeat(board: BoardStub, kind: Verdict): () => void {
        let fired = false;
        board.heartbeat = async () => {
            board.beats += 1;
            if (!fired) return { result: 'held', cancelRequested: false };
            return kind === 'stop' ? { result: 'held', cancelRequested: true } : kind;
        };
        return () => {
            fired = true;
        };
    }
    const postPlan: HelperPlan = { helperId: 'noop', phase: 'post', input: null, githubWriting: false };

    it.each(['stop', 'lost', 'removed'] as const)(
        'G1 %s landing during a post-helper publishes nothing and reports no verdict',
        async (kind) => {
            const board = stubBoard([{ ...job(1), repo: 'Bellows-AI/bellows', helperPlans: [postPlan] }]);
            const fire = armHeartbeat(board.board, kind);
            const runner = stubRunner(async () => ok(), { publish: landed });
            runner.runHelper = async () => {
                fire();
                await ticks();
                return { ok: true, output: null };
            };

            await drive({ ...board, runner });

            // The heartbeat DID observe it: a lost lease past the launch leaves the runner, a stop or a removal kills it.
            expect(runner.killed).toEqual(kind === 'lost' ? [] : [job(1).id]);
            expect(runner.published).toEqual([]);
            expect(board.board.completed).toEqual([]);
            if (kind === 'stop') expect(board.board.suspended).toEqual([job(1).id]);
        }
    );

    it('G2 a stop landing during the publish token ask publishes nothing and parks the run', async () => {
        const board = stubBoard([{ ...job(1), repo: 'Bellows-AI/bellows' }]);
        const fire = armHeartbeat(board.board, 'stop');
        let asks = 0;
        board.board.githubCredential = async () => {
            // The first ask is the sync's; the stop lands during the publish's.
            asks += 1;
            if (asks < 2) return null;
            fire();
            await ticks();
            return null;
        };
        const runner = stubRunner(async () => ok(), { publish: landed });

        await drive({ ...board, runner });

        expect(runner.killed).toEqual([job(1).id]);
        expect(runner.published).toEqual([]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    it('G5 parks a stopped run even when the killed run() rejects', async () => {
        const board = stubBoard([job(1)]);
        const fire = armHeartbeat(board.board, 'stop');
        const runner = stubRunner(async () => {
            fire();
            while (!runner.killed.length) await tick();
            throw new Error('the container vanished under the CLI');
        });

        await drive({ ...board, runner });

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
    });

    it('#488 a lease lost after the run says so and reports nothing', async () => {
        const board = stubBoard([job(1)]);
        const fire = armHeartbeat(board.board, 'lost');
        const runner = stubRunner(async () => {
            fire();
            while (!runner.killed.length) await tick();
            return ok();
        });
        const lines: string[] = [];

        await drive({ ...board, runner, log: (line) => lines.push(line) });

        expect(lines.join('\n')).toContain('the lease was lost during its run, leaving the job to its holder');
        expect(board.board.suspended).toEqual([]);
        expect(board.board.completed).toEqual([]);
    });

    it('#488 a stop after the run reports the session before it parks', async () => {
        const board = stubBoard([job(1)]);
        const fire = armHeartbeat(board.board, 'stop');
        const order: string[] = [];
        const rawSession = board.board.session.bind(board.board);
        board.board.session = async (claimed, sessionId) => {
            order.push(`session:${sessionId}`);
            return rawSession(claimed, sessionId);
        };
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            order.push('suspend');
            return rawSuspend(claimed);
        };
        const runner = stubRunner(async () => {
            fire();
            while (!runner.killed.length) await tick();
            return ok({ sessionId: 'scraped' });
        });

        await drive({ ...board, runner });

        // The run's start is proven by the runner, so its launch is reported (observed) before the scraped session.
        expect(order).toEqual([
            expect.stringMatching(/^session:/),
            expect.stringMatching(/^session:/),
            'session:scraped',
            'suspend',
        ]);
        expect(board.board.completed).toEqual([]);
    });

    it('#488 a lease lost after the push says so, and the push is not reported', async () => {
        // The push itself is not abortable, and a stand-down after it reports nothing: the next
        // holder re-runs the publish. Pinned here as the limit docs/jobs.md states.
        const board = stubBoard([{ ...job(1), repo: 'Bellows-AI/bellows' }]);
        const fire = armHeartbeat(board.board, 'lost');
        const runner = stubRunner(async () => ok(), { publish: landed });
        const rawPublish = runner.publishGit.bind(runner);
        runner.publishGit = async (publishedJob, token) => {
            const answer = await rawPublish(publishedJob, token);
            fire();
            await ticks();
            return answer;
        };
        const lines: string[] = [];

        await drive({ ...board, runner, log: (line) => lines.push(line) });

        expect(runner.published).toHaveLength(1);
        expect(lines.join('\n')).toContain('the lease was lost during its publish');
        expect(board.board.completed).toEqual([]);
    });

    it('#488 names the post-helpers, not the publish, when no publish was due', async () => {
        const board = stubBoard([{ ...job(1), publish: false, helperPlans: [postPlan] }]);
        const fire = armHeartbeat(board.board, 'stop');
        const runner = stubRunner(async () => ok());
        runner.runHelper = async () => {
            fire();
            await ticks();
            return { ok: true, output: null };
        };
        const lines: string[] = [];

        await drive({ ...board, runner, log: (line) => lines.push(line) });

        expect(lines.join('\n')).toContain('stopped during its post-helpers');
        expect(lines.join('\n')).not.toContain('during its publish');
    });
});

describe('a cooperative stop (issue #442)', () => {
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const until = async (condition: () => boolean) => {
        for (let i = 0; i < 2_000 && !condition(); i++) await tick();
        expect(condition()).toBe(true);
    };

    async function driveControlled(
        deps: { board: BoardStub; attach: (loop: Loop) => void; runner: Runner; gates: GateStack },
        options: { stopGraceMs?: number; sleep?: (ms: number) => Promise<void>; env?: NodeJS.ProcessEnv } = {}
    ) {
        const loop = createLoop({
            board: deps.board,
            runner: deps.runner,
            config: config(options.env),
            gates: deps.gates,
            sleep: options.sleep ?? sleep,
            ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }),
        });
        deps.attach(loop);
        await loop.start();
        return loop;
    }

    it('lets the agent exit on its own: one stop on the control endpoint, no kill, parked stopped', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const { stack, gates } = stubGateStack({}, { control: true });
        let launchedEnv: BoardJob['gateEnv'];
        let supervisorEnv: BoardJob['supervisorEnv'];
        const runner = stubRunner(async (running) => {
            launchedEnv = { ...running.gateEnv };
            supervisorEnv = { ...running.supervisorEnv };
            options.cancelRequested = true;
            // Several stop beats land while the agent is still finishing its step.
            const target = board.board.beats + 4;
            await until(() => board.board.beats >= target);
            return ok();
        });

        await driveControlled({ ...board, runner, gates });

        // Ungated job, yet the endpoint opened: the control channel is not a gate feature.
        // The agent's env holds no control pair (#829 S3c): its publish/review token rides with the
        // supervisor's and the exporter's in the supervisor-side env, three distinct tokens of one attempt.
        expect(Object.keys(launchedEnv ?? {})).toEqual([]);
        expect(Object.keys(supervisorEnv ?? {}).sort()).toEqual([
            'SUPERVISOR_AGENT_TOKEN',
            'SUPERVISOR_CONTROL_TOKEN',
            'SUPERVISOR_CONTROL_URL',
            'SUPERVISOR_EXPORT_TOKEN',
        ]);
        const tokens = [
            supervisorEnv?.SUPERVISOR_AGENT_TOKEN,
            supervisorEnv?.SUPERVISOR_CONTROL_TOKEN,
            supervisorEnv?.SUPERVISOR_EXPORT_TOKEN,
        ];
        expect(new Set(tokens).size).toBe(3);
        expect(stack.controlOpened).toEqual([supervisorEnv?.SUPERVISOR_CONTROL_TOKEN]);
        expect(stack.exportersGranted).toEqual([
            [supervisorEnv?.SUPERVISOR_CONTROL_TOKEN, supervisorEnv?.SUPERVISOR_EXPORT_TOKEN],
        ]);
        // Repeated stop beats are idempotent: one raise, scoped to this attempt's token.
        expect(stack.stopsRaised).toEqual(stack.controlOpened);
        expect(runner.killed).toEqual([]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
        expect(stack.controlClosed).toEqual(stack.controlOpened);
    });

    it('runs no declared gate, post-helper, publish or completion after a draining exit', async () => {
        const postPlan: HelperPlan = { helperId: 'noop', phase: 'post', input: null, githubWriting: false };
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([{ ...gatedJob(1), helperPlans: [postPlan] }], options);
        const { stack, gates } = stubGateStack({}, { control: true });
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            const target = board.board.beats + 2;
            await until(() => board.board.beats >= target);
            // A clean exit: the agent stopped at a step boundary because it was asked to.
            return ok();
        });
        runner.runHelper = async () => {
            throw new Error('no helper may run after a stop');
        };

        await driveControlled({ ...board, runner, gates });

        expect(stack.ran.names).toEqual([]);
        expect(runner.published).toEqual([]);
        expect(runner.killed).toEqual([]);
        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([job(1).id]);
    });

    it('reports the session before the park, even after a clean draining exit', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }], options);
        const events: string[] = [];
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            events.push(`parked after ${board.board.sessions.length} session(s)`);
            return rawSuspend(claimed);
        };
        const { gates } = stubGateStack({}, { control: true });
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            const target = board.board.beats + 2;
            await until(() => board.board.beats >= target);
            return ok({ sessionId: 'ses_drained000000000000001', fullLog: 'log\n' });
        });

        await driveControlled({ ...board, runner, gates });

        expect(events).toEqual(['parked after 1 session(s)']);
        expect(board.board.completed).toEqual([]);
    });

    it('force-kills an agent that has not stopped when the grace passes', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const { stack, gates } = stubGateStack({}, { control: true });
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            // A hung agent: it only ends because the grace deadline killed it.
            await until(() => runner.killed.length > 0);
            return ok({ exitCode: 137 });
        });

        await driveControlled({ ...board, runner, gates }, { stopGraceMs: 30 });

        expect(stack.stopsRaised).toHaveLength(1);
        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    it('does not arm the grace kill once the run ends', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const { gates } = stubGateStack({}, { control: true });
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            const target = board.board.beats + 2;
            await until(() => board.board.beats >= target);
            return ok();
        });

        await driveControlled({ ...board, runner, gates }, { stopGraceMs: 40 });
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(runner.killed).toEqual([]);
    });

    it('leaves the runner at once on a lost lease while draining, killing nothing', async () => {
        const board = stubBoard([job(1)]);
        let verdict: HeartbeatVerdict = { result: 'held', cancelRequested: false };
        board.board.heartbeat = async () => {
            board.board.beats += 1;
            return verdict;
        };
        const { gates } = stubGateStack({}, { control: true });
        const runner = stubRunner(async () => {
            verdict = { result: 'held', cancelRequested: true };
            const target = board.board.beats + 2;
            await until(() => board.board.beats >= target);
            verdict = 'lost';
            const lostAt = board.board.beats + 2;
            await until(() => board.board.beats >= lostAt);
            return ok();
        });

        await driveControlled({ ...board, runner, gates });

        expect(runner.killed).toEqual([]);
        expect(board.board.suspended).toEqual([]);
    });

    it.each([
        ['stops at once, as before, when the driver has no control endpoint', undefined],
        ['kills at once when no runner ever polled the control endpoint', { control: true, polled: false }],
    ] as const)('%s', async (_label, control) => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const { stack, gates } = stubGateStack({}, control);
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            await until(() => runner.killed.length > 0);
            return ok();
        });

        await driveControlled({ ...board, runner, gates });

        expect(stack.stopsRaised).toEqual([]);
        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
    });

    it('settles a draining attempt as stopped when its run rejects', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const { gates } = stubGateStack({}, { control: true });
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            const target = board.board.beats + 2;
            await until(() => board.board.beats >= target);
            throw new Error('the pod vanished under the agent');
        });

        await driveControlled({ ...board, runner, gates });

        expect(runner.killed).toEqual([]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    it('polls at RUN_CONTROL_POLL_MS under a long lease, not at a lease third', async () => {
        const board = stubBoard([job(1)]);
        const { gates } = stubGateStack({}, { control: true });
        const slept: number[] = [];
        const runner = stubRunner(async () => {
            const target = board.board.beats + 3;
            await until(() => board.board.beats >= target);
            return ok();
        });

        await driveControlled(
            { ...board, runner, gates },
            {
                env: { DRIVER_LEASE_SECONDS: '3600', DRIVER_POLL_MS: '1000' },
                sleep: (ms) => {
                    slept.push(ms);
                    return sleep();
                },
            }
        );

        expect(slept).toContain(RUN_CONTROL_POLL_MS);
        expect(Math.max(...slept)).toBe(RUN_CONTROL_POLL_MS);
    });

    it('gives a replacement attempt its own control token', async () => {
        const board = stubBoard([job(1), job(2)], { idleBeforeStop: 1 });
        const { stack, gates } = stubGateStack({}, { control: true });
        const runner = stubRunner(async () => ok());

        await driveControlled({ ...board, runner, gates });

        expect(stack.controlOpened).toHaveLength(2);
        expect(new Set(stack.controlOpened).size).toBe(2);
        expect(stack.stopsRaised).toEqual([]);
    });
});

describe('questions (issue #226)', () => {
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const until = async (condition: () => boolean) => {
        for (let i = 0; i < 2_000 && !condition(); i++) await tick();
        expect(condition()).toBe(true);
    };
    const asked = (id: string) =>
        JSON.stringify({
            questionId: id,
            questions: [
                {
                    question: 'Which colour?',
                    header: 'Colour',
                    multiSelect: false,
                    options: [{ label: 'Blue' }, { label: 'Red' }],
                },
            ],
        });
    const ANSWERS = { 'Which colour?': 'Blue' };

    /** Drives one attempt whose run is `body`, handed the real control entry the runner's bridge would talk to. */
    async function driveAsking(
        body: (ctx: {
            control: ControlEntry;
            board: ReturnType<typeof stubBoard>['board'];
            runner: ReturnType<typeof stubRunner>;
            stack: ReturnType<typeof stubGateStack>['stack'];
            beat: { verdict: HeartbeatVerdict };
        }) => Promise<RunOutcome>,
        options: {
            polled?: boolean;
            board?: Parameters<typeof stubBoard>[1];
        } = {}
    ) {
        const board = stubBoard([job(1)], options.board);
        const beat = { verdict: { result: 'held', cancelRequested: false } as HeartbeatVerdict };
        board.board.heartbeat = async () => {
            board.board.beats += 1;
            return beat.verdict;
        };
        const { stack, gates } = stubGateStack({}, { control: true, polled: options.polled ?? true });
        const runner: ReturnType<typeof stubRunner> = stubRunner(async (running) => {
            const control = stack.controls.get(running.supervisorEnv?.SUPERVISOR_AGENT_TOKEN ?? '');
            if (!control) throw new Error('no control entry');
            return body({ control, board: board.board, runner, stack, beat });
        });
        const loop = createLoop({
            board: board.board,
            runner,
            config: config(),
            gates,
            sleep,
        });
        board.attach(loop);
        await loop.start();
        return { board: board.board, runner, stack };
    }

    it('delivers an answer the heartbeat carries and settles the question answered', async () => {
        let seen: unknown;
        const { board } = await driveAsking(async ({ control, beat }) => {
            expect((await recordQuestion(control, asked('toolu_1'))).status).toBe(202);
            beat.verdict = {
                result: 'held',
                cancelRequested: false,
                answeredQuestions: [{ questionId: 'toolu_1', answers: ANSWERS }],
            };
            await until(() => control.questions.get('toolu_1')?.state === 'answered');
            seen = readQuestion(control, 'toolu_1').body;
            return ok();
        });

        expect(seen).toEqual({ state: 'answered', answers: ANSWERS });
        expect(board.questionsReported).toEqual(['toolu_1']);
        expect(board.completed).toHaveLength(1);
    });

    it('applies a repeated answer as a no-op and ignores an answer for an unknown id', async () => {
        let seen: unknown;
        await driveAsking(async ({ control, board, beat }) => {
            await recordQuestion(control, asked('toolu_1'));
            beat.verdict = {
                result: 'held',
                cancelRequested: false,
                answeredQuestions: [{ questionId: 'toolu_1', answers: ANSWERS }],
            };
            await until(() => control.questions.get('toolu_1')?.state === 'answered');
            // The board lists the answered question on every beat: later beats say a different
            // text for the same id, and an id that was never asked.
            beat.verdict = {
                result: 'held',
                cancelRequested: false,
                answeredQuestions: [
                    { questionId: 'toolu_1', answers: { 'Which colour?': 'Red' } },
                    { questionId: 'toolu_unknown', answers: ANSWERS },
                ],
            };
            const target = board.beats + 3;
            await until(() => board.beats >= target);
            seen = { known: readQuestion(control, 'toolu_1').body, unknown: control.questions.has('toolu_unknown') };
            return ok();
        });

        expect(seen).toEqual({ known: { state: 'answered', answers: ANSWERS }, unknown: false });
    });

    it('resumes the runtime budget when reporting a question fails', async () => {
        await driveAsking(async ({ control, board, runner }) => {
            board.question = async () => {
                await until(() => runner.paused.some((entry) => entry.paused));
                throw new Error('board unavailable');
            };
            await expect(recordQuestion(control, asked('toolu_1'))).rejects.toThrow('board unavailable');
            expect(control.questions.size).toBe(0);
            expect(runner.paused).toEqual([
                { id: job(1).id, paused: true },
                { id: job(1).id, paused: false },
            ]);
            return ok();
        });
    });

    it('keeps unanswered questions pending without completing the task', async () => {
        const { runner } = await driveAsking(async ({ control, board, beat, runner }) => {
            await recordQuestion(control, asked('toolu_1'));
            await recordQuestion(control, asked('toolu_2'));
            const target = board.beats + 3;
            await until(() => board.beats >= target);
            expect(readQuestion(control, 'toolu_1').body).toEqual({ state: 'pending' });
            expect(board.completed).toEqual([]);
            beat.verdict = {
                result: 'held',
                cancelRequested: false,
                answeredQuestions: [{ questionId: 'toolu_1', answers: ANSWERS }],
            };
            await until(() => control.questions.get('toolu_1')?.state === 'answered');
            expect(runner.paused).toEqual([{ id: job(1).id, paused: true }]);
            beat.verdict = {
                result: 'held',
                cancelRequested: false,
                answeredQuestions: [{ questionId: 'toolu_2', answers: ANSWERS }],
            };
            await until(() => control.questions.get('toolu_2')?.state === 'answered');
            return ok();
        });
        expect(runner.paused).toEqual([
            { id: job(1).id, paused: true },
            { id: job(1).id, paused: false },
        ]);
    });

    it('cancels a pending question on a Stop and drains rather than kills, though no poll ever came', async () => {
        const { board, runner, stack } = await driveAsking(
            async ({ control, beat }) => {
                await recordQuestion(control, asked('toolu_1'));
                beat.verdict = { result: 'held', cancelRequested: true };
                await until(() => control.questions.get('toolu_1')?.state === 'cancelled');
                return ok();
            },
            { polled: false }
        );

        expect(runner.killed).toEqual([]);
        expect(runner.paused).toEqual([
            { id: job(1).id, paused: true },
            { id: job(1).id, paused: false },
        ]);
        expect(stack.stopsRaised).toHaveLength(1);
        expect(board.suspended).toEqual([job(1).id]);
        expect(board.completed).toEqual([]);
    });

    it('retries a failed budget restoration while draining a stopped question', async () => {
        let resumes = 0;
        const { board, runner } = await driveAsking(async ({ control, beat, runner: active }) => {
            const pause = active.pauseDeadline;
            active.pauseDeadline = async (claimed, paused) => {
                if (!paused && ++resumes === 1) throw new Error('temporary runner API failure');
                await pause!(claimed, paused);
            };
            await recordQuestion(control, asked('toolu_1'));
            beat.verdict = { result: 'held', cancelRequested: true };
            await until(() => active.paused.some((entry) => !entry.paused));
            expect(control.questions.get('toolu_1')?.state).toBe('cancelled');
            return ok();
        });
        expect(resumes).toBe(2);
        expect(runner.killed).toEqual([]);
        expect(board.suspended).toEqual([job(1).id]);
        expect(board.completed).toEqual([]);
    });

    it('drops the question entry when the lease is lost while pending', async () => {
        const { stack } = await driveAsking(async ({ control, beat, stack: running }) => {
            await recordQuestion(control, asked('toolu_1'));
            beat.verdict = 'lost';
            await until(() => running.controlDeparted.length > 0);
            return ok();
        });
        await new Promise((resolve) => setTimeout(resolve, 80));

        expect(stack.controls.size).toBe(0);
        // The runner is the new holder's: its token is departed, never closed on.
        expect(stack.controlDeparted.map((departed) => departed.token)).toEqual(stack.controlOpened);
        expect(stack.controlClosed).toEqual([]);
    });

    it('treats a lost lease on the question report as a lease loss', async () => {
        let status = 0;
        const { runner } = await driveAsking(
            async ({ control, runner: running }) => {
                status = (await recordQuestion(control, asked('toolu_1'))).status;
                await until(() => running.killed.length > 0);
                return ok();
            },
            { board: { questionVerdict: 'lost' } }
        );

        expect(status).toBe(401);
        expect(runner.paused).toEqual([]);
    });

    it('pauses once across questions, never for a repeat or a refused one', async () => {
        const { runner } = await driveAsking(async ({ control }) => {
            await recordQuestion(control, asked('toolu_1'));
            await recordQuestion(control, asked('toolu_1'));
            await recordQuestion(control, asked('toolu_2'));
            return ok();
        });

        expect(runner.paused).toEqual([{ id: job(1).id, paused: true }]);

        const refused = await driveAsking(
            async ({ control }) => {
                expect((await recordQuestion(control, asked('toolu_1'))).status).toBe(429);
                expect(control.questions.size).toBe(0);
                return ok();
            },
            { board: { questionVerdict: 'refused' } }
        );
        expect(refused.runner.paused).toEqual([]);
    });
});

/**
 * The configured evidence policy (issue #548): enforced at publication whatever the agent chose to
 * run, bound to the tree fingerprint the evidence assessed, and reported with the verdict.
 */
describe('revision-bound evidence', () => {
    const synced = { ok: true, reason: null, fingerprint: 'head:aaaa' };
    const LANDED: PublishResult = {
        ok: true,
        published: true,
        branch: 'factory/1',
        prUrl: 'https://github.com/Bellows-AI/bellows/pull/42',
        reason: null,
        cause: null,
        repository: 'Bellows-AI/bellows',
        baseBranch: 'main',
        prNumber: 42,
    };

    async function driveWith(claim: BoardJob, runnerOptions: { publish?: PublishResult; gatesFail?: boolean } = {}) {
        const board = stubBoard([claim]);
        const runner = stubRunner(async () => ok(), { sync: synced, probeTree: 'head:bbbb' });
        const options: unknown[] = [];
        runner.publishGit = async (_job, _token, publishOptions) => {
            options.push(publishOptions);
            return runnerOptions.publish ?? LANDED;
        };
        const stack = stubGateStack(runnerOptions.gatesFail ? { test: 1 } : {});
        await drive({ ...board, runner, gates: stack.gates });
        return { completed: board.board.completed[0], options };
    }

    it('reports nothing and publishes unbound when no policy is configured', async () => {
        const { completed, options } = await driveWith(gatedJob(1));
        expect(completed).not.toHaveProperty('evidence');
        expect(options).toEqual([{ recordPrOperation: expect.any(Function) }]);
    });

    it('binds the publish to the tree the passing gates assessed, and reports that evidence', async () => {
        const { completed, options } = await driveWith({ ...gatedJob(1), policy: { gates: true } });
        expect(options).toEqual([{ revision: 'head:bbbb', recordPrOperation: expect.any(Function) }]);
        expect(completed?.status).toBe('succeeded');
        expect(completed?.evidence).toEqual({ treeBefore: 'head:aaaa', treeAfter: 'head:bbbb', gates: 'passed' });
    });

    it('refuses to publish when gates are required and the task declares none', async () => {
        const { completed, options } = await driveWith({ ...job(1), policy: { gates: true } });
        expect(options).toEqual([]);
        expect(completed).toMatchObject({ status: 'failed', failureKind: 'policy' });
        expect(completed?.output).toContain('publication refused — declared gates are required but none ran');
        expect(completed?.evidence).toMatchObject({ gates: 'none' });
    });

    it('reads only on-demand gates as none ran — required gates never pass vacuously', async () => {
        const gates = {
            image: 'node:24',
            gates: [{ name: 'ui', command: 'npm run verify:ui', onDemand: true as const }],
        };
        const { completed, options } = await driveWith({ ...gatedJob(1), gates, policy: { gates: true } });
        expect(options).toEqual([]);
        expect(completed).toMatchObject({ status: 'failed', failureKind: 'policy' });
        expect(completed?.evidence).toMatchObject({ gates: 'none' });
    });

    it('ships a draft over a failed gate by default, and the failure stays visible (issue #573)', async () => {
        const { completed, options } = await driveWith(gatedJob(1), { gatesFail: true });
        expect(options).toEqual([{ draft: true, recordPrOperation: expect.any(Function) }]);
        expect(completed).toMatchObject({ status: 'failed', failureKind: 'gate' });
        expect(completed?.output).toContain('gate "test" failed');
        expect(completed?.publication?.prNumber).toBe(42);
    });

    it('leaves a workflow publish node to its graph: a failed gate there publishes nothing', async () => {
        const { completed, options } = await driveWith({ ...gatedJob(1), publish: true }, { gatesFail: true });
        expect(options).toEqual([]);
        expect(completed).toMatchObject({ status: 'failed', failureKind: 'gate' });
    });

    it('never publishes over a failed gate, and the failure stays a gate failure', async () => {
        const { completed, options } = await driveWith(
            { ...gatedJob(1), policy: { gates: true } },
            { gatesFail: true }
        );
        expect(options).toEqual([]);
        expect(completed).toMatchObject({ status: 'failed', failureKind: 'gate' });
        expect(completed?.evidence).toMatchObject({ gates: 'failed' });
    });

    // One non-approving state pins the wiring; evidence-policy.test.ts owns every state's reason.
    it('refuses a required review that is rejected', async () => {
        const { completed, options } = await driveWith({
            ...gatedJob(1),
            policy: { review: true },
            review: { state: 'rejected' },
        });
        expect(options).toEqual([]);
        expect(completed).toMatchObject({ status: 'failed', failureKind: 'policy' });
    });

    it('refuses a review of a different revision than the gates assessed', async () => {
        const claim = {
            ...gatedJob(1),
            policy: { gates: true, review: true },
            review: { state: 'approved', revision: 'head:old' },
        };
        const { completed, options } = await driveWith(claim as BoardJob);
        expect(options).toEqual([]);
        expect(completed?.output).toContain('different revision');
    });

    it('binds an approved review to the revision it assessed', async () => {
        const claim = { ...job(1), policy: { review: true }, review: { state: 'approved', revision: 'head:bbbb' } };
        const { completed, options } = await driveWith(claim as BoardJob);
        expect(options).toEqual([{ revision: 'head:bbbb', recordPrOperation: expect.any(Function) }]);
        expect(completed?.status).toBe('succeeded');
    });

    it('reports a publish the checkout refused as stale as a policy failure, not a publish one', async () => {
        const stale = { ...LANDED, ok: false, published: false, reason: 'the checkout changed', stale: true } as const;
        const { completed } = await driveWith({ ...gatedJob(1), policy: { gates: true } }, { publish: stale });
        expect(completed).toMatchObject({ status: 'failed', failureKind: 'policy' });
    });
});

describe('a stop the board cannot take (issue #820)', () => {
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => void unhandled.push(reason);

    /** Job 1 is stopped in setup and its suspend always fails; job 2 runs to completion. */
    function outage() {
        const board = stubBoard([job(1), job(2)], { idleBeforeStop: 3 });
        const rawHeartbeat = board.board.heartbeat.bind(board.board);
        board.board.heartbeat = async (claimed) =>
            claimed.id === job(1).id ? { result: 'held', cancelRequested: true } : rawHeartbeat(claimed);
        let suspends = 0;
        board.board.suspend = async () => {
            suspends += 1;
            throw new BoardHttpError(503, '/api/jobs/x/suspend answered 503: down');
        };
        const runner = stubRunner(async (claimed) => {
            if (claimed.id === job(1).id) throw new Error('the stopped job must not spawn');
            return ok();
        });
        return { board, runner, suspends: () => suspends };
    }

    it('leaves the other claim running, and the loop finishes without an unhandled rejection', async () => {
        process.on('unhandledRejection', record);
        try {
            const logs: string[] = [];
            const { board, runner, suspends } = outage();

            await drive({ ...board, runner, log: (m) => logs.push(m) }, { DRIVER_CONCURRENCY: '2' });
            for (let i = 0; i < 20; i++) await tick();

            expect(unhandled).toEqual([]);
            expect(board.board.completed.map((c) => c.id)).toEqual([job(2).id]);
            expect(suspends()).toBe(BOARD_CALL_ATTEMPTS);
            expect(logs.some((l) => l.includes(`job ${job(1).id}: the board did not take the stop`))).toBe(true);
        } finally {
            process.off('unhandledRejection', record);
            unhandled.length = 0;
        }
    });

    it('contains a suspend that fails only after a handover resolved start()', async () => {
        process.on('unhandledRejection', record);
        try {
            const board = stubBoard([job(1)], { idleBeforeStop: 1_000 });
            board.board.heartbeat = async () => ({ result: 'held', cancelRequested: true });
            let fail = () => {};
            const gate = new Promise<void>((resolve) => {
                fail = resolve;
            });
            let suspends = 0;
            board.board.suspend = async () => {
                suspends += 1;
                await gate;
                throw new BoardHttpError(503, '/api/jobs/x/suspend answered 503: down');
            };
            const runner = stubRunner(async () => {
                throw new Error('the stopped job must not spawn');
            });
            const loop = createLoop({ board: board.board, runner, config: config(), sleep });
            board.attach(loop);
            const started = loop.start();
            while (suspends === 0) await tick();

            loop.stop();
            await loop.handover('drain');
            await started;
            fail();
            for (let i = 0; i < 50; i++) await tick();

            expect(suspends).toBe(BOARD_CALL_ATTEMPTS);
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', record);
            unhandled.length = 0;
        }
    });
});
