/**
 * `runJob` driven directly, with no claim loop around it: the module's own contracts — the order in
 * which claim refusals are decided, how a checkout sync's answer becomes a verdict or a
 * fault, and what each way a run can end leaves on the board. The claim loop's behavior end to end
 * is `loop/`; the phase-boundary faults are `loop-phase-faults.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { runJob } from '../src/loop/loop-run.js';
import type { SyncResult } from '../src/publish/publish.js';
import type { RunOutcome } from '../src/runner.js';
import { StartupRefused } from '../src/startup-cause.js';
import { SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import { gatedJob, job, ok, stubBoard, stubGateStack, stubRunner, stubRuntime } from './fixtures/loop-stubs.js';

type RunnerOptions = NonNullable<Parameters<typeof stubRunner>[1]>;

/** One attempt of `claimed` through `runJob`, with every call recorded. */
async function attempt(
    claimed: BoardJob,
    options: RunnerOptions = {},
    run: (claimed: BoardJob) => Promise<RunOutcome> = async () => ok()
) {
    const board = stubBoard([]).board;
    const runner = stubRunner(run, options);
    const logs: string[] = [];
    const rt = stubRuntime(board, runner, { log: (m) => logs.push(m) });
    await runJob(rt, claimed);
    return { board, runner, logs };
}

const nothingLaunched = (r: Awaited<ReturnType<typeof attempt>>) => {
    expect(r.board.beats).toBe(0);
    expect(r.runner.synced).toEqual([]);
    expect(r.board.sessions).toEqual([]);
    expect(r.board.githubAsks).toEqual([]);
};

describe('the claim refusals, decided before anything launches', () => {
    it('fails an executor selection as config, launching nothing', async () => {
        const r = await attempt({ ...job(1), executorRefusal: 'executor "x" is archived' });

        expect(r.board.completed).toHaveLength(1);
        expect(r.board.completed[0]).toMatchObject({
            status: 'failed',
            failureKind: 'config',
            output: 'executor "x" is archived',
        });
        nothingLaunched(r);
    });

    it('writes exactly one setup>ended attempt-transition line for a refusal, with no JobState behind it', async () => {
        for (const refused of [{ skillRefusal: 'skill "s" is gone' }, { masterPrompt: '' }]) {
            const claimed = { ...job(1), ...refused };
            const r = await attempt(claimed);

            const lines = r.logs.filter((m) => m.includes('"event":"attempt-transition"')).map((m) => JSON.parse(m));
            expect(lines).toEqual([
                {
                    event: 'attempt-transition',
                    job: claimed.id,
                    claimSeq: claimed.claimSeq,
                    from: 'setup',
                    to: 'ended',
                    ending: null,
                    at: expect.any(Number),
                },
            ]);
        }
    });

    it('names a deleted executor when the claim carries none', async () => {
        const r = await attempt({ ...job(1), executorType: null });

        expect(r.board.completed[0]).toMatchObject({ failureKind: 'config' });
        expect(r.board.completed[0]?.output).toContain('no longer exists');
        nothingLaunched(r);
    });

    it('fails a skill refusal as config', async () => {
        const r = await attempt({ ...job(1), skillRefusal: 'skill "s" is gone' });

        expect(r.board.completed[0]).toMatchObject({ failureKind: 'config', output: 'skill "s" is gone' });
        nothingLaunched(r);
    });

    it('fails a plan refusal as config', async () => {
        const r = await attempt({ ...job(1), planRefusal: '.bellows.yaml line 3: unknown key' });

        expect(r.board.completed[0]).toMatchObject({ failureKind: 'config' });
        expect(r.board.completed[0]?.output).toContain('unknown key');
        nothingLaunched(r);
    });

    it('fails a master prompt the board broke as runner_error, not config', async () => {
        const r = await attempt({ ...job(1), masterPrompt: '' });

        expect(r.board.completed).toHaveLength(1);
        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        nothingLaunched(r);
    });

    it('decides the executor first, then the skills, then the plan, then the prompt', async () => {
        const all = {
            ...job(1),
            executorRefusal: 'E',
            skillRefusal: 'S',
            planRefusal: 'P',
            masterPrompt: '',
        };
        const outputs: (string | undefined)[] = [];
        for (const claimed of [
            all,
            { ...all, executorRefusal: null },
            { ...all, executorRefusal: null, skillRefusal: null },
        ]) {
            outputs.push((await attempt(claimed)).board.completed[0]?.output);
        }
        const last = await attempt({ ...all, executorRefusal: null, skillRefusal: null, planRefusal: null });

        expect(outputs).toEqual(['E', 'S', 'P']);
        expect(last.board.completed[0]?.failureKind).toBe('runner_error');
    });
});

