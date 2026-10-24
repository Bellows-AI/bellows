import { describe, expect, it, vi } from 'vitest';
import type { BoardJob, Reclaim, ReclaimRenewal } from '../../src/board/board.js';
import type { DeadService, RunOutcome, RunSession, Runner } from '../../src/runner.js';
import { AdoptionBlocked } from '../../src/runner.js';
import { StartupRefused } from '../../src/startup-cause.js';
import type { ReclaimResult } from '../../src/publish/publish.js';
import { createLoop, wait } from '../../src/loop/loop.js';
import { processReclaim, type ReclaimContext } from '../../src/loop/loop-reclaim.js';
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
    USER,
} from '../fixtures/loop-stubs.js';

/** A queue row's acquisition token, never its id (issue #821). */
const ROW_TOKEN = '77777777-7777-4777-8777-777777777777';

describe('the poll loop', () => {
    it('claims a job, runs it and reports success', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'done',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    it('reports a non-zero exit as a failure, with the output', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 2, output: 'boom' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({
            status: 'failed',
            exitCode: 2,
            output: 'boom',
            failureKind: 'runner_error',
        });
    });

    /**
     * A zero exit code is not proof of completion. opencode exits 0 when the model's context
     * limit cuts a task short mid-investigation — the only tell is the finish reason the runner
     * scrapes from the session database at close. Reported as a failure with the reason, so a
     * green verdict never hangs over work nothing was finished on; `stop`, and every runner
     * that scrapes nothing, keep the exit code in charge.
     */
    it('fails a run whose finish reason says it never completed, despite exit 0', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ output: 'reads only', finishReason: 'length' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 0, failureKind: 'runner_error' });
        expect(board.board.completed[0]?.output).toContain('finish reason: "length"');
    });

    /**
     * The finish reason says the run stopped talking; the session's last provider error says WHY.
     * Observed 2026-09-11: a 429 rate limit cut a run off mid-tool-call and the verdict named
     * only "tool-calls", sending its reader into the session database for the cause. When the
     * scrape carried an error, the note names it.
     */
    it('names the provider error beside the premature stop, when the scrape carried one', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({
                output: 'reads only',
                finishReason: 'tool-calls',
                providerError: 'Error from provider (Console): Rate limit exceeded. Please try again later.',
            })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', exitCode: 0 });
        expect(board.board.completed[0]?.output).toContain('finish reason: "tool-calls"');
        expect(board.board.completed[0]?.output).toContain('Rate limit exceeded. Please try again later.');
    });

    // A run that finished cleanly is not explained by an error it already retried through — the
    // provider error is only the premature stop's cause, never a healthy verdict's footnote.
    it('leaves a stopped run’s provider error out of the verdict', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({ finishReason: 'stop', providerError: 'Error from provider (Console): Rate limit exceeded.' })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });
        expect(board.board.completed[0]?.output).not.toContain('Rate limit exceeded');
    });

    it('keeps a stop finish a success, whatever the session scrape reads', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ finishReason: 'stop' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', exitCode: 0 });
    });

    // The context the run reached rides the verdict: the finished row carries it beside its
    // vitals, which is where "died at a full window" is legible.
    it('reports the scraped context stats with the verdict', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ finishReason: 'stop', contextTokens: 90433, costUsd: 0.31 }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({
            status: 'succeeded',
            contextTokens: 90433,
            contextCostUsd: 0.31,
        });
    });

    // The first job's runner reads a value and it rides the report; the second job's runner read
    // nothing, so the field stays OFF the wire entirely and the board stores unmeasured / null —
    // the never-zero contract holds on the driver's side too.
    it.each([
        ['reports the close-time agent-turn count with the verdict, and never a non-number', 'agentTurns', 11],
        // What the run did, in the agent's own words.
        [
            'reports the run summary with the verdict, and nothing when the read lifted none',
            'summary',
            'Fixed the failing gates',
        ],
    ] as const)('%s', async (_label, field, value) => {
        const board = stubBoard([job(1), job(2)]);
        let ran = 0;
        const runner = stubRunner(async () => (ran++ === 0 ? ok({ [field]: value }) : ok()));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', [field]: value });
        expect(board.board.completed[1]).not.toHaveProperty(field);
    });

    // An opencode run always leaves a session, so an empty scrape is a failed readout — said out
    // loud, because a silently-lost session presents later as "this run cannot take a follow-up"
    // with nothing anywhere naming why.
    it('says so when an opencode run closes with no session scraped', async () => {
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }]);
        const runner = stubRunner(async () => ok({ finishReason: 'stop', contextTokens: 1200, costUsd: 0 }));
        const logs: string[] = [];
        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(logs.some((m) => m.includes('the session readout came up empty'))).toBe(true);
    });

    // The container is already dead by the time this lands; the note is the only place a reader
    // learns the run was cut off rather than having genuinely failed.
    it('says so when it killed the runner on the timeout', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 137, output: 'partial', timedOut: true }));

        await drive({ ...board, runner }, { DRIVER_JOB_TIMEOUT_MS: '60000' });

        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('killed after 60000ms');
        expect(board.board.completed[0]?.output).toContain(' — idle: no output');
        expect(board.board.completed[0]?.failureKind).toBe('timeout');
    });

    // The active/idle distinction (issue #339): a run whose tail was still moving when the wall
    // clock ran out was WORKING — the note must say so, with the last activity line, not leave
    // the reader to raw-SQL three sources to find out.
    it('says a timed-out run was still active when its output was still arriving', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('Now the two wording fixes:');
            return ok({ exitCode: 137, output: 'partial', timedOut: true });
        });

        await drive({ ...board, runner }, { DRIVER_JOB_TIMEOUT_MS: '60000' });

        expect(board.board.completed[0]?.status).toBe('failed');
        expect(board.board.completed[0]?.output).toContain('killed after 60000ms — still active: last output');
        expect(board.board.completed[0]?.output).toContain('last activity "Now the two wording fixes:"');
    });

    // The declared gates run AFTER the kill — a suite can take minutes — and the note must not
    // age the last output from VERDICT time: a run that was streaming when it died would read
    // idle because its gates were slow. Observed against the first cut of the note, which did.
    it('ages the timeout note from the run’s end, not the verdict the slow gates delay', async () => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('still writing');
            return ok({ exitCode: 137, output: 'partial', timedOut: true });
        });
        const { gates, stack } = stubGateStack();
        stack.manager.runGate = async () => {
            await new Promise((resolve) => setTimeout(resolve, 2_500));
            return { exitCode: 0, output: 'ok' };
        };

        await drive({ ...board, runner, gates });

        expect(board.board.completed[0]?.failureKind).toBe('timeout');
        // The output was stamped the instant the run resolved; aged from the run's end the age
        // is ~0. Aged from the verdict — the bug — it would read the gates' 2.5s as "2s".
        expect(board.board.completed[0]?.output).toContain(' — still active: last output 0s ago');
    });

    // Instructions are not enforcement: the deterministic publish runs after a succeeded run,
    // and its result changes the verdict — work that landed nowhere is not a success.
    it('publishes a succeeded run and says where the work landed', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            publish: {
                ok: true,
                published: true,
                branch: 'fix/10',
                prUrl: 'https://github.com/Bellows-AI/factory/pull/42',
                reason: null,
                cause: null,
                repository: 'Bellows-AI/factory',
                baseBranch: 'main',
                prNumber: 42,
            },
        });

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(1);
        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(board.board.completed[0]?.output).toContain(
            '[driver] published fix/10 — https://github.com/Bellows-AI/factory/pull/42'
        );
        // The structured identity of the publication rides the verdict — the board records what
        // a thread shipped, and review traffic and the thread's wait key on it.
        expect(board.board.completed[0]?.publication).toEqual({
            repo: 'Bellows-AI/factory',
            prNumber: 42,
            prUrl: 'https://github.com/Bellows-AI/factory/pull/42',
            headBranch: 'fix/10',
            baseBranch: 'main',
        });
    });

    // A no-op publish — clean tree, nothing unpushed — invents no publication: the board must
    // not record a thread as having shipped a PR it did not.
    it('reports no publication when the publish is a no-op', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            publish: {
                ok: true,
                published: false,
                branch: null,
                prUrl: null,
                reason: 'no uncommitted changes and nothing unpushed',
                cause: null,
                repository: null,
                baseBranch: null,
                prNumber: null,
            },
        });

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(board.board.completed[0]?.publication).toBeUndefined();
    });

    it('fails the verdict when the publish does not land', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            publish: {
                ok: false,
                published: false,
                branch: null,
                prUrl: null,
                reason: 'git step failed: authentication refused',
                cause: 'conflict',
                repository: null,
                baseBranch: null,
                prNumber: null,
            },
        });

        await drive({ ...board, runner });

        // Issue #581: the publish's cause rides beside the kind.
        expect(board.board.completed[0]).toMatchObject({
            status: 'failed',
            failureKind: 'publish',
            failureCause: 'conflict',
        });
        expect(board.board.completed[0]?.output).toContain(
            '[driver] publish failed — the work did not land: git step failed: authentication refused'
        );
    });

    // The publish flag is the board's decision: on a workflow task only the graph's publish node
    // may push, so a mid-loop review's clean run must NOT — no publish containers/Job, and no
    // credential ask either (docs/workflows.md). Both executors read this one claim field.
    it('skips the publish when the claim says publish: false', async () => {
        const claimed = { ...job(1), publish: false };
        const board = stubBoard([claimed]);
        const runner = stubRunner(async () => ok(), {
            publish: {
                ok: true,
                published: true,
                branch: 'fix/10',
                prUrl: 'https://github.com/Bellows-AI/factory/pull/42',
                reason: null,
                cause: null,
                repository: 'Bellows-AI/factory',
                baseBranch: 'main',
                prNumber: 42,
            },
        });

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(0);
        expect(board.board.githubAsks).toHaveLength(0);
        // The run itself still succeeded — the work stays on the task branch in the worktree.
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    // A claim without the flag is a board that predates it: publish exactly as before, so an old
    // board and a new driver — or a workflow-less task on the new board — behave byte-identically.
    it('publishes when the claim carries no publish flag at all', async () => {
        const claimed = { ...job(1) };
        delete (claimed as Partial<BoardJob>).publish;
        const board = stubBoard([claimed]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(1);
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    // Issue #503: an agent-less node (`agent: false`, the merge-conflict block's verify) is the
    // driver's own gates + publish — never a runner session, a reported session or a scraped one.
    it('runs no agent for a claim with agent: false, yet still publishes and succeeds', async () => {
        const board = stubBoard([{ ...job(1), agent: false }]);
        let runs = 0;
        const runner = stubRunner(async () => {
            runs += 1;
            return ok();
        });
        const released: string[] = [];
        runner.releaseFence = async (fencedJob) => {
            released.push(fencedJob.id);
        };

        await drive({ ...board, runner });

        expect(runs).toBe(0);
        // The setup phase starts the declared services for every attempt, agent or not, once —
        // and the agent-less path hands the checkout claim back exactly once.
        expect(runner.startedServices).toEqual([job(1).id]);
        expect(released).toEqual([job(1).id]);
        expect(board.board.sessions).toEqual([]);
        expect(runner.published).toHaveLength(1);
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    // The claim carries no GitHub token (docs/connections.md): the loop asks the board for one
    // right before the push, so a run that outlived any earlier token still publishes.
    it("publishes with the board's token minted for the push", async () => {
        const claimed = { ...job(1), env: { CORE: 'claim-value' } };
        const board = stubBoard([claimed], { githubToken: 'ghs_fresh' });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.githubAsks).toEqual([job(1).id]);
        // The credential rides the runner call; laying it into the publish steps' env is the
        // transport's job (`supervisedStepRunner`), pinned by the supervised-steps suite.
        expect(runner.githubTokens).toEqual(['ghs_fresh']);
    });

    it('publishes without a token, and says so, when the board issues none', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        const logs: string[] = [];

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(board.board.githubAsks).toEqual([job(1).id]);
        expect(runner.githubTokens).toEqual([undefined]);
        // Null is both the board's "no App installation" and every failure shape: the degradation
        // says itself either way.
        expect(logs.some((m) => m.includes('the board issued no GitHub token for the publish'))).toBe(true);
    });

    it("hands a starting claim's sync a token minted for it, and asks nothing for a restore", async () => {
        const repoJob = { ...job(1), repo: 'Bellows-AI/factory', publish: false };
        const board = stubBoard([repoJob], { githubToken: 'ghs_sync' });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(runner.syncTokens).toEqual(['ghs_sync']);
        expect(board.board.githubAsks).toEqual([job(1).id]);

        // A follow-up restores its tree: nothing touches the remote, so nothing is asked.
        const restoring = stubBoard(
            [{ ...job(2, 'session-x'), repo: 'Bellows-AI/factory', followUp: true, publish: false }],
            {
                githubToken: 'ghs_unused',
            }
        );
        const restoreRunner = stubRunner(async () => ok());
        await drive({ ...restoring, runner: restoreRunner });
        expect(restoreRunner.syncTokens).toEqual([undefined]);
        expect(restoring.board.githubAsks).toEqual([]);
    });

    // Only a succeeded run publishes: a failed or truncated run's tree may be mid-thought, and
    // pushing it would publish work the author never saw a verdict on.
    it('does not publish a run that did not succeed', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 2, output: 'boom' }));

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(0);
    });

    it('does not publish a run that stopped talking early', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ finishReason: 'length' }));

        await drive({ ...board, runner });

        expect(runner.published).toHaveLength(0);
        expect(board.board.completed[0]?.status).toBe('failed');
    });

    // The checkout is synced before anything reads it — the run itself included. A sync failure
    // is the author's environment naming itself, and the run never starts on a tree of unknown
    // state.
    it('syncs the checkout before the run', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(runner.synced).toEqual([job(1)]);
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    // A pre-run refusal is the driver's own environment failing, never the agent's work: nothing
    // syncs, no runner is reached, and the verdict names its kind (issue #339). A refused executor
    // selection is deterministic — config, so the board rests the thread and a batch asks a person
    // rather than retrying it as a transient runner error.
    const suspendedReason = 'The personal executor "main" is suspended. Resume it or choose another executor.';
    const skillsReason =
        '[skills unavailable] skill "jira" needs the jira connection: set ATLASSIAN_SITE. Fix this, then retry the task.';
    const planReason = '.bellows.yaml line 3: unknown key "timeout". Fix the file, then retry the task.';
    it.each<[string, BoardJob, unknown, 'config' | 'runner_error']>([
        [
            'fails a task whose selected executor profile no longer resolves, before anything runs',
            { ...job(1), executorType: null },
            expect.stringContaining('selected executor no longer exists'),
            'config',
        ],
        // Issue 440: the loop is shared by the docker and kubernetes executors, so one refusal here is
        // both executors' — the board's sentence reaches the task, and no runner is ever reached.
        [
            'fails a task whose executor profile is suspended with the board’s reason, before anything runs',
            { ...job(1), executorType: null, executorRefusal: suspendedReason },
            suspendedReason,
            'config',
        ],
        // Issue #545: the same shared loop serves both executors, so one refusal here is both
        // executors' — a recoverable config failure carrying the board's sentence, no runner reached.
        [
            'fails a task whose selected skills are unavailable as config with the board’s reason, before anything runs',
            { ...job(1), skillRefusal: skillsReason },
            skillsReason,
            'config',
        ],
        // Issue #769: the execution plan the board resolved at claim time is refused the same way,
        // as config with the board's sentence — never a retry of a file that cannot change.
        [
            'fails a task whose execution plan does not resolve as config with the board’s reason, before anything runs',
            { ...job(1), planRefusal: planReason },
            planReason,
            'config',
        ],
        // Issue #244: the board always renders a master prompt for every agent claim, so a missing
        // one is a contract violation the driver refuses explicitly, before any setup — never a run
        // with no Factory execution context.
        [
            'fails a task with no master prompt, before anything runs',
            { ...job(1), masterPrompt: null },
            expect.stringContaining('no Factory execution context'),
            'runner_error',
        ],
        // The same no-fallback rule the null workspacePath refusal applies, extended to the task
        // worktree (issue #35): a repo-shaped label this driver cannot resolve a worktree path for
        // is failed with a reason, never run in a fallback location.
        [
            'fails a repo job whose worktree path cannot be resolved, before anything runs',
            { ...job(1), repo: 'Bellows-AI/factory', rootJobId: 'not-a-uuid' },
            expect.stringContaining('do not resolve to a task worktree'),
            'runner_error',
        ],
    ])('%s', async (_label, claimed, output, failureKind) => {
        const board = stubBoard([claimed]);
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });

        await drive({ ...board, runner });

        expect(runner.synced).toHaveLength(0);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind, output });
    });

    it('launches nothing for a plan refusal: no sync, no services, no gate environment, no agent', async () => {
        const board = stubBoard([
            {
                ...job(1),
                repo: 'Bellows-AI/factory',
                services: [{ name: 'db', image: 'postgres:16', environment: [] }],
                planRefusal: planReason,
            },
        ]);
        const stack = stubGateStack();
        let ran = 0;
        const runner = stubRunner(async () => {
            ran += 1;
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(ran).toBe(0);
        expect(runner.synced).toHaveLength(0);
        expect(runner.startedServices).toEqual([]);
        expect(stack.stack.acquired).toEqual([]);
        expect(board.board.gatesReported).toEqual([]);
        expect(board.board.completed).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'config' });
        expect(board.board.completed[0]?.output).toContain(planReason);
    });

    it('fails the attempt with the reason when the checkout sync fails', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            sync: {
                ok: false,
                reason: 'the task branch could not be rebased onto origin/main: conflict in driver/src/loop/loop.ts',
            },
        });

        await drive({ ...board, runner });

        expect(runner.synced).toHaveLength(1);
        // The run never started on an unknown tree — and an unnamed sync refusal is the driver's
        // environment, not the agent's work (issue #339).
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(board.board.completed[0]?.output).toContain('could not be synced with the remote');
        expect(board.board.completed[0]?.output).toContain('conflict in driver/src/loop/loop.ts');
    });

    // A poll that exhausted its patience is infrastructure, not a verdict (issue #308): the
    // exhaustion arrives as a THROW from syncCheckout, and the loop's catch leaves the job to its
    // lease — the same arm a stand-down takes — never a terminal `failed` with attempts left.
    it('leaves the job to its lease when the checkout sync poll exhausts — never reports failed', async () => {
        const board = stubBoard([job(1)]);
        const logs: string[] = [];
        const runner = stubRunner(async () => ok(), {
            syncError: new Error('reading the worktree sync job answered 400 15 times in a row: 400 Bad Request'),
        });

        await drive({ ...board, runner, log: (message) => logs.push(message) });

        expect(runner.synced).toHaveLength(1);
        expect(board.board.completed).toEqual([]);
        expect(logs.some((message) => message.includes('checkout sync threw, leaving it to the lease'))).toBe(true);
    });

    it('fails a claim declaring a refused package cache name before any sync', async () => {
        const board = stubBoard([{ ...job(1), gates: { image: 'node:24', cache: ['NODE_OPTIONS'], gates: [] } }]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(runner.synced).toHaveLength(0);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'config' });
        expect(board.board.completed[0]?.output).toContain('package cache');
    });

    // The terminal reclaim (issue #47, revised): after the thread is DONE — every member terminal
    // AND the user's done on one of them, the board says so in the same breath as the verdict —
    // the per-thread task worktree is removed. A thread that merely finished keeps its tree: the
    // tree is the user's to free, and a failed task's tree is what its next turn continues from.
    it('reclaims the task worktree when the complete answer says the thread is done, then acks the reclaim', async () => {
        const board = stubBoard([job(1)], { reclaimId: 'reclaim-1' });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(runner.reclaimed).toEqual([job(1)]);
        // The board stamps the reclaimed marker on this ack, never on the verdict (issue #821).
        expect(board.board.reclaimAcks).toEqual(['reclaim-1']);
    });

    // Issue #821: the verdict's answer is a settle receipt, so a complete whose response was lost
    // is retried into the original answer — the reclaim it ordered still runs and is acked.
    it('reclaims on the replayed answer of a verdict whose first response was lost', async () => {
        let calls = 0;
        const board = stubBoard([job(1)], {
            completeFor: () => {
                calls += 1;
                if (calls === 1) throw new Error('socket hang up');
                return { state: 'held', reclaimId: 'reclaim-1' };
            },
        });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed).toHaveLength(2);
        expect(runner.reclaimed).toEqual([job(1)]);
        expect(board.board.reclaimAcks).toEqual(['reclaim-1']);
    });

    it('keeps the task worktree when the complete answer says the thread is not done', async () => {
        // The default answer is "the thread is not done" — a follow-up still queued, or a
        // finished thread the user has not closed. No reclaim attempt is made at all: the tree
        // belongs to a thread that might continue, or to a user who has not said done.
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(runner.reclaimed).toHaveLength(0);
    });

    it('reclaims after a pre-run failure, once the whole thread is done', async () => {
        // A job whose checkout cannot be synced is completed failed without ever running; the
        // reclaim is the same downstream-of-the-verdict step it is for a run.
        const repoJob = { ...job(1), repo: 'Bellows-AI/factory', workspacePath: `bellows/${USER}` };
        const board = stubBoard([repoJob], { reclaimId: 'reclaim-1' });
        const runner = stubRunner(async () => ok(), { sync: { ok: false, reason: 'no disk' } });

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.status).toBe('failed');
        expect(runner.synced).toHaveLength(1);
        expect(runner.reclaimed).toEqual([repoJob]);
    });

    // Issue #666: a sync refusal the script names is deterministic — config, with its message
    // intact; anything unnamed (a conflict, a stray error) stays infrastructure.
    it.each([
        ['branch_unrestorable', 'the task branch factory/x could not be restored (re-queue the task)', 'config'],
        ['missing_base_branch', 'the base branch origin/batch-sandbox does not exist on the remote', 'config'],
        [undefined, 'the task worktree could not be rebased onto origin/main: conflict', 'runner_error'],
    ] as const)('reports a sync refusal of kind %s as %s', async (kind, reason, failureKind) => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), { sync: { ok: false, reason, ...(kind ? { kind } : {}) } });

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind });
        expect(board.board.completed[0]?.output).toContain(reason);
    });

    // Issue #661: a conflict the sync left in the tree is not a refusal — the agent runs, with the
    // conflicting paths appended to the turn context the board sent.
    it('starts the run with the conflicting paths in its turn context when the sync leaves a conflict', async () => {
        const board = stubBoard([{ ...job(1), turnContext: 'Factory turn context' }]);
        let seen: string | undefined;
        const runner = stubRunner(
            async (j) => {
                seen = j.turnContext;
                return ok();
            },
            { sync: { ok: true, reason: null, conflicts: ['src/a.ts', 'src/b.ts'] } }
        );

        await drive({ ...board, runner });

        expect(seen).toContain('Factory turn context');
        expect(seen).toContain('- src/a.ts\n- src/b.ts');
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    it('leaves the turn context alone when the sync found no conflict', async () => {
        const board = stubBoard([{ ...job(1), turnContext: 'Factory turn context' }]);
        let seen: string | undefined;
        const runner = stubRunner(
            async (j) => {
                seen = j.turnContext;
                return ok();
            },
            { sync: { ok: true, reason: null } }
        );

        await drive({ ...board, runner });

        expect(seen).toBe('Factory turn context');
    });

    it.each([
        [
            'reports the verdict untouched when the reclaim refuses, and logs the reason',
            {
                ok: false,
                removed: false,
                reason: 'refusing to remove /workspaces/bellows/44444444-4444-4444-8444-444444444444/.worktrees/0000000',
            },
            null,
            'task worktree could not be reclaimed',
        ],
        [
            'reports the verdict untouched when the reclaim throws, and logs the error',
            undefined,
            new Error('daemon refused'),
            'daemon refused',
        ],
    ] as const)('%s', async (_label, reclaim, thrown, logged) => {
        const logs: string[] = [];
        const board = stubBoard([job(1)], { reclaimId: 'reclaim-1' });
        const runner = stubRunner(async () => ok(), { reclaim });
        if (thrown) {
            runner.reclaimWorktree = async () => {
                throw thrown;
            };
        }
        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(board.board.completed[0]?.status).toBe('succeeded');
        expect(logs.some((m) => m.includes(logged))).toBe(true);
        // Unacked: the row is the queue's again once its lease expires.
        expect(board.board.reclaimAcks).toEqual([]);
    });

    it('does not reclaim a job whose verdict was lost to the board', async () => {
        // 409 means the tree belongs to whoever holds the lease now — and the board's terminality
        // answer rides that refusal as false, so nothing is removed on either ground.
        const board = stubBoard([job(1)], { completeLease: 'lost' });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(runner.reclaimed).toHaveLength(0);
    });

    /**
     * The reclaim race (greptile #3988007814), same-driver half: the board said "thread terminal",
     * the removal started — and a follow-up created in that window gets claimed and syncs against
     * the very tree being deleted. The in-driver barrier makes the follow-up wait out the
     * in-flight removal before its startup sync, which is the first touch of the task worktree.
     */
    it('waits out an in-flight reclaim of the same thread before a follow-up syncs', async () => {
        const root = job(1).id;
        const followUp: BoardJob = { ...job(2), followUp: true, resumeSessionId: 'ses_follow-up', rootJobId: root };
        const events: string[] = [];
        let releaseReclaim = () => {};
        const reclaimGate = new Promise<void>((resolve) => {
            releaseReclaim = resolve;
        });
        const board = stubBoard([job(1), followUp], {
            completeFor: (claimed) =>
                claimed.id === job(1).id
                    ? { state: 'held', reclaimId: 'reclaim-1' }
                    : { state: 'held', reclaimId: null },
        });
        const runner = stubRunner(async () => ok());
        runner.reclaimWorktree = async (claimed) => {
            runner.reclaimed.push(claimed);
            events.push(`reclaim-start:${claimed.id}`);
            await reclaimGate;
            events.push(`reclaim-done:${claimed.id}`);
            return { ok: true, removed: true, reason: null };
        };
        const realSync = runner.syncCheckout.bind(runner);
        runner.syncCheckout = async (claimed) => {
            events.push(`sync:${claimed.id}`);
            return realSync(claimed);
        };

        const started = drive({ ...board, runner }, { DRIVER_CONCURRENCY: '1' });
        // Let the root job finish, its verdict land and its reclaim start — then give the loop a
        // beat to claim the follow-up and park it on the barrier.
        for (let i = 0; i < 50 && !events.includes(`reclaim-start:${job(1).id}`); i += 1) await sleep();
        await sleep();
        await sleep();
        expect(events).toContain(`reclaim-start:${job(1).id}`);
        // The follow-up has been claimed but has NOT synced: the removal of its thread's tree is
        // still in flight.
        expect(events).not.toContain(`sync:${followUp.id}`);

        releaseReclaim();
        await started;

        // The follow-up synced only after the removal settled — never against a tree mid-deletion.
        expect(events.indexOf(`reclaim-done:${job(1).id}`)).toBeLessThan(events.indexOf(`sync:${followUp.id}`));
        expect(board.board.completed).toHaveLength(2);
        expect(runner.reclaimed).toEqual([job(1)]);
    });

    /**
     * The barrier is a set-and-clear cycle, not a one-shot latch: once a reclaim settles its
     * entry is dropped, so the next reclaim of the same thread registers afresh and claimants
     * wait on the CURRENT removal — never on a stale one, and never forever (a hung suite here is
     * a leaked entry). A settled entry would also be harmless to await, which is why this is
     * pinned by the full chain running to completion rather than by timing alone.
     */
    it('drops the barrier entry when the reclaim settles, so the next reclaim of the thread registers afresh', async () => {
        const root = job(1).id;
        const firstFollowUp: BoardJob = { ...job(2), followUp: true, resumeSessionId: 'ses_two', rootJobId: root };
        const secondFollowUp: BoardJob = { ...job(3), followUp: true, resumeSessionId: 'ses_three', rootJobId: root };
        const events: string[] = [];
        const resolvers = new Map<string, () => void>();
        const gatePromises = new Map<string, Promise<void>>();
        const makeGate = (id: string) => {
            gatePromises.set(
                id,
                new Promise<void>((resolve) => {
                    resolvers.set(id, resolve);
                })
            );
        };
        makeGate(job(1).id);
        makeGate(firstFollowUp.id);
        const board = stubBoard([job(1), firstFollowUp, secondFollowUp], {
            completeFor: (claimed) => ({
                state: 'held',
                reclaimId: claimed.id !== secondFollowUp.id ? `reclaim-${claimed.id}` : null,
            }),
        });
        const runner = stubRunner(async () => ok());
        runner.reclaimWorktree = async (claimed) => {
            runner.reclaimed.push(claimed);
            events.push(`reclaim-start:${claimed.id}`);
            await gatePromises.get(claimed.id);
            events.push(`reclaim-done:${claimed.id}`);
            return { ok: true, removed: true, reason: null };
        };
        const realSync = runner.syncCheckout.bind(runner);
        runner.syncCheckout = async (claimed) => {
            events.push(`sync:${claimed.id}`);
            return realSync(claimed);
        };

        const started = drive({ ...board, runner }, { DRIVER_CONCURRENCY: '1' });
        // Root's removal in flight; release it so the first follow-up can go.
        for (let i = 0; i < 50 && !events.includes(`reclaim-start:${job(1).id}`); i += 1) await sleep();
        resolvers.get(job(1).id)?.();
        // The first follow-up's own reclaim must now be the live barrier — registered afresh,
        // after the root's entry was dropped.
        for (let i = 0; i < 50 && !events.includes(`reclaim-start:${firstFollowUp.id}`); i += 1) await sleep();
        await sleep();
        await sleep();
        expect(events).not.toContain(`sync:${secondFollowUp.id}`);
        resolvers.get(firstFollowUp.id)?.();

        await started;

        expect(events.indexOf(`reclaim-done:${job(1).id}`)).toBeLessThan(events.indexOf(`sync:${firstFollowUp.id}`));
        expect(events.indexOf(`reclaim-done:${firstFollowUp.id}`)).toBeLessThan(
            events.indexOf(`sync:${secondFollowUp.id}`)
        );
        expect(board.board.completed).toHaveLength(3);
        expect(runner.reclaimed).toEqual([job(1), firstFollowUp]);
    });

    // The cache watch killed the run mid-tool-call, so the scrape reads finish `tool-calls` — the
    // cache note must tell the whole story on its own, without the premature-stop note stacking a
    // second suspected cause on top.
    it('says so when the cache watch killed the run, and only says that', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({
                exitCode: 137,
                output: 'partial',
                finishReason: 'tool-calls',
                cacheLost: '3 consecutive turns with no prompt-cache reads (input 84k/80k/63k tokens, 150-250s each)',
            })
        );

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'cache_lost' });
        const output = board.board.completed[0]?.output ?? '';
        expect(output).toContain('[driver] killed — the model provider stopped serving prompt cache');
        expect(output).toContain('3 consecutive turns with no prompt-cache reads');
        expect(output).toContain('Retry when the cache is healthy again');
        expect(output).not.toContain('ended before it finished');
    });

    it.each([
        // The whole reason the heartbeat exists: two containers must not go on writing to one checkout.
        ['kills the container and reports nothing once the lease is lost', { lease: 'lost' }, []],
        // A Stop (issue #41) is a park, not an end: the board stamps the running row with the flag,
        // the heartbeat carries it back, and the container is killed so the run stops editing the
        // checkout — but the job goes back on the board, session intact, for a human to resume from
        // the Claude UI. Exactly the landing an idle run gets, and reporting nothing lets it stay
        // there.
        [
            'kills the container and parks the job when the heartbeat reports a stop request',
            { cancelRequested: true },
            [job(1).id],
        ],
        // Remove's defensive half this side of the fence: the only way a heartbeat sees a 404 is the
        // board having deleted the thread while this attempt ran. The container dies, and nothing is
        // parked or reported — there is no row left to park and nobody left to read a verdict. (The
        // server refuses to remove a running thread, so this is a race the server already closes; the
        // driver still answers the status rather than reading it as a broken board.)
        [
            'kills the container and reports nothing when the board says the thread was removed',
            { removedOnBeat: true },
            [],
        ],
    ] as const)('%s', async (_label, beat, suspended) => {
        const board = stubBoard([job(1)], beat);
        let finish = () => {};
        const runner = stubRunner(
            () =>
                new Promise<RunOutcome>((resolve) => {
                    finish = () => resolve(ok());
                })
        );

        const started = drive({ ...board, runner });
        // Let the heartbeat land its verdict before the run is allowed to end.
        await new Promise((resolve) => setTimeout(resolve, 5));
        finish();
        await started;

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual(suspended);
        expect(board.board.completed).toEqual([]);
    });

    // The Stop's own kill can leave the runner reading as lost (its supervisor taken down with it):
    // the Stop settles first, so the job parks — never an interruption, never a verdict.
    it('parks a stopped job whose killed runner reports an infrastructure loss', async () => {
        const board = stubBoard([job(1)], { cancelRequested: true });
        let finish = () => {};
        const runner = stubRunner(
            () =>
                new Promise<RunOutcome>((resolve) => {
                    finish = () =>
                        resolve(
                            ok({ exitCode: 137, infraLoss: 'the task supervisor ended before it finalized the run' })
                        );
                })
        );

        const started = drive({ ...board, runner });
        await new Promise((resolve) => setTimeout(resolve, 5));
        finish();
        await started;

        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.interrupted).toEqual([]);
        expect(board.board.completed).toEqual([]);
    });

    // A network blink is not evidence that the lease moved. The next heartbeat remains the
    // authority, while the in-flight runner keeps its checkout and can still report normally.
    it('keeps running through a transient heartbeat failure and recovers on the next beat', async () => {
        const board = stubBoard([job(1)]);
        const rawHeartbeat = board.board.heartbeat.bind(board.board);
        const logs: string[] = [];
        let calls = 0;
        board.board.heartbeat = async (claimed) => {
            calls += 1;
            if (calls === 1) throw new Error('board blink');
            return rawHeartbeat(claimed);
        };
        const runner = stubRunner(async () => {
            while (calls < 2) await sleep();
            return ok();
        });

        await drive({ ...board, runner, log: (message) => logs.push(message) });

        expect(runner.killed).toEqual([]);
        expect(board.board.completed).toHaveLength(1);
        expect(logs.filter((message) => message.includes('heartbeat failed, continuing'))).toHaveLength(1);
    });

    // The stop rides the heartbeat answer and nothing else (docs/architecture.md, "Polling is the
    // authority"): an answer lost in transit costs one beat, never the stop.
    it('acts on a stop raised while a heartbeat answer was lost at the next beat', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const rawHeartbeat = board.board.heartbeat.bind(board.board);
        let calls = 0;
        board.board.heartbeat = async (claimed) => {
            calls += 1;
            if (calls === 1) {
                options.cancelRequested = true;
                throw new Error('answer lost');
            }
            return rawHeartbeat(claimed);
        };
        let finish = () => {};
        const runner = stubRunner(
            () =>
                new Promise<RunOutcome>((resolve) => {
                    finish = () => resolve(ok());
                })
        );

        const started = drive({ ...board, runner, log: () => {} });
        while (calls < 2) await sleep();
        // Let the second beat land its verdict before the run is allowed to end.
        await new Promise((resolve) => setTimeout(resolve, 5));
        finish();
        await started;

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // The park is the follow-up's launching pad, and a stopped opencode run's session id is
    // learned only at close (the scrape) — so it must be reported BEFORE the park lands, while
    // the row still runs under this lease. After it, the row is terminal, the report is refused,
    // and the stopped task settles sessionless: nothing to follow up (issue #152).
    // The board's output for a parked run is the last tail it was streamed. A line the agent printed
    // between the runner's last poll and its end (the stop's own acknowledgement) is in the outcome
    // only, so the stand-down streams it before it parks (issue #773).
    it('streams the output a stopped run ended with before parking it', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const events: string[] = [];
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            events.push(`parked after ${board.board.progressed.map((p) => p.output).join('|')}`);
            return rawSuspend(claimed);
        };
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('waiting');
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok({ output: 'waiting\nstopped in the pod' });
        });

        await drive({ ...board, runner });

        expect(events).toEqual(['parked after waiting|waiting\nstopped in the pod']);
        expect(board.board.suspended).toEqual([job(1).id]);
    });

    // Codex review: the pump's periodic write may still be in flight when the run ends. The final
    // tail must land after it — never be overwritten by the older one — and the park must wait.
    it('lands the final output of a stopped run after a progress write still in flight, then parks', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const events: string[] = [];
        const rawProgress = board.board.progress.bind(board.board);
        board.board.progress = async (claimed, output, runtime) => {
            if (output === 'waiting') await new Promise((resolve) => setTimeout(resolve, 150));
            return rawProgress(claimed, output, runtime);
        };
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            events.push(`parked after ${board.board.progressed.map((p) => p.output).join('|')}`);
            return rawSuspend(claimed);
        };
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('waiting');
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok({ output: 'waiting\nstopped in the pod' });
        });

        await drive({ ...board, runner });

        expect(events).toEqual(['parked after waiting|waiting\nstopped in the pod']);
        expect(board.board.suspended).toEqual([job(1).id]);
    });

    it('reports the scraped session before parking a stopped opencode run', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }], options);
        const events: string[] = [];
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            events.push(`parked with ${board.board.sessions.length} session(s) reported`);
            return rawSuspend(claimed);
        };
        const runner = stubRunner(async () => {
            // The stop lands once the run is live: the first beats answer false, the ones after
            // this carry the flag, and the container is killed while the run is in flight.
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok({ sessionId: 'ses_stoppedrun00000000001' });
        });

        await drive({ ...board, runner });

        expect(board.board.sessions).toEqual([{ id: job(1).id, sessionId: 'ses_stoppedrun00000000001' }]);
        expect(events).toEqual(['parked with 1 session(s) reported']);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    it.each([
        // An opencode run ALWAYS leaves a session, so an empty scrape on a stopped run is the
        // readout having failed — said out loud on the stopped path too, because the cost is a
        // task that can never take a follow-up (issue #152).
        {
            label: 'says so when a stopped opencode run has no session to report',
            claimed: { ...job(1), executorType: 'opencode' as const },
            outcome: ok({ readoutError: 'the readout container failed: boom' }),
            sessions: 0,
            complains: true,
        },
        // A stopped claude-code run has no scrape and no empty-scrape notice: the session was minted
        // and reported at spawn — the one session counted — and the helper must not fire the
        // opencode-only complaint (issue #152).
        {
            label: 'reports nothing extra when a stopped claude-code run has no scraped session',
            claimed: job(1),
            outcome: ok(),
            sessions: 1,
            complains: false,
        },
    ])('$label', async ({ claimed, outcome, sessions, complains }) => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([claimed], options);
        const logs: string[] = [];
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return outcome;
        });

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(logs.some((m) => m.includes('the session readout came up empty'))).toBe(complains);
        expect(board.board.sessions).toHaveLength(sessions);
        expect(board.board.suspended).toEqual([job(1).id]);
    });

    // Issue #126: a stop issued while the dashboard says "Waiting for the executor…" — the claim
    // and setup phase, before any container exists — must stand the attempt down immediately.
    // With the flag already set at the first beat (which beats before sleeping, not after), the
    // attempt ends before the sync even starts: the runner never spawns and the park lands at
    // once.
    // A Remove racing the setup is answered the same way — nothing spawned, and nothing parked or
    // reported: the rows are gone and the tree belongs to the queue's reclaim. A lease lost during
    // setup leaves the job to its new holder: no verdict, no park.
    it.each([
        [
            'stands a job down before the runner spawns when the stop arrived during setup',
            { cancelRequested: true },
            [job(1).id],
        ],
        ['reports nothing when the thread is removed during setup', { removedOnBeat: true }, []],
        ['reports nothing when the lease is lost during setup', { lease: 'lost' }, []],
    ] as const)('%s', async (_label, beat, suspended) => {
        const board = stubBoard([job(1)], beat);
        let ran = false;
        const runner = stubRunner(async () => {
            ran = true;
            return ok();
        });

        await drive({ ...board, runner });

        expect(ran).toBe(false);
        expect(runner.synced).toEqual([]);
        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual(suspended);
        expect(board.board.completed).toEqual([]);
    });

    // The same, MID-SYNC: the checkout sync is the slowest thing an attempt does before the
    // runner exists (a fresh clone of a large repo), and the stop must not wait out the git. The
    // abandoned sync finishes on its own — its cleanup is its own — while the attempt parks.
    it('stands a job down while the checkout sync is still running, without spawning the runner', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        let seen: AbortSignal | undefined;
        runner.syncCheckout = async (_job, signal) => {
            // The stop lands while the sync is in flight.
            seen = signal;
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { ok: true, reason: null };
        };

        const started = drive({ ...board, runner });
        // Let the setup-poll heartbeat carry the stop in while the sync is pending.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await started;

        // The sync was handed the stand-down's signal and it fired (issue #488): aborted, not only raced.
        expect(seen?.aborted).toBe(true);
        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // A stop observed AFTER the sync has completed finds the checkout fenced and held — with no
    // run ever to release it, the fence goes back before the attempt stands down (kubernetes's
    // checkout claim would otherwise outlive the job).
    it('hands the checkout fence back when the stop lands after the sync', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        const fenced: string[] = [];
        runner.releaseFence = async (fencedJob) => {
            fenced.push(fencedJob.id);
        };
        const rawStart = runner.startServices.bind(runner);
        let seen: AbortSignal | undefined;
        runner.startServices = async (started, signal) => {
            // The stop lands after the sync, while the services start — slow enough for the
            // setup poll to carry the verdict in.
            seen = signal;
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return rawStart(started, signal);
        };

        await drive({ ...board, runner });

        // The start was handed the stand-down's signal and it fired (issue #488).
        expect(seen?.aborted).toBe(true);
        expect(fenced).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // And a stop that lands while the gate environment boots leaves no environment behind: the
    // release happens inside beginGates (or in the attempt's finally), never leaked.
    it('releases the gate environment when the stop lands while it boots', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const { stack, gates } = stubGateStack();
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        const rawAcquire = stack.manager.acquire.bind(stack.manager);
        let seen: AbortSignal | undefined;
        stack.manager.acquire = async (key, image, envBody, attempt) => {
            // The stop lands while the gate environment is coming up — slow enough for the
            // setup poll to carry the verdict in before the attempt can launch.
            seen = attempt?.signal;
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 30));
            await rawAcquire(key, image, envBody, attempt);
        };

        const started = drive({ ...board, runner, gates });
        // Let the setup-poll heartbeat carry the stop in while the acquire is pending.
        await new Promise((resolve) => setTimeout(resolve, 10));
        await started;
        // The abandoned beginGates settles on its own timer and releases the environment then.
        await new Promise((resolve) => setTimeout(resolve, 40));

        // The environment start was handed the stand-down's signal and it fired (issue #488).
        expect(seen?.aborted).toBe(true);
        expect(stack.released).toHaveLength(1);
        expect(stack.acquired).toHaveLength(1);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // The setup-phase kill is best-effort reclamation — no container was ever spawned. Awaited,
    // a slow or unresponsive daemon holds `beating`, and with it settle() and the stop's park,
    // past the setup poll period: the row sits `running` with nothing to wait out. The park must
    // land while the kill is still in flight, not after it.
    it('parks a stopped setup without waiting out the teardown kill', async () => {
        const board = stubBoard([job(1)], { cancelRequested: true });
        let releaseKill = () => {};
        let killSettled = false;
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        runner.kill = async (killed) => {
            runner.killed.push(killed.id);
            // Held until the park has landed: a stand-down that waits on this kill fails here.
            await new Promise<void>((resolve) => {
                releaseKill = () => {
                    killSettled = true;
                    resolve();
                };
            });
        };
        let parkedBeforeKill = false;
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            parkedBeforeKill = !killSettled;
            releaseKill();
            return rawSuspend(claimed);
        };

        await drive({ ...board, runner });

        expect(parkedBeforeKill).toBe(true);
        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    }, 2_000);

    // A stop that lands after beginGates has handed back a session but before the caller's own
    // down-check takes the early stand-down return skips the run try's cleanup finally — the
    // session this caller holds would stay registered and its environment never released. The
    // localized release must run before the fence goes back and the attempt stands down.
    it('releases the gate session when the stand-down lands after beginGates returns it', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const { stack, gates } = stubGateStack();
        const runner = stubRunner(async () => {
            throw new Error('the runner must not spawn');
        });
        // The first beat parks inside the board stub; advertiseUrl resolves it from inside
        // beginGates' final stretch — queuing the verdict's flag-set between beginGates' own
        // clean check and the caller's check, the exact window the leak lives in.
        let landBeat = () => {};
        const firstBeat = new Promise<void>((resolve) => {
            landBeat = resolve;
        });
        let beat = 0;
        const rawHeartbeat = board.board.heartbeat.bind(board.board);
        board.board.heartbeat = async (claimed) => {
            beat += 1;
            if (beat === 1) {
                await firstBeat;
                return { result: 'held', cancelRequested: true };
            }
            return rawHeartbeat(claimed);
        };
        gates.advertiseUrl = (port) => {
            landBeat();
            return `http://host.docker.internal:${port}`;
        };

        await drive({ ...board, runner, gates });

        expect(stack.registered).toBe(1);
        expect(stack.unregistered).toBe(1);
        expect(stack.released).toHaveLength(1);
        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // The other half of Remove (issue #41): the thread's rows are gone and the queue hands this
    // driver the tree to take down. The worktree is reclaimed through the same runner call a
    // terminal thread's report() uses, fed a job synthesised from the row's identity, and acked
    // once the tree is down so the row stops being offered.
    it('drains the board’s reclaim queue: removes the removed thread’s worktree and acks it', async () => {
        const rowId = '55555555-5555-4555-8555-555555555555';
        const root = job(1).id;
        const board = stubBoard([], {
            idleBeforeStop: 1,
            reclaims: [
                {
                    id: rowId,
                    token: ROW_TOKEN,
                    rootJobId: root,
                    repo: 'Bellows-AI/factory',
                    workspacePath: `bellows/${USER}`,
                    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
                },
            ],
        });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.reclaimGrants).toHaveLength(1);
        // The tree is reclaimed under the thread's identity — the job is the removed root, the
        // acquisition's own token rides as the lease token, never the row id: what holds the
        // checkout under kubernetes is this acquisition, not every acquisition of the row.
        expect(runner.reclaimed).toEqual([
            {
                id: root,
                command: '',
                attempts: 1,
                maxAttempts: 1,
                lastAttempt: true,
                claimSeq: 1,
                leaseToken: ROW_TOKEN,
                leaseExpiresAt: '2026-08-21T12:05:00.000Z',
                resumeSessionId: null,
                followUp: false,
                ownSession: false,
                continuesInterrupted: false,
                userId: null,
                workspacePath: `bellows/${USER}`,
                rootJobId: root,
                rootCommand: '',
                repo: 'Bellows-AI/factory',
                executorType: 'claude-code',
                executorRefusal: null,
                planRefusal: null,
                skillRefusal: null,
                masterPrompt: null,
            },
        ]);
        expect(board.board.reclaimAcks).toEqual([rowId]);
        expect(board.board.reclaimAckTokens).toEqual([ROW_TOKEN]);
        expect(board.board.reclaimRenewals[0]).toEqual({ id: rowId, token: ROW_TOKEN });
    });

    it('leaves a refused reclaim to its lease instead of acking it', async () => {
        const rowId = '55555555-5555-4555-8555-555555555555';
        const root = job(1).id;
        const logs: string[] = [];
        const board = stubBoard([], {
            idleBeforeStop: 1,
            reclaims: [
                {
                    id: rowId,
                    token: ROW_TOKEN,
                    rootJobId: root,
                    repo: null,
                    workspacePath: null,
                    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
                },
            ],
        });
        const runner = stubRunner(async () => ok());
        runner.reclaimWorktree = async () => ({ ok: false, removed: false, reason: 'the checkout is held' });
        await drive({ ...board, runner, log: (m) => logs.push(m) });

        // No ack: the row survives its lease and is offered again (and to other workers), while
        // the refusal is said out loud exactly as a refused terminal reclaim is.
        expect(board.board.reclaimAcks).toEqual([]);
        expect(logs.some((m) => m.includes('could not be reclaimed: the checkout is held'))).toBe(true);
    });

    // A transient board error after the tree is already down must not take the driver with it:
    // like a refused reclaim, a throwing ack is left to the lease — the row is re-offered when it
    // expires — and the drain loop goes on polling.
    it('survives a reclaim ack failure instead of crashing the drain loop', async () => {
        const rowId = '55555555-5555-4555-8555-555555555555';
        const root = job(1).id;
        const logs: string[] = [];
        const board = stubBoard([], {
            idleBeforeStop: 1,
            reclaims: [
                {
                    id: rowId,
                    token: ROW_TOKEN,
                    rootJobId: root,
                    repo: null,
                    workspacePath: null,
                    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
                },
            ],
            failAckReclaim: true,
        });
        const runner = stubRunner(async () => ok());
        await drive({ ...board, runner, log: (m) => logs.push(m) });

        // The ack never landed, so the row survives for its lease to expire and hand it back —
        // and start() resolved, where before the fix the rejection ended the driver.
        expect(board.board.reclaimAcks).toEqual([]);
        expect(logs.some((m) => m.includes('leaving it to the lease'))).toBe(true);
    });

    /*
     * The orphaned checkout claim (issue #344): a claim ConfigMap whose holder job the board no
     * longer knows stood every reclaim of the removed thread down forever — nothing else can see
     * a bare ConfigMap, so the reclaim loop is the only cleaner. The proof is the board's own
     * lease lookup, never a clock; the reap is uid-preconditioned in the runner; and the failure
     * lines throttle to state changes so a stuck row does not log an identical line every poll.
     */
    /*
     * Reclaim ownership (issue #821): every acquisition of a reclaim row holds it under a token of
     * its own, and a removal can run far longer than the lease its claim granted — so the loop
     * renews the row under that token, once before the removal starts (the gate: a row this
     * acquisition no longer owns is never touched) and at the heartbeat's pace while it runs.
     */
    describe('reclaim ownership', () => {
        const rowId = '55555555-5555-4555-8555-555555555555';
        const root = job(1).id;
        const row: Reclaim = {
            id: rowId,
            token: ROW_TOKEN,
            rootJobId: root,
            repo: 'Bellows-AI/factory',
            workspacePath: `bellows/${USER}`,
            leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        };
        const removedOk: ReclaimResult = { ok: true, removed: true, reason: null };
        const ctxOf = (board: BoardStub, runner: Runner, logs: string[]): ReclaimContext => ({
            board,
            runner,
            config: config(),
            log: (m) => logs.push(m),
            sleep,
            failureLog: new Map(),
        });
        /** A removal that runs until released, recording when it started. */
        const gatedRemoval = (runner: ReturnType<typeof stubRunner>, events: string[]) => {
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            runner.reclaimWorktree = async (removed) => {
                runner.reclaimed.push(removed);
                events.push('removal');
                await held;
                return removedOk;
            };
            return () => release();
        };

        it('renews the row under its acquisition token before the removal and while it runs, never after it settles', async () => {
            const events: string[] = [];
            const logs: string[] = [];
            const { board } = stubBoard([], {
                renewReclaim: async () => {
                    events.push('renew');
                    return 'held';
                },
            });
            const runner = stubRunner(async () => ok());
            const release = gatedRemoval(runner, events);

            const processing = processReclaim(ctxOf(board, runner, logs), row);
            while (board.reclaimRenewals.length < 4) await sleep();
            release();
            await processing;
            const settled = board.reclaimRenewals.length;
            for (let i = 0; i < 5; i += 1) await sleep();

            expect(events.slice(0, 2)).toEqual(['renew', 'removal']);
            expect(board.reclaimRenewals.length).toBe(settled);
            expect(new Set(board.reclaimRenewals.map((renewal) => renewal.token))).toEqual(new Set([ROW_TOKEN]));
            expect(runner.reclaimed.map((removed) => removed.leaseToken)).toEqual([ROW_TOKEN]);
            expect(board.reclaimAckTokens).toEqual([ROW_TOKEN]);
        });

        it('cancels the pending renew sleep once the removal settles, leaving no timer behind', async () => {
            const periods: { ended: boolean }[] = [];
            const { board } = stubBoard([]);
            const runner = stubRunner(async () => ok());
            const release = gatedRemoval(runner, []);
            const ctx: ReclaimContext = {
                ...ctxOf(board, runner, []),
                // A period that never ends by itself: only its `until` ends it.
                sleep: (_ms, until) => {
                    const period = { ended: false };
                    periods.push(period);
                    return new Promise<void>((resolve) => {
                        until?.then(() => {
                            period.ended = true;
                            resolve();
                        });
                    });
                },
            };

            const processing = processReclaim(ctx, row);
            while (periods.length === 0) await sleep();
            release();
            await processing;

            expect(periods.length).toBeGreaterThan(0);
            expect(periods.every((period) => period.ended)).toBe(true);
        });

        it("the loop's sleep clears its timer once its until settles", async () => {
            vi.useFakeTimers();
            try {
                let end!: () => void;
                const until = new Promise<void>((resolve) => {
                    end = resolve;
                });
                const sleeping = wait(100_000, until);
                expect(vi.getTimerCount()).toBe(1);
                end();
                await sleeping;
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });

        it("the loop's sleep takes an AbortSignal as the poll's Sleep does: it rejects on abort and clears its timer (#829 S3)", async () => {
            vi.useFakeTimers();
            try {
                const controller = new AbortController();
                const sleeping = wait(100_000, controller.signal);
                const settled = expect(sleeping).rejects.toBeDefined();
                expect(vi.getTimerCount()).toBe(1);
                controller.abort();
                await settled;
                expect(vi.getTimerCount()).toBe(0);
                await expect(wait(1, controller.signal)).rejects.toBeDefined();
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });

        it('returns and acks at once when the removal settles under a renew that never answers', async () => {
            const signals: (AbortSignal | undefined)[] = [];
            const { board } = stubBoard([], {
                renewReclaim: (_id, _token, signal) => {
                    signals.push(signal);
                    // The first renew, the gate, answers; the next stalls like an unbounded fetch.
                    return signals.length === 1 ? Promise.resolve('held') : new Promise<ReclaimRenewal>(() => {});
                },
            });
            const runner = stubRunner(async () => ok());
            const release = gatedRemoval(runner, []);

            const processing = processReclaim(ctxOf(board, runner, []), row);
            while (signals.length < 2) await sleep();
            release();
            const settled = await Promise.race([
                processing.then(() => 'settled'),
                new Promise((resolve) => setTimeout(() => resolve('stalled'), 500)),
            ]);
            for (let i = 0; i < 5; i += 1) await sleep();

            expect(settled).toBe('settled');
            expect(board.reclaimAcks).toEqual([rowId]);
            // No renew starts after the removal settled, and each one is bounded by a deadline.
            expect(signals).toHaveLength(2);
            expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
        });

        it('stops renewing once the renew answers lost, and the removal in flight still settles', async () => {
            const logs: string[] = [];
            let renews = 0;
            const { board } = stubBoard([], {
                renewReclaim: async () => {
                    renews += 1;
                    return renews === 1 ? 'held' : 'lost';
                },
            });
            const runner = stubRunner(async () => ok());
            const release = gatedRemoval(runner, []);

            const processing = processReclaim(ctxOf(board, runner, logs), row);
            while (renews < 2) await sleep();
            for (let i = 0; i < 5; i += 1) await sleep();
            expect(renews).toBe(2);
            release();
            await processing;

            expect(runner.reclaimed).toHaveLength(1);
            expect(logs.filter((m) => m.includes('renew answered lost'))).toHaveLength(1);
        });

        it.each<[string, () => Promise<ReclaimRenewal>]>([
            ['lost', async () => 'lost'],
            ['missing', async () => 'missing'],
            [
                'a throw',
                async () => {
                    throw new Error('board unreachable');
                },
            ],
        ])('never starts a removal whose first renew answers %s', async (_label, renewReclaim) => {
            const logs: string[] = [];
            const { board } = stubBoard([], { renewReclaim });
            const runner = stubRunner(async () => ok());

            await processReclaim(ctxOf(board, runner, logs), row);

            expect(runner.reclaimed).toEqual([]);
            expect(board.reclaimAcks).toEqual([]);
            expect(logs.some((m) => m.includes(`reclaim ${rowId}`))).toBe(true);
        });

        it('replays an ack whose response was lost, logging the retry once', async () => {
            const logs: string[] = [];
            const { board } = stubBoard([], { failAckReclaimTimes: 1 });
            const runner = stubRunner(async () => ok());

            await processReclaim(ctxOf(board, runner, logs), row);

            expect(board.reclaimAcks).toEqual([rowId]);
            expect(logs.filter((m) => m.includes('ack'))).toHaveLength(1);
            expect(logs.some((m) => m.includes('leaving it to the lease'))).toBe(false);
        });

        // A verdict's reclaim is granted 300 s by the board, a driver lease may be an hour: the
        // first renewal, before the removal starts, is what carries the row past the grant.
        it("renews a verdict-time reclaim under the attempt's lease token before removing, and acks with it", async () => {
            const events: string[] = [];
            const board = stubBoard([job(1)], {
                reclaimId: 'reclaim-1',
                renewReclaim: async () => {
                    events.push('renew');
                    return 'held';
                },
            });
            const runner = stubRunner(async () => ok());
            runner.reclaimWorktree = async (removed) => {
                runner.reclaimed.push(removed);
                events.push('removal');
                return removedOk;
            };

            await drive({ ...board, runner }, { DRIVER_LEASE_SECONDS: '3600' });
            for (let i = 0; i < 20 && board.board.reclaimAcks.length === 0; i += 1) await sleep();

            expect(events.slice(0, 2)).toEqual(['renew', 'removal']);
            expect(board.board.reclaimRenewals[0]).toEqual({ id: 'reclaim-1', token: job(1).leaseToken });
            expect(board.board.reclaimAcks).toEqual(['reclaim-1']);
            expect(board.board.reclaimAckTokens).toEqual([job(1).leaseToken]);
        });

        it('leaves a verdict-time reclaim its first renew lost to the queue, untouched', async () => {
            const logs: string[] = [];
            const board = stubBoard([job(1)], { reclaimId: 'reclaim-1', renewReclaim: async () => 'lost' });
            const runner = stubRunner(async () => ok());

            await drive({ ...board, runner, log: (m) => logs.push(m) });
            for (let i = 0; i < 20 && board.board.reclaimRenewals.length === 0; i += 1) await sleep();
            await sleep();

            expect(runner.reclaimed).toEqual([]);
            expect(board.board.reclaimAcks).toEqual([]);
        });
    });

    describe('a refused reclaim', () => {
        const rowId = '55555555-5555-4555-8555-555555555555';
        const root = job(1).id;
        const heldRow: Reclaim = {
            id: rowId,
            token: ROW_TOKEN,
            rootJobId: root,
            repo: 'Bellows-AI/factory',
            workspacePath: `bellows/${USER}`,
            leaseExpiresAt: '2026-08-21T12:05:00.000Z',
        };
        const heldRefusal = (): ReclaimResult => ({
            ok: false,
            removed: false,
            reason: `the task volume of ${root} is held: a refusal that stays until the reason changes`,
        });

        it('clears the throttle entry on a settled row, so a later identical failure logs fresh', async () => {
            const logs: string[] = [];
            const refusal = heldRefusal();
            const board = stubBoard([], { idleBeforeStop: 20, reclaims: [heldRow, heldRow, heldRow] });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [refusal, { ok: true, removed: true, reason: null }, refusal],
            });
            await drive({ ...board, runner, log: (m) => logs.push(m) });

            // refusal (logged) → settled, entry cleared → the SAME refusal logs again.
            expect(logs.filter((m) => m.includes('could not be reclaimed'))).toHaveLength(2);
            expect(board.board.reclaimAcks).toEqual([rowId]);
        });

        it('throttles identical reclaim failures to one log line until the reason changes', async () => {
            const logs: string[] = [];
            const same = heldRefusal();
            const changed: ReclaimResult = {
                ...same,
                reason: 'the checkout is held (/workspaces/x): a different holder now',
            };
            // The same row, re-offered three times with the same refusal, then once more after
            // the reason changed — five minutes a poll for a day, in the wild. (idleBeforeStop
            // stays high: the job-claim loop's idle count stops the whole loop, drains included,
            // and every row here must be offered before that.)
            const board = stubBoard([], {
                idleBeforeStop: 20,
                reclaims: [heldRow, heldRow, heldRow, { ...heldRow, leaseExpiresAt: '2026-08-21T13:05:00.000Z' }],
            });
            const runner = stubRunner(async () => ok(), {
                reclaimSequence: [same, same, same, changed],
            });
            await drive({ ...board, runner, log: (m) => logs.push(m) });

            const failures = logs.filter((m) => m.includes('could not be reclaimed'));
            expect(failures).toHaveLength(2);
        });
    });

    it('never runs more than the configured number at once', async () => {
        const board = stubBoard([job(1), job(2), job(3), job(4)], { idleBeforeStop: 2 });
        let inFlight = 0;
        let peak = 0;
        const runner = stubRunner(async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return ok();
        });

        await drive({ ...board, runner }, { DRIVER_CONCURRENCY: '2' });

        expect(peak).toBe(2);
        expect(board.board.completed).toHaveLength(4);
    });

    it('keeps polling through a board that is briefly down', async () => {
        const board = stubBoard([job(1)], { failClaims: 2 });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed).toHaveLength(1);
    });

    // Blaming the command for the driver's broken docker would burn an attempt and eventually kill
    // the job. Saying nothing lets the lease expire and the job be offered again.
    it('leaves a job to its lease when the runner cannot start at all', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => {
            throw new Error('spawn docker ENOENT');
        });

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
    });

    // The sync now fences before it writes (the re-claim claim/sweep moved into syncCheckout),
    // and a fence can refuse: the kubernetes claim answers a live newer attempt by throwing the
    // attempt's stand-down. That is the fence's own verdict, not the command's — completing the
    // job failed would burn the attempt on the replacement's arrival. The loop stays up and the
    // job goes back to its lease, exactly as a runner that cannot start does.
    it('leaves a job to its lease when the checkout sync throws', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        runner.syncCheckout = async () => {
            throw new Error('job 1 stands down: the checkout claim is held by a newer claim (3 >= 2)');
        };

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
    });

    it('leaves a sync that threw to its lease', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), { syncError: new Error('daemon went away') });

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
    });

    /*
     * After a kubernetes syncCheckout, the runner HOLDS the checkout claim; the loop's terminal
     * pre-run refusals complete the job failed WITHOUT runner.run, so run()'s finally — the
     * normal release path — never comes, and the factory-job-<id>-claim ConfigMap would sit
     * forever. These refusals must hand the claim back first, ownership-checked inside the
     * runner; docker implements no releaseFence, so the optional call is a no-op there.
     */
    const releaseEvents = (board: BoardStub, runner: Runner): { events: string[] } => {
        const events: string[] = [];
        runner.releaseFence = async (released) => {
            events.push(`release:${released.id}`);
        };
        const realComplete = board.complete.bind(board);
        board.complete = async (claimed, result) => {
            events.push(`complete:${claimed.id}`);
            return realComplete(claimed, result);
        };
        return { events };
    };

    // R3-1: a declared name lands in the pod's hosts file, so one spelled like a host the pod dials
    // would capture that traffic. The board cannot know the driver's endpoints: the driver refuses.
    it.each([
        ['docker', 'driver', { GATE_ADVERTISE_URL: 'http://driver:7000' }, "the driver's control endpoint"],
        ['kubernetes', 'driver', { GATE_ADVERTISE_URL: 'http://Driver' }, "the driver's control endpoint"],
        ['docker', 'collector', {}, 'the telemetry collector'],
        ['kubernetes', 'collector', { RUNNER_OTEL_ENDPOINT: 'http://COLLECTOR:4318' }, 'the telemetry collector'],
    ])(
        'refuses on %s a service named %s, shadowing a host the pod dials, launching nothing',
        async (executor, name, env, what) => {
            const declared = { ...job(1), services: [{ name, image: 'redis', environment: [] }] };
            const board = stubBoard([declared]);
            const runner = stubRunner(async () => {
                throw new Error('the runner must never be reached');
            });

            await drive({ ...board, runner }, { EXECUTOR: executor, ...env });

            expect(runner.synced).toHaveLength(0);
            expect(runner.startedServices).toEqual([]);
            const complete = board.board.completed[0]!;
            expect(complete).toMatchObject({ status: 'failed', failureKind: 'config' });
            expect(complete.output).toContain(`service "${name}" would shadow ${what}`);
            expect(complete.output).toContain('rename it');
        }
    );

    it("runs a service the claim's own env points at: a repo reaching its database by name shadows nothing", async () => {
        const declared = {
            ...job(1),
            env: { DATABASE_URL: 'postgres://db:5432/test' },
            services: [{ name: 'db', image: 'postgres', environment: [] }],
        };
        const board = stubBoard([declared]);
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.failureKind).not.toBe('config');
        expect(runner.startedServices).toEqual([job(1).id]);
    });

    it('fails a job with a plan refusal before the checkout fence is ever taken', async () => {
        const board = stubBoard([{ ...job(1), planRefusal: '.bellows.yaml line 3: unknown key "ports"' }]);
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });
        const { events } = releaseEvents(board.board, runner);

        await drive({ ...board, runner });

        // Nothing was synced, so nothing is fenced and there is nothing to release.
        expect(runner.synced).toHaveLength(0);
        expect(events).toEqual([`complete:${job(1).id}`]);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
    });

    // Issue #821 (D1): the claim goes back once the verdict is in — the claim is keyed by the job
    // id, and a completed row is never claimed again, so no replacement waits on it.
    it('releases the checkout fence once the failure of a job declaring gates this driver cannot run is in', async () => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async () => {
            throw new Error('the runner must never be reached');
        });
        const { events } = releaseEvents(board.board, runner);

        await drive({ ...board, runner });

        expect(events).toEqual([`complete:${job(1).id}`, `release:${job(1).id}`]);
        expect(board.board.completed[0]?.output).toContain('no gate environment configured');
    });

    // The normal path must NOT release here: the run is about to take over, and run()'s own
    // finally is the owner of the claim until the attempt ends.
    it('does not release the fence on the normal path — the run owns the claim', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        const { events } = releaseEvents(board.board, runner);

        await drive({ ...board, runner });

        expect(events).toEqual([`complete:${job(1).id}`]);
        expect(board.board.completed[0]?.status).toBe('succeeded');
    });

    // And the sync-failure refusal releases nothing here either: k8s syncCheckout already took
    // the claim down itself (Foreground Job delete, then release) before answering ok:false.
    it('does not release the fence when the sync itself fails — the runner released it', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok(), {
            sync: {
                ok: false,
                reason: 'conflict in driver/src/loop/loop.ts',
            },
        });
        const { events } = releaseEvents(board.board, runner);

        await drive({ ...board, runner });

        expect(events).toEqual([`complete:${job(1).id}`]);
        expect(board.board.completed[0]?.status).toBe('failed');
    });

    // The daemon can refuse to create the container while `docker run` itself succeeds as a
    // process — a leftover name, a volume or network a stack rebuild removed. The runner asks
    // its platform whether the container ever ran and stamps `started: false`; the loop
    // interprets no exit codes itself.
    it('leaves a job to its lease when the runner reports the container never started', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () =>
            ok({
                exitCode: 125,
                output: 'docker: Error response from daemon: Conflict. The container name is already in use',
                started: false,
            })
        );

        const logs: string[] = [];
        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(board.board.completed).toEqual([]);
        expect(logs.some((m) => m.includes('never started: docker: Error response from daemon: Conflict'))).toBe(true);
    });

    // The board retires a job whose attempts ran out with no output, so the attempt that burns the
    // last one reports the daemon's reason as the verdict (issue #664).
    it('reports the reason a runner never started on the last attempt', async () => {
        // The last attempt is one whose interruption budget is spent, so the board answers that.
        const board = stubBoard([{ ...job(1), attempts: 3, lastAttempt: true }], { interruptVerdict: 'exhausted' });
        const reason =
            'docker: conflicting options: cannot attach both user-defined and non-user-defined network-modes';
        const runner = stubRunner(async () => ok({ exitCode: 125, output: reason, started: false }));
        const logs: string[] = [];

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(board.board.completed[0]?.output).toContain(reason);
        expect(logs.some((m) => m.includes(reason))).toBe(true);
    });

    // Issue #822: a run that threw may still have a runner — a force-deleted driver pod keeps
    // running with its apiserver token revoked, and reading its own runner Job answers 401 while the
    // runner works on. Handing that attempt back would free the lease, and the reaper would sweep
    // the runner the next claim should adopt (the kind lane's hard-kill case): it is left to the
    // lease, whatever the board would have answered an interrupt.
    it('leaves a run it could not run to the lease, never handing it back, so a surviving runner is adopted', async () => {
        const board = stubBoard([{ ...job(1), attempts: 3, lastAttempt: false }]);
        const runner = stubRunner(async () => {
            throw new Error('reading the runner job answered 401: Unauthorized');
        });
        const logs: string[] = [];

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([]);
        expect(logs.some((m) => m.includes('could not run: reading the runner job answered 401'))).toBe(true);
        expect(logs.some((m) => m.includes('leaving it to the lease'))).toBe(true);
    });

    // The kubernetes twin: the runner throws when the apiserver refuses the Job, so the reason
    // rides the rejection instead of the outcome.
    it('reports the reason a run could not start on the last attempt', async () => {
        const board = stubBoard([{ ...job(1), attempts: 3, lastAttempt: true }]);
        const runner = stubRunner(async () => {
            throw new Error('creating the runner job answered 403: pods "x" is forbidden: exceeded quota');
        });

        await drive({ ...board, runner });

        expect(board.board.interrupted).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(board.board.completed[0]?.output).toContain('exceeded quota');
    });

    // The board records one driver sentence: a longer reason would be refused, and the attempt left
    // to the lease for its length alone.
    it('cuts an interruption reason to what the board records', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 125, output: 'x'.repeat(2000), started: false }));

        await drive({ ...board, runner });

        expect(board.board.interrupted[0]?.reason).toHaveLength(500);
    });

    // A runner the platform took away — its pod deleted, evicted or its node removed — never gave
    // the agent's verdict (issue #560): no verdict is reported, and the attempt goes back to the
    // board as an interruption, refunded and claimable at once (issue #792).
    it('hands back as an interruption a job whose runner reports an infrastructure loss', async () => {
        const claimed = { ...gatedJob(1), attempts: 3 };
        const board = stubBoard([claimed]);
        const stack = stubGateStack();
        const logs: string[] = [];
        const runner = stubRunner(async () =>
            ok({ exitCode: null, output: '', infraLoss: 'the runner pod was deleted before it exited (Evicted)' })
        );

        await drive({ ...board, runner, gates: stack.gates, log: (m) => logs.push(m) });

        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([
            {
                id: claimed.id,
                reason: 'infrastructure loss: the runner pod was deleted before it exited (Evicted)',
                release: true,
            },
        ]);
        expect(stack.stack.ran.names).toEqual([]);
        expect(runner.published).toEqual([]);
        expect(
            logs.some((m) => m.includes('infrastructure loss: the runner pod was deleted before it exited (Evicted)'))
        ).toBe(true);
    });

    // Issue #792: a draining driver whose grace runs short hands its running attempts over —
    // reported as interruptions, the runner left alive and never killed, nothing parked or
    // reported — and `start()` stops waiting on runs it no longer owns.
    it('hands a running attempt over on handover: interrupted, never killed, start() returns', async () => {
        const claimed = job(1);
        const board = stubBoard([claimed]);
        let running: () => void = () => {};
        const inFlight = new Promise<void>((resolve) => {
            running = resolve;
        });
        const runner = stubRunner(async () => {
            running();
            return new Promise<RunOutcome>(() => {});
        });
        const loop = createLoop({ board: board.board, runner, config: config(), sleep });
        board.attach(loop);
        const started = loop.start();

        await inFlight;
        await loop.handover('the driver was drained');
        await started;

        expect(board.board.interrupted).toEqual([{ id: claimed.id, reason: 'the driver was drained', release: true }]);
        expect(runner.abandoned).toHaveLength(1);
        expect(runner.killed).toEqual([]);
        expect(runner.finished).toEqual([]);
        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([]);
    });

    // Issue #828: a run that resolves after the handover is abandoned — its outcome is never
    // reported, and the one conclusion stays the interruption.
    it('ignores the outcome of a run that resolves after the handover', async () => {
        const claimed = job(1);
        const board = stubBoard([claimed]);
        let running: () => void = () => {};
        const inFlight = new Promise<void>((resolve) => {
            running = resolve;
        });
        let resolveRun: (outcome: RunOutcome) => void = () => {};
        const runner = stubRunner(async () => {
            running();
            return new Promise<RunOutcome>((resolve) => {
                resolveRun = resolve;
            });
        });
        const loop = createLoop({ board: board.board, runner, config: config(), sleep });
        board.attach(loop);
        const started = loop.start();

        await inFlight;
        const handed = loop.handover('the driver was drained');
        resolveRun(ok());
        await handed;
        await started;
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(board.board.interrupted).toEqual([{ id: claimed.id, reason: 'the driver was drained', release: true }]);
        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([]);
        expect(runner.finished).toEqual([]);
    });

    // Issue #828: start() never returns while an interruption is in flight.
    it('holds start() and the handover until the interruption is answered', async () => {
        const claimed = job(1);
        const board = stubBoard([claimed]);
        let answerInterrupt: () => void = () => {};
        const asked = new Promise<void>((resolve) => {
            board.board.interrupt = (_job, interruption) =>
                new Promise((answer) => {
                    board.board.interrupted.push({ id: claimed.id, ...interruption });
                    answerInterrupt = () => answer('held');
                    resolve();
                });
        });
        let running: () => void = () => {};
        const inFlight = new Promise<void>((resolve) => {
            running = resolve;
        });
        const runner = stubRunner(async () => {
            running();
            return new Promise<RunOutcome>(() => {});
        });
        const logs: string[] = [];
        const loop = createLoop({ board: board.board, runner, config: config(), sleep, log: (m) => logs.push(m) });
        board.attach(loop);
        let startReturned = false;
        const started = loop.start().then(() => {
            startReturned = true;
        });

        await inFlight;
        let handoverReturned = false;
        const handed = loop.handover('the driver was drained').then(() => {
            handoverReturned = true;
        });
        await asked;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(handoverReturned).toBe(false);
        expect(startReturned).toBe(false);
        // The interruption is the attempt's ending: it is not over until the board has answered.
        expect(logs.some((m) => m.includes('"to":"ended"'))).toBe(false);

        answerInterrupt();
        await handed;
        await started;
        // The abandoned run does not hold the attempt: it ended through the one end().
        expect(logs.some((m) => m.includes('"to":"ended"'))).toBe(true);
        expect(runner.finished).toEqual([]);
        expect(runner.killed).toEqual([]);
    });

    // Issues #828, #829: a lease lost while the agent runs leaves it running (no kill from the heartbeat); the
    // board is told nothing, and the runner is retained for the new holder, never finished.
    it('tells the board nothing when the heartbeat reports the lease lost mid-run, and retains the runner', async () => {
        const board = stubBoard([job(1)]);
        let launched = false;
        const heldBeat = board.board.heartbeat.bind(board.board);
        board.board.heartbeat = async (...args) => (launched ? 'lost' : heldBeat(...args));
        let finish = () => {};
        const runner = stubRunner(
            () =>
                new Promise<RunOutcome>((resolve) => {
                    launched = true;
                    finish = () => resolve(ok());
                })
        );
        const started = drive({ ...board, runner });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(launched).toBe(true);
        expect(runner.abandoned).toHaveLength(1);
        expect(runner.killed).toEqual([]);
        expect(board.board.interrupted).toEqual([]);
        expect(board.board.suspended).toEqual([]);
        expect(board.board.completed).toEqual([]);
        finish();
        await started;

        expect(board.board.interrupted).toEqual([]);
        expect(board.board.suspended).toEqual([]);
        expect(board.board.completed).toEqual([]);
        expect(runner.finished).toEqual([]);
    });

    // Issue #828: a lease already lost before the agent launches kills the runner and finishes it
    // from the one ending; the board is told nothing.
    it('tells the board nothing when the lease is lost before the agent launches, and finishes the runner once', async () => {
        const board = stubBoard([job(1)], { lease: 'lost' });
        let finish = () => {};
        const runner = stubRunner(
            () =>
                new Promise<RunOutcome>((resolve) => {
                    finish = () => resolve(ok());
                })
        );
        const started = drive({ ...board, runner });
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(board.board.interrupted).toEqual([]);
        expect(board.board.suspended).toEqual([]);
        expect(board.board.completed).toEqual([]);
        finish();
        await started;

        expect(runner.killed).toEqual([job(1).id]);
        expect(board.board.interrupted).toEqual([]);
        expect(board.board.suspended).toEqual([]);
        expect(board.board.completed).toEqual([]);
        expect(runner.finished).toEqual([job(1).id]);
    });

    // Issue #828: a full spool is failure evidence on the run's outcome, not an ending — the attempt
    // still reports a failed verdict, never a park or an interruption.
    it('fails a run whose transcript spool filled, with its cause, and neither parks nor interrupts it', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ artifactSpoolFull: '2000000000 bytes' }));

        await drive({ ...board, runner });

        expect(board.board.completed).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed' });
        expect(board.board.completed[0]?.output).toContain('artifact_spool_full');
        expect(board.board.suspended).toEqual([]);
        expect(board.board.interrupted).toEqual([]);
    });

    // A beat in flight at the handover answers 409 once the board released the lease: it must not
    // kill the runner the next claim adopts.
    it('never kills a handed-over runner on the lease-lost beat that follows the handover', async () => {
        const claimed = job(1);
        const board = stubBoard([claimed]);
        let running: () => void = () => {};
        const inFlight = new Promise<void>((resolve) => {
            running = resolve;
        });
        const runner = stubRunner(async () => {
            running();
            return new Promise<RunOutcome>(() => {});
        });
        const loop = createLoop({ board: board.board, runner, config: config(), sleep });
        board.attach(loop);
        const started = loop.start();
        await inFlight;

        let answerBeat: (verdict: 'lost') => void = () => {};
        let beatAsked: () => void = () => {};
        const asked = new Promise<void>((resolve) => {
            beatAsked = resolve;
        });
        board.board.heartbeat = () =>
            new Promise((resolve) => {
                answerBeat = resolve;
                beatAsked();
            });
        await asked;
        // The attempt's end waits for its beat, so the board answers it while the handover is in flight.
        const handed = loop.handover('the driver was drained');
        answerBeat('lost');
        await handed;
        await started;
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(runner.killed).toEqual([]);
    });

    // Issue #792: the next claim finds the earlier attempt's runner already finished — its driver
    // died. The run is read, never redone: no sync rewrites the tree it left, no runner launches,
    // the gates run over it, its verdict is reported, and the earlier attempt is recorded as an
    // interruption under this claim's lease.
    it('adopts a finished runner of an earlier claim instead of running the job again', async () => {
        const claimed = { ...gatedJob(1), attempts: 2, claimSeq: 2 };
        const board = stubBoard([claimed]);
        const stack = stubGateStack();
        let launched = 0;
        const runner = stubRunner(
            async () => {
                launched += 1;
                return ok();
            },
            {
                adopt: async () => ({
                    outcome: ok({ output: 'the adopted run', sessionId: 'session-of-claim-1' }),
                    claimSeq: 1,
                }),
            }
        );

        await drive({ ...board, runner, gates: stack.gates });

        expect(launched).toBe(0);
        expect(runner.synced).toEqual([]);
        expect(stack.stack.ran.names).not.toEqual([]);
        expect(board.board.interrupted).toEqual([
            {
                id: claimed.id,
                reason: 'adopted the finished runner of claim 1, whose driver was lost',
                release: false,
                claimSeq: 1,
            },
        ]);
        expect(board.board.sessions).toContainEqual({ id: claimed.id, sessionId: 'session-of-claim-1' });
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded', output: 'the adopted run' });
    });

    it('runs the job as ever when there is nothing to adopt', async () => {
        const board = stubBoard([job(1)]);
        let launched = 0;
        const runner = stubRunner(
            async () => {
                launched += 1;
                return ok();
            },
            { adopt: async () => null }
        );

        await drive({ ...board, runner });

        expect(launched).toBe(1);
        expect(runner.synced).toHaveLength(1);
        expect(board.board.interrupted).toEqual([]);
    });

    // Issue #824: an adoption waiting out a finalizing supervisor is handed the stand-down's signal,
    // and a Stop fires it — the abandoned adoption deletes nothing more, while the attempt parks.
    it('hands the adoption the stand-down signal and fires it when a stop lands mid-wait', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([job(1)], options);
        let seen: AbortSignal | undefined;
        const runner = stubRunner(
            async () => {
                throw new Error('the runner must not spawn');
            },
            {
                adopt: async (_job, signal) => {
                    seen = signal;
                    options.cancelRequested = true;
                    await new Promise((resolve) => setTimeout(resolve, 30));
                    return null;
                },
            }
        );

        await drive({ ...board, runner });

        expect(seen?.aborted).toBe(true);
        expect(runner.synced).toHaveLength(0);
        expect(board.board.suspended).toEqual([job(1).id]);
        expect(board.board.completed).toEqual([]);
    });

    // A failed adoption is no verdict — a read that threw (issue 796): the attempt is left to its
    // lease, since an unconfirmed read never licenses a fresh run's sweep (#828).
    it('leaves the job to its lease, running nothing, when the adoption throws', async () => {
        const board = stubBoard([job(1)]);
        let launched = 0;
        const logs: string[] = [];
        const runner = stubRunner(
            async () => {
                launched += 1;
                return ok({ output: 'the fresh run' });
            },
            {
                adopt: async () => {
                    throw new Error('sweeping the earlier claim answered 503');
                },
            }
        );

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(launched).toBe(0);
        expect(runner.synced).toEqual([]);
        expect(board.board.interrupted).toEqual([]);
        expect(board.board.completed).toEqual([]);
        expect(logs.some((m) => m.includes('could not read an earlier runner'))).toBe(true);
    });

    // Issue #821: an adoption whose read succeeded but whose earlier attempt left something it
    // could not confirm gone stands down to the lease — never a fresh run over that run's tree.
    it('leaves the job to its lease, running nothing, when an adopted run is blocked by a live writer', async () => {
        const board = stubBoard([job(1)]);
        let launched = 0;
        const logs: string[] = [];
        const runner = stubRunner(
            async () => {
                launched += 1;
                return ok();
            },
            {
                adopt: async () => {
                    throw new AdoptionBlocked('a writer of an earlier attempt could not be confirmed gone');
                },
            }
        );

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(launched).toBe(0);
        expect(runner.synced).toHaveLength(0);
        expect(board.board.completed).toEqual([]);
        expect(logs.some((m) => m.includes('confirmed gone'))).toBe(true);
    });

    // A spent interruption budget falls back to the lease, and the last attempt reports the loss.
    it('leaves an infrastructure loss to the lease once the interruption budget is spent', async () => {
        const board = stubBoard([{ ...job(1), attempts: 3, lastAttempt: true }], { interruptVerdict: 'exhausted' });
        const runner = stubRunner(async () =>
            ok({ exitCode: null, output: '', infraLoss: 'the runner pod was deleted before it exited (Evicted)' })
        );

        await drive({ ...board, runner });

        expect(board.board.interrupted).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'runner_error' });
        expect(board.board.completed[0]?.output).toContain('infrastructure loss');
    });

    // A container that never started is the daemon's refusal, said by a live driver (issue #822):
    // handed back with its reason, like a run that could not start.
    it('hands a runner that never started back as an interruption', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 125, output: 'no such image', started: false }));

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([
            {
                id: job(1).id,
                reason: 'the runner reports the container never started: no such image',
                release: true,
            },
        ]);
    });

    // Issue #824 D11: a group start the platform refused for a proven cause takes ONE decision on
    // every path — the sync, the run, a container that never started: a transient cause is an
    // interruption, a permanent one (image, auth, config) a configuration fault, never left to the
    // lease to burn the attempts.
    describe('a refused group start (#824 D11)', () => {
        const transient = () => new StartupRefused('the registry answered: dial tcp: i/o timeout', 'transient');
        const permanent = () => new StartupRefused('manifest unknown', 'image');

        it('interrupts a sync whose group start was refused for a transient cause', async () => {
            const board = stubBoard([job(1)]);
            await drive({ ...board, runner: stubRunner(async () => ok(), { syncError: transient() }) });
            expect(board.board.completed).toEqual([]);
            expect(board.board.interrupted).toEqual([
                {
                    id: job(1).id,
                    reason: 'the runner could not start: the registry answered: dial tcp: i/o timeout',
                    release: true,
                },
            ]);
        });

        it('fails a sync whose group start was refused for a permanent cause, as config', async () => {
            const board = stubBoard([job(1)]);
            await drive({ ...board, runner: stubRunner(async () => ok(), { syncError: permanent() }) });
            expect(board.board.interrupted).toEqual([]);
            expect(board.board.completed[0]).toMatchObject({
                status: 'failed',
                failureKind: 'config',
                output: 'The runner could not start: manifest unknown',
            });
        });

        it('takes the same decisions when the run starts the group', async () => {
            const permanentRun = stubBoard([job(1)]);
            await drive({
                ...permanentRun,
                runner: stubRunner(async () => {
                    throw permanent();
                }),
            });
            expect(permanentRun.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'config' });

            const transientRun = stubBoard([job(1)]);
            await drive({
                ...transientRun,
                runner: stubRunner(async () => {
                    throw transient();
                }),
            });
            expect(transientRun.board.completed).toEqual([]);
            expect(transientRun.board.interrupted).toHaveLength(1);
        });

        // The runner only throws or returns the fact (both executors' `run()` finish nothing, #828):
        // the loop's `end()` is what gives the refused group back, on every refusal it decides.
        it.each([
            ['a run that throws a transient refusal', () => Promise.reject(transient())],
            ['a run that throws a permanent refusal', () => Promise.reject(permanent())],
            [
                'a container that never started',
                () => Promise.resolve(ok({ exitCode: 125, output: 'x', started: false, startupCause: 'image' })),
            ],
        ])('finishes the group of %s through end()', async (_name, run) => {
            const board = stubBoard([job(1)]);
            const runner = stubRunner(run);
            await drive({ ...board, runner });
            expect(runner.finished).toEqual([job(1).id]);
        });

        it('fails a container that never started for a permanent cause, and hands a transient one back', async () => {
            const refused = stubBoard([job(1)]);
            const pull = 'docker: Error response from daemon: manifest unknown';
            await drive({
                ...refused,
                runner: stubRunner(async () =>
                    ok({ exitCode: 125, output: pull, started: false, startupCause: 'image' })
                ),
            });
            expect(refused.board.interrupted).toEqual([]);
            expect(refused.board.completed[0]).toMatchObject({
                status: 'failed',
                failureKind: 'config',
                output: `The runner could not start: ${pull}`,
            });

            const blip = stubBoard([job(1)]);
            await drive({
                ...blip,
                runner: stubRunner(async () =>
                    ok({ exitCode: 125, output: 'i/o timeout', started: false, startupCause: 'transient' })
                ),
            });
            expect(blip.board.completed).toEqual([]);
            expect(blip.board.interrupted).toHaveLength(1);
        });

        // The one mapping orders it for both executors: a proven refused start ran no agent, so no
        // supervisor loss beside it can turn its configuration fault into a refund (Codex r1, class C).
        it('decides a proven permanent start refusal before any infrastructure loss beside it', async () => {
            const board = stubBoard([job(1)]);
            await drive({
                ...board,
                runner: stubRunner(async () =>
                    ok({
                        exitCode: 1,
                        output: 'invalid mount config',
                        started: false,
                        startupCause: 'config',
                        infraLoss: 'the task supervisor did not finalize the run in time',
                    })
                ),
            });
            expect(board.board.interrupted).toEqual([]);
            expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'config' });
        });
    });

    // The mirror case, and why classification lives in the runner rather than in an exit code
    // here: a run that started and exited 125 — a shell or an agent CLI can — is a genuine
    // verdict, and swallowing it would rerun the job to death instead of reporting the failure.
    it('reports a started run that exited 125 as the failure it is', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 125, output: 'the command failed' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({
            status: 'failed',
            exitCode: 125,
            output: 'the command failed',
        });
    });

    // Found by running the driver for real, not by this suite: the beat period is a third of the
    // lease, 100s at the default, and waiting it out before reporting left every finished job
    // sitting in `running` for a minute and a half. A fake sleep that resolves instantly cannot see
    // that, so this one models a period that never elapses.
    it('reports a finished job without waiting out the heartbeat period', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok());
        const loop = createLoop({
            board: board.board,
            runner,
            config: config(),
            sleep: (ms) => (ms >= 60_000 ? new Promise<void>(() => {}) : sleep()),
        });
        board.attach(loop);

        await loop.start();

        expect(board.board.completed).toHaveLength(1);
    });

    // The id the board is told has to be the one the runner is given, or the UI links to a session
    // that does not exist. Reported before the run so the link works while the job is still going.
    it('reports the session it is about to run as, before starting the container', async () => {
        const board = stubBoard([job(1)]);
        let given = '';
        let reportedFirst = false;
        const runner = stubRunner(async (_job, session) => {
            if (!session) throw new Error('a claude-code run always has a session');
            given = session.id;
            reportedFirst = board.board.sessions.length === 1;
            return ok();
        });

        await drive({ ...board, runner });

        expect(given).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(board.board.sessions).toEqual([{ id: job(1).id, sessionId: given }]);
        expect(reportedFirst).toBe(true);
    });

    // Losing the link is not losing the job.
    it('runs the job anyway when the session cannot be reported', async () => {
        const board = stubBoard([job(1)], { failSession: true });
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner });

        expect(board.board.completed).toHaveLength(1);
    });

    /**
     * The live-output contract, end to end: the runner hands the loop its newest tail as it grows,
     * and the loop flushes each distinct tail to the board while the run is still going — so the
     * dashboard shows the work instead of a spinner. The final complete report carries `final`,
     * not the last tail: the preview never replaces the verdict.
     */
    it('streams the output tail to the board while the run goes', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('tail one');
            while (board.board.progressed.length < 1) await sleep();
            onOutput?.('tail two');
            while (board.board.progressed.length < 2) await sleep();
            return ok({ output: 'final' });
        });

        await drive({ ...board, runner });

        expect(board.board.progressed).toEqual([
            { id: job(1).id, output: 'tail one', runtime: null },
            { id: job(1).id, output: 'tail two', runtime: null },
        ]);
        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'final',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    /**
     * The vitals ride the same flush as the tail: the "is it stuck or working" answer travels with
     * the work it describes. The activity line is derived from the tail at flush time, so the
     * numbers and the line describe the same moment; a sample alone (quiet agent, unchanged tail)
     * is worth a report of its own.
     */
    it('reports the container vitals beside the output tail', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(
            async (_job, _session, onOutput) => {
                onOutput?.('$ npm test\n\x1b[32m→ Read src/x.ts\x1b[0m');
                // The first flush carries no vitals (the sample is still in flight); hold the run
                // open until the sampled one lands, which is the flush a quiet agent's vitals
                // trigger on their own.
                while (!board.board.progressed.some((p) => p.runtime)) await sleep();
                return ok({ output: 'final' });
            },
            { sample: { cpuPercent: 93, memUsedMb: 544, memPercent: 7 } }
        );

        await drive({ ...board, runner });

        expect(runner.samples).toBeGreaterThan(0);
        const sampled = board.board.progressed.find((p) => p.runtime);
        expect(sampled?.runtime).toMatchObject({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7,
            activity: '→ Read src/x.ts',
        });
        expect(sampled?.runtime?.sampledAt).toBeTruthy();
        // A vitals-only sample is byte-identical to the pre-services wire shape: no key at all,
        // never an empty array the board would store.
        expect('services' in (sampled?.runtime ?? {})).toBe(false);
    });

    /**
     * The attempt's service fleet rides the same flush (issue #60): the dashboard can answer
     * "did db come up" while the run is going. A services-only sample — vitals unreadable, a
     * kubernetes cluster with no metrics-server for one — carries null numbers rather than
     * skipping the flush; the fleet must not depend on the metrics API.
     */
    it('flushes the service fleet beside the vitals, and null numbers when there are no vitals', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(
            async (_job, _session, onOutput) => {
                onOutput?.('$ docker compose up db\n→ waiting for postgres');
                while (!board.board.progressed.some((p) => p.runtime?.services)) await sleep();
                return ok({ output: 'final' });
            },
            {
                sample: {
                    cpuPercent: null,
                    memUsedMb: null,
                    memPercent: null,
                    services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
                },
            }
        );

        await drive({ ...board, runner });

        const sampled = board.board.progressed.find((p) => p.runtime);
        expect(sampled?.runtime).toMatchObject({
            cpuPercent: null,
            memUsedMb: null,
            services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
        });
        expect(sampled?.runtime?.activity).toBe('→ waiting for postgres');
    });

    /**
     * A service that dies mid-run (issue #487): the first sample that sees it dead reads its
     * ending once, the board's fleet carries it — exit, reason, log tail, the capability-drop
     * hint — and the gate endpoint's token is handed the note the agent reads.
     */
    it('carries a dead service ending into the fleet and tells the agent through the gate endpoint', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const mongo: DeadService = {
            name: 'test-mongo',
            image: 'mongo:8.0.11',
            state: 'failed',
            exitCode: 1,
            reason: 'Error',
            logTail: 'error: failed switching to "mongodb": operation not permitted',
        };
        const runner = stubRunner(
            async (_job, _session, onOutput) => {
                onOutput?.('waiting for mongo');
                while (!board.board.progressed.some((p) => p.runtime?.services?.[0]?.logTail)) await sleep();
                return ok({ output: 'final' });
            },
            {
                sample: {
                    cpuPercent: null,
                    memUsedMb: null,
                    memPercent: null,
                    services: [
                        { name: 'test-mongo', image: 'mongo:8.0.11', state: 'failed' },
                        { name: 'test-redis', image: 'redis:6.2.6', state: 'running' },
                    ],
                },
                deadServices: async () => [mongo],
            }
        );

        await drive({ ...board, runner, gates: stack.gates });

        const sampled = board.board.progressed.find((p) => p.runtime?.services?.[0]?.logTail);
        expect(sampled?.runtime?.services).toEqual([
            {
                name: 'test-mongo',
                image: 'mongo:8.0.11',
                state: 'failed',
                exitCode: 1,
                reason: 'Error',
                logTail: mongo.logTail,
                hint: expect.stringContaining('user: "uid:gid"'),
            },
            { name: 'test-redis', image: 'redis:6.2.6', state: 'running' },
        ]);
        expect(stack.stack.deadNotes).toHaveLength(1);
        expect(stack.stack.deadNotes[0]?.[1]).toContain('service "test-mongo" (mongo:8.0.11) failed — exit 1 (Error)');
        expect(stack.stack.deadNotes[0]?.[1]).toContain('failed switching to "mongodb"');
    });

    // A run is not failed by its own telemetry. The output stream is a preview; losing it costs
    // freshness, never the job.
    it('completes the job anyway when the output stream fails', async () => {
        const board = stubBoard([job(1)], { failProgress: true });
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('tail one');
            await new Promise((resolve) => setTimeout(resolve, 5));
            onOutput?.('tail two');
            await new Promise((resolve) => setTimeout(resolve, 5));
            return ok({ output: 'final' });
        });

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'final',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    // Same failure, rate-limited: an unreachable board during a three-hour session must not write
    // a log line every flush period.
    it('complains about a failing output stream once, not per flush', async () => {
        const board = stubBoard([job(1)], { failProgress: true });
        const logs: string[] = [];
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('tail one');
            await new Promise((resolve) => setTimeout(resolve, 5));
            onOutput?.('tail two');
            await new Promise((resolve) => setTimeout(resolve, 5));
            return ok();
        });
        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(logs.filter((m) => m.includes('could not stream output'))).toHaveLength(1);
    });

    // The 409 a stream report gets back is NOT a kill order: the heartbeat is the one place that
    // decides a superseded run must die, and a telemetry refusal must not duplicate that decision.
    it('does not kill the runner when the board refuses the output stream', async () => {
        const board = stubBoard([job(1)], { progressLease: 'lost' });
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('tail one');
            while (board.board.progressed.length < 1) await sleep();
            return ok({ output: 'final' });
        });

        await drive({ ...board, runner });

        expect(board.board.progressed).toHaveLength(1);
        expect(runner.killed).toEqual([]);
        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'final',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    // The board hands the session back on the claim, and the runner restores it rather than being
    // given a new one. A fresh id here would strand the transcript the conversation continues
    // from and move the link.
    //
    // The opencode row is the follow-up carve-out, and the reason an opencode task is
    // follow-up-able at all: the child's session is opencode's OWN (scraped and reported when the
    // parent ran), so the runner restores it with `--session` and delivers the new command into
    // it. Already on the board from the insert — nothing re-reported at spawn.
    it.each([
        [
            'resumes the session the board hands back, and does not report it again',
            job(1, '44444444-4444-4444-8444-444444444444'),
            '44444444-4444-4444-8444-444444444444',
        ],
        [
            'runs an opencode follow-up, restoring the session it carries',
            { ...job(1, 'ses_f86188c3dffeZGYO4yZq4atba9'), executorType: 'opencode' as const, followUp: true },
            'ses_f86188c3dffeZGYO4yZq4atba9',
        ],
    ])('%s', async (_label, claimed, resumed) => {
        const board = stubBoard([claimed]);
        let given: RunSession | null | undefined;
        const runner = stubRunner(async (_job, session) => {
            given = session;
            return ok();
        });

        await drive({ ...board, runner });

        expect(given).toEqual({ id: resumed, resume: true });
        expect(board.board.completed).toHaveLength(1);
        expect(board.board.sessions).toEqual([]);
    });

    it('drains what is already running before it returns', async () => {
        const board = stubBoard([job(1), job(2)], { idleBeforeStop: 1 });
        const runner = stubRunner(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return ok();
        });

        await drive({ ...board, runner });

        expect(board.board.completed).toHaveLength(2);
    });

    // "Never log the merged environment" (docs/configuration.md) starts HERE — this is the first
    // process the values enter on their way to a runner.
    it('never logs the environment a claim carries', async () => {
        const messages: string[] = [];
        const envJob: BoardJob = { ...job(1), env: { SECRET_TOKEN: 'board-secret-value' } };
        const board = stubBoard([envJob], { idleBeforeStop: 1 });
        await drive({ ...board, runner: stubRunner(async () => ok()), log: (m) => messages.push(m) });

        expect(messages.length).toBeGreaterThan(0);
        expect(messages.join('\n')).not.toContain('board-secret-value');
    });
});

