import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { servePublish } from '../../src/publish/publish-control.js';
import type { PublishResult } from '../../src/publish/publish.js';
import { createLoop } from '../../src/loop/loop.js';
import {
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

describe('the agent’s draft publication (issue #547)', () => {
    const LANDED: PublishResult = {
        ok: true,
        published: true,
        branch: 'fix/10',
        prUrl: 'https://github.com/Bellows-AI/bellows/pull/42',
        reason: null,
        cause: null,
        repository: 'Bellows-AI/bellows',
        baseBranch: 'main',
        prNumber: 42,
    };
    const NOTHING: PublishResult = { ...LANDED, published: false, prUrl: null, repository: null, baseBranch: null };

    /** One attempt whose agent calls `POST /publish` through the real route logic; returns what it was answered. */
    async function driveAgentPublishing(claim: BoardJob, endOfRun: PublishResult) {
        const board = stubBoard([claim]);
        const { stack, gates } = stubGateStack({}, { control: true });
        const answers: number[] = [];
        const runner: ReturnType<typeof stubRunner> = stubRunner(
            async (running) => {
                const control = stack.controls.get(running.supervisorEnv?.SUPERVISOR_AGENT_TOKEN ?? '');
                if (!control?.publisher) throw new Error('no publisher on the control entry');
                answers.push((await servePublish(control.publishing, control.publisher)).status);
                return ok();
            },
            { publish: endOfRun }
        );
        const options: unknown[] = [];
        const endOfRunPublish = runner.publishGit.bind(runner);
        runner.publishGit = async (publishedJob, token, publishOptions) => {
            options.push(publishOptions);
            return (
                options.length === 1 && publishOptions?.draft ? LANDED : await endOfRunPublish(publishedJob, token)
            ) as PublishResult;
        };
        const loop = createLoop({ board: board.board, runner, config: config(), gates, sleep });
        board.attach(loop);
        await loop.start();
        return { board: board.board, runner, answers, options };
    }

    it('publishes a draft mid-run, and the verdict still names the PR when the end-of-run publish has nothing left', async () => {
        const { board, answers, options } = await driveAgentPublishing(job(1), NOTHING);

        expect(answers).toEqual([200]);
        expect(options).toEqual([
            { draft: true, recordPrOperation: expect.any(Function) },
            { recordPrOperation: expect.any(Function) },
        ]);
        expect(board.completed[0]?.status).toBe('succeeded');
        expect(board.completed[0]?.publication).toEqual({
            repo: 'Bellows-AI/bellows',
            prNumber: 42,
            prUrl: LANDED.prUrl,
            headBranch: 'fix/10',
            baseBranch: 'main',
        });
    });

    it('refuses the agent on a task whose board reserves publication for another step', async () => {
        const { board, answers, options } = await driveAgentPublishing({ ...job(1), publish: false }, NOTHING);

        expect(answers).toEqual([403]);
        expect(options).toEqual([]);
        expect(board.completed[0]?.publication ?? null).toBeNull();
    });
});

describe('an objective-mode task, ticket to draft publication (issue #550)', () => {
    const LANDED: PublishResult = {
        ok: true,
        published: true,
        branch: 'factory/objective',
        prUrl: 'https://github.com/Bellows-AI/bellows/pull/77',
        reason: null,
        cause: null,
        repository: 'Bellows-AI/bellows',
        baseBranch: 'main',
        prNumber: 77,
    };

    /** An objective claim: gated, and carrying no `publish` key — the board never reserves publication. */
    const objectiveJob = (n: number): BoardJob => {
        const claim = gatedJob(n);
        expect('publish' in claim).toBe(false);
        return claim;
    };

    it('revises after a gate failure and a review finding, publishes a draft twice, and completes on the current evidence', async () => {
        const board = stubBoard([objectiveJob(1)]);
        // Mutable on purpose: the agent "fixes the code" mid-run, which flips the gate's answer.
        const outcomes: Record<string, number> = { test: 1 };
        const { stack, gates } = stubGateStack(outcomes, { control: true });
        const adHoc: (number | null)[] = [];
        const answers: number[] = [];
        const runner: ReturnType<typeof stubRunner> = stubRunner(
            async (running) => {
                const key = `${objectiveJob(1).id}/factory`;
                const control = stack.controls.get(running.supervisorEnv?.SUPERVISOR_AGENT_TOKEN ?? '');
                if (!control?.publisher) throw new Error('no publisher on the control entry');
                const gate = async () => adHoc.push((await stack.manager.runGate(key, 'test', 'npm test')).exitCode);
                // 1. implement, run the gate: red.
                await gate();
                // 2. revise, rerun: green; publish the first draft.
                outcomes.test = 0;
                await gate();
                answers.push((await servePublish(control.publishing, control.publisher)).status);
                // 3. a review finding sends the agent back; the revision reruns the gate before the
                //    draft is updated.
                await gate();
                answers.push((await servePublish(control.publishing, control.publisher)).status);
                return ok();
            },
            { publish: LANDED }
        );
        const options: unknown[] = [];
        runner.publishGit = async (_job, _token, publishOptions) => {
            options.push(publishOptions);
            return LANDED;
        };

        await drive({ ...board, runner, gates });

        expect(adHoc).toEqual([1, 0, 0]);
        expect(answers).toEqual([200, 200]);
        expect(options).toEqual([
            { draft: true, recordPrOperation: expect.any(Function) },
            { draft: true, recordPrOperation: expect.any(Function) },
            { recordPrOperation: expect.any(Function) },
        ]);
        // The close-of-run gates still run over the final tree — policy, not a stage the agent picked.
        expect(stack.ran.names.slice(-2)).toEqual(['test', 'lint']);
        const verdict = board.board.completed[0]!;
        expect(verdict.status).toBe('succeeded');
        expect(verdict.publication?.prNumber).toBe(77);
    });

    it('does not complete green when the agent left the gate red, whatever it published', async () => {
        const board = stubBoard([objectiveJob(1)]);
        const { stack, gates } = stubGateStack({ test: 1 }, { control: true });
        const runner: ReturnType<typeof stubRunner> = stubRunner(
            async (running) => {
                const control = stack.controls.get(running.supervisorEnv?.SUPERVISOR_AGENT_TOKEN ?? '');
                if (!control?.publisher) throw new Error('no publisher on the control entry');
                await servePublish(control.publishing, control.publisher);
                return ok();
            },
            { publish: LANDED }
        );
        runner.publishGit = async () => LANDED;

        await drive({ ...board, runner, gates });

        const verdict = board.board.completed[0]!;
        expect(verdict.status).toBe('failed');
        expect(verdict.failureKind).toBe('gate');
    });
});

describe('the PR operation record, from the loop (issue #983)', () => {
    const LANDED: PublishResult = {
        ok: true,
        published: true,
        branch: 'fix/10',
        prUrl: 'https://github.com/Bellows-AI/bellows/pull/42',
        reason: null,
        cause: null,
        repository: 'Bellows-AI/bellows',
        baseBranch: 'main',
        prNumber: 42,
    };
    const NOTE = {
        operationId: '88888888-8888-4888-8888-888888888888',
        operation: 'created' as const,
        repo: 'Bellows-AI/bellows',
        prNumber: 42,
        prUrl: LANDED.prUrl!,
        branch: 'fix/10',
    };

    /** A publisher that, like `publishCheckout`, hands every operation it performs to the recorder it was given. */
    async function driveAndPublish(answer: 'ok' | 'lost' | 'rejected' | 'throw', claim: BoardJob = job(1)) {
        const board = stubBoard([claim], { prOperation: answer });
        const runner = stubRunner(async () => ok(), { publish: LANDED });
        runner.publishGit = async (_job, _token, options) => {
            await options?.recordPrOperation?.(NOTE);
            return { ...LANDED, operationId: NOTE.operationId };
        };
        const logs: string[] = [];
        await drive({ ...board, runner, log: (line) => logs.push(line) });
        return { board: board.board, logs };
    }

    it('records the end-of-run publish’s operation against the attempt’s own lease', async () => {
        const claim = job(1);
        const { board } = await driveAndPublish('ok', claim);
        expect(board.prOperationsWritten).toEqual([{ id: claim.id, leaseToken: claim.leaseToken, write: NOTE }]);
        expect(board.completed[0]?.status).toBe('succeeded');
    });

    it('records the agent’s mid-run draft publish too', async () => {
        const board = stubBoard([job(1)]);
        const { stack, gates } = stubGateStack({}, { control: true });
        const runner: ReturnType<typeof stubRunner> = stubRunner(
            async (running) => {
                const control = stack.controls.get(running.supervisorEnv?.SUPERVISOR_AGENT_TOKEN ?? '');
                await servePublish(control!.publishing, control!.publisher!);
                return ok();
            },
            { publish: LANDED }
        );
        runner.publishGit = async (_job, _token, options) => {
            await options?.recordPrOperation?.(NOTE);
            return LANDED;
        };
        await drive({ ...board, runner, gates });
        expect(board.board.prOperationsWritten.map((w) => w.write)).toEqual([NOTE, NOTE]);
    });

    it.each(['lost', 'rejected', 'throw'] as const)(
        'a write the board answered %s never fails the publish: it is only unrecorded, and says so',
        async (answer) => {
            const { board, logs } = await driveAndPublish(answer);
            expect(board.completed[0]?.status).toBe('succeeded');
            expect(board.completed[0]?.publication?.prNumber).toBe(42);
            expect(logs.some((line) => line.includes('PR operation') && line.includes('unrecorded'))).toBe(true);
        }
    );
});