describe('the checkout sync answer', () => {
    const refused = (over: Partial<SyncResult>): SyncResult => ({ ok: false, reason: 'boom', ...over });

    it('fails a kind the script named as config', async () => {
        const r = await attempt(job(1), { sync: refused({ kind: 'missing_base_branch' }) });

        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'config' });
        expect(r.board.completed[0]?.output).toContain('boom');
        expect(r.runner.synced).toHaveLength(1);
    });

    it('fails a refusal with no kind as runner_error', async () => {
        const r = await attempt(job(1), { sync: refused({}) });

        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
    });

    it.each([
        ['a repo on a starting claim', { ...job(1), repo: 'org/repo' }, 1],
        ['no repo', job(1), 0],
        ['a follow-up restoring its tree', { ...job(1), repo: 'org/repo', followUp: true }, 0],
    ])('asks GitHub for the sync token for %s', async (_label, claimed, asks) => {
        // A refused sync ends the attempt there, so the sync's is the only ask the board sees.
        const r = await attempt(claimed, { sync: { ok: false, reason: 'boom' } });

        expect(r.board.githubAsks).toHaveLength(asks);
        expect(r.runner.synced).toHaveLength(1);
    });
});

describe('the plan check', () => {
    it('refuses a package cache the driver will not set, as config', async () => {
        const claimed = { ...job(1), repo: null, gates: { image: 'node:24', gates: [], cache: ['npm'] } } as BoardJob;
        const r = await attempt(claimed);

        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'config' });
        expect(r.board.completed[0]?.output).toContain('will not run');
        expect(r.runner.synced).toHaveLength(1);
    });

    it('refuses declared gates when the driver has no gate environment, as runner_error', async () => {
        const r = await attempt(gatedJob(1));

        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(r.board.completed[0]?.output).toContain('GATE_*');
    });
});