describe('an opencode runner', () => {
    // opencode mints its own session ids and cannot adopt one (acceptsSessionId: false). Minting a
    // uuid here and reporting it would put a session on the board that the runner never used — so
    // the honest answer is no session at all.
    it('runs headless: no session is minted, reported or given', async () => {
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }]);
        let given: RunSession | null | undefined;
        const runner = stubRunner(async (_job, session) => {
            given = session;
            return ok();
        });

        await drive({ ...board, runner });

        expect(given).toBeNull();
        expect(board.board.sessions).toEqual([]);
        expect(board.board.completed).toEqual([
            {
                id: job(1).id,
                status: 'succeeded',
                exitCode: 0,
                output: 'done',
                contextTokens: null,
                contextCostUsd: null,
            },
        ]);
    });

    // opencode mints its own session id, so the loop learns it from the outcome — the runner
    // scrapes it out of the session database after the run and the board is told while the lease
    // is still live, because a follow-up resumes exactly this.
    it('reports the session id the runner scraped from a finished opencode run', async () => {
        const board = stubBoard([{ ...job(1), executorType: 'opencode' }]);
        const runner = stubRunner(async () => ok({ sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9' }));

        await drive({ ...board, runner });

        expect(board.board.sessions).toEqual([{ id: job(1).id, sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9' }]);
        expect(board.board.completed).toHaveLength(1);
    });
});