describe('how a run ends', () => {
    it('hands a run that never started back as an interruption: no verdict, no gates', async () => {
        const r = await attempt(job(1), {}, async () => ok({ started: false, output: 'daemon refused' }));

        expect(r.board.interrupted).toHaveLength(1);
        expect(r.board.interrupted[0]?.reason).toContain('never started');
        expect(r.board.completed).toEqual([]);
        expect(r.board.gatesReported).toEqual([]);
    });

    it('reports a throw from a run on a non-final attempt as nothing: left to the lease', async () => {
        const r = await attempt(job(1), {}, async () => {
            throw new Error('apiserver said 401');
        });

        expect(r.board.completed).toEqual([]);
        expect(r.board.interrupted).toEqual([]);
        expect(r.logs.some((m) => m.includes('could not run: apiserver said 401'))).toBe(true);
    });

    it('fails a throw from the last attempt as runner_error, saying the driver could not run it', async () => {
        const r = await attempt({ ...job(1), lastAttempt: true }, {}, async () => {
            throw new Error('apiserver said 401');
        });

        expect(r.board.completed).toHaveLength(1);
        expect(r.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(r.board.completed[0]?.output).toContain('[driver] could not run');
    });

    it('interrupts a transient start refusal thrown by the run', async () => {
        const r = await attempt(job(1), {}, async () => {
            throw new StartupRefused('registry unreachable', 'transient');
        });

        expect(r.board.interrupted).toHaveLength(1);
        expect(r.board.interrupted[0]?.reason).toContain('registry unreachable');
        expect(r.board.completed).toEqual([]);
    });
});

describe('the session an attempt runs under, reported to the board (issue #845)', () => {
    it('reports a resumed session as well as a new one', async () => {
        const resumed = job(1, 'sess-prev');
        const r = await attempt(resumed);

        // Once before the spawn, once as the launch evidence of the run that followed.
        expect(r.board.sessions).toEqual(new Array(2).fill({ id: resumed.id, sessionId: 'sess-prev' }));
    });

    // The report precedes the spawn: a start the platform then refuses must stay "requested".
    it('sends the pre-launch report without launch evidence', async () => {
        const r = await attempt(job(1, 'sess-prev'));

        expect(r.board.sessionEvidence[0]).toBe(false);
    });

    it('sends the scraped session of a finished run as launch evidence', async () => {
        const r = await attempt({ ...job(1), executorType: 'opencode' }, {}, async () => ok({ sessionId: 'ses_ran' }));

        expect(r.board.sessions.at(-1)).toEqual({ id: job(1).id, sessionId: 'ses_ran' });
        expect(r.board.sessionEvidence.at(-1)).toBe(true);
    });

    it('does not claim launch evidence for a session scraped from a start that never ran', async () => {
        const r = await attempt({ ...job(1), executorType: 'opencode' }, {}, async () =>
            ok({ sessionId: 'ses_never', started: false })
        );

        // A start that never ran reports no session at all, so no launch is claimed for it.
        expect(r.board.sessions.some((s) => s.sessionId === 'ses_never')).toBe(false);
        expect(r.board.sessionEvidence).not.toContain(true);
    });

    it('does not claim launch evidence for the session of an adopted run: adoption launches nothing', async () => {
        const r = await attempt(
            { ...job(1), executorType: 'opencode' },
            { adopt: async () => ({ outcome: ok({ sessionId: 'ses_adopted' }), claimSeq: 4 }) }
        );

        const at = r.board.sessions.findIndex((s) => s.sessionId === 'ses_adopted');
        expect(at).toBeGreaterThanOrEqual(0);
        expect(r.board.sessionEvidence[at]).toBe(false);
    });

    it('does not claim launch evidence for the session of a taken-over run', async () => {
        const prior = { ...job(1), leaseToken: 'lease-prior' };
        const live = {
            live: true as const,
            prior,
            claimSeq: 4,
            session: 'ses_live',
            startedAt: 'then',
            forget: () => {},
        };
        const board = stubBoard([]).board;
        const runner = stubRunner(async () => ok({ sessionId: 'ses_live' }), { adopt: async () => live });
        const { gates } = stubGateStack({}, { control: true, polled: true });
        const rt = stubRuntime(board, runner, { gates });
        await runJob(rt, {
            ...job(1),
            executorType: 'opencode',
            claimSeq: 5,
            supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:1/', [SUPERVISOR_ENV.controlToken]: 'tok' },
        });

        const at = board.sessions.findIndex((s) => s.sessionId === 'ses_live');
        expect(at).toBeGreaterThanOrEqual(0);
        expect(board.sessionEvidence[at]).toBe(false);
    });

    it('runs and completes the attempt when the board cannot take the resumed session report', async () => {
        const resumed = job(1, 'sess-prev');
        const board = stubBoard([], { failSession: true }).board;
        const logs: string[] = [];
        await runJob(
            stubRuntime(
                board,
                stubRunner(async () => ok()),
                { log: (m) => logs.push(m) }
            ),
            resumed
        );

        expect(logs.some((m) => m.includes('could not report the session, continuing'))).toBe(true);
        expect(board.completed).toHaveLength(1);
        expect(board.completed[0]).toMatchObject({ status: 'succeeded' });
    });
});

describe('a normal run reaches observed before its verdict (issue #845, plan F6)', () => {
    /** Runs `run` for `claimed` and records, per board call, what the board had been told by then. */
    async function trace(claimed: BoardJob, run: Parameters<typeof stubRunner>[0], options: RunnerOptions = {}) {
        const board = stubBoard([]).board;
        const complete = board.complete.bind(board);
        const evidenceAtComplete: boolean[][] = [];
        board.complete = async (...args: Parameters<typeof complete>) => {
            evidenceAtComplete.push([...board.sessionEvidence]);
            return complete(...args);
        };
        await runJob(stubRuntime(board, stubRunner(run, options)), claimed);
        return { board, evidenceAtComplete };
    }

    for (const executorType of ['claude-code', 'opencode'] as const) {
        it(`${executorType}: the first output of the known session is reported as observed, mid-run`, async () => {
            const resumed = { ...job(1, 'sess-known'), executorType };
            const board = stubBoard([]).board;
            let during: boolean[] = [];
            const runner = stubRunner(async (_job, _session, onOutput) => {
                onOutput?.('agent is working');
                await new Promise((resolve) => setTimeout(resolve, 20));
                during = [...board.sessionEvidence];
                return ok();
            });
            await runJob(stubRuntime(board, runner), resumed);
            expect(during).toEqual([false, true]);
            expect(board.sessions.filter((s) => s.sessionId === 'sess-known').length).toBeGreaterThanOrEqual(2);
        });
    }

    it('claude-code: a silent run that finishes is still reported observed before its complete', async () => {
        const t = await trace(job(1), async () => ok());

        expect(t.evidenceAtComplete[0]).toContain(true);
        expect(t.board.sessionEvidence[0]).toBe(false);
    });

    it('a runtime sample alone proves the launch of a silent, long run', async () => {
        const board = stubBoard([]).board;
        const runner = stubRunner(
            async () => {
                await new Promise((resolve) => setTimeout(resolve, 2_600));
                return ok();
            },
            { sample: { cpuPercent: 1, memUsedMb: 1, memPercent: 1 } }
        );
        let during: boolean[] = [];
        const finished = runJob(stubRuntime(board, runner), job(1));
        await new Promise((resolve) => setTimeout(resolve, 2_400));
        during = [...board.sessionEvidence];
        await finished;

        expect(during).toContain(true);
    });

    it('never reports observed for a start the platform refused', async () => {
        const t = await trace(job(1), async () => ok({ started: false, refused: true }));

        expect(t.board.sessionEvidence).not.toContain(true);
    });

    it('never reports observed for a taken-over run, even one that streams output', async () => {
        const prior = { ...job(1), leaseToken: 'lease-prior' };
        const live = {
            live: true as const,
            prior,
            claimSeq: 4,
            session: 'ses_live',
            startedAt: 'then',
            forget: () => {},
        };
        const board = stubBoard([]).board;
        const runner = stubRunner(
            async (_job, _session, onOutput) => {
                onOutput?.('still going');
                return ok();
            },
            { adopt: async () => live }
        );
        const { gates } = stubGateStack({}, { control: true, polled: true });
        await runJob(stubRuntime(board, runner, { gates }), {
            ...job(1, 'sess-prev'),
            claimSeq: 5,
            supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:1/', [SUPERVISOR_ENV.controlToken]: 'tok' },
        });

        expect(board.sessionEvidence).not.toContain(true);
    });

    it('a failing launch report never fails or ends the run', async () => {
        const board = stubBoard([], { failSession: true }).board;
        await runJob(
            stubRuntime(
                board,
                stubRunner(async (_job, _session, onOutput) => {
                    onOutput?.('x');
                    return ok();
                })
            ),
            job(1)
        );

        expect(board.completed).toHaveLength(1);
        expect(board.completed[0]).toMatchObject({ status: 'succeeded' });
    });
});
