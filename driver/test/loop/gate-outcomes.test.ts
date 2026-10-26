import { describe, expect, it } from 'vitest';
import type { Board } from '../../src/board/board.js';
import { BOARD_CALL_ATTEMPTS, BoardHttpError } from '../../src/board/board-retry.js';
import type { PublishResult } from '../../src/publish/publish.js';
import { drive, gatedJob, job, ok, stubBoard, stubGateStack, stubRunner } from '../fixtures/loop-stubs.js';

/**
 * Gates judge work: a run that did not finish cleanly left none, and a failed gate over it would
 * fire the workflow's `gate-failed` edge on work that never happened.
 */
describe('the gate environment’s GitHub token (docs/connections.md)', () => {
    // A gate run after an hour-long agent turn must not start on the token minted before it.
    it('is asked at each gate run’s start and rides the gate env file, never the runner’s', async () => {
        const board = stubBoard([{ ...gatedJob(1), publish: false }]);
        let minted = 0;
        board.board.githubCredential = async () => {
            minted += 1;
            return `ghs_${minted}`;
        };
        const runner = stubRunner(async () => ok());
        const { gates, stack } = stubGateStack();

        await drive({ ...board, runner, gates });

        // The sync's ask is ghs_1; the environment starts on ghs_2, and each declared gate's
        // re-acquire carries a token of its own.
        expect(stack.envBodies.map((body) => /GITHUB_TOKEN=(\S+)/.exec(body)?.[1])).toEqual([
            'ghs_2',
            'ghs_3',
            'ghs_4',
        ]);
        // The gate server's own pair is the agent's: no gate run's body carries it.
        for (const body of stack.envBodies) expect(body).not.toMatch(/BELLOWS_GATE_(URL|TOKEN)/);
        expect(stack.ran.names).toEqual(['test', 'lint']);
    });

    it('starts the environment without one when the board issues none', async () => {
        const board = stubBoard([{ ...gatedJob(1), publish: false }]);
        const runner = stubRunner(async () => ok());
        const { gates, stack } = stubGateStack();

        await drive({ ...board, runner, gates });

        expect(stack.envBodies[0]).not.toContain('GITHUB_TOKEN');
    });
});

describe('gates over a run that did not finish cleanly', () => {
    it.each([
        ['a non-zero exit', ok({ exitCode: 2, output: 'boom' }), "the agent's run exited 2", 'runner_error'],
        [
            'a null exit',
            ok({ exitCode: null, output: 'boom' }),
            "the agent's run exited without an exit code",
            'runner_error',
        ],
        [
            'a cache kill',
            ok({ exitCode: 1, output: 'cut', cacheLost: '3 consecutive turns with no prompt-cache reads' }),
            'the run was killed for prompt-cache loss',
            'cache_lost',
        ],
        [
            'a premature finish',
            ok({ output: 'reads only', finishReason: 'length' }),
            "the agent's run ended before it finished",
            'runner_error',
        ],
    ])('skips the declared gates after %s, naming why, keeping the kind', async (_label, outcome, why, kind) => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ test: 1 });
        const runner = stubRunner(async () => outcome);

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.gatesReported).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete).toMatchObject({ status: 'failed', failureKind: kind });
        expect(complete.output).toContain(`[driver] gates skipped — ${why}`);
        // Teardown still runs on the skip path.
        expect(stack.stack.unregistered).toBe(1);
        expect(stack.stack.released).toEqual([`${gatedJob(1).id}/factory`]);
        expect(runner.servicesReleased).toEqual([gatedJob(1).id]);
    });

    // Issue #1020: a task that changed nothing has nothing for the gates to judge.
    it('skips the declared gates over a task with no change, recording why', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ test: 1 });
        const runner = stubRunner(async () => ok(), { noChange: true });
        const logs: string[] = [];

        await drive({ ...board, runner, gates: stack.gates, log: (line: string) => logs.push(line) });

        expect(stack.stack.ran.names).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete.status).toBe('succeeded');
        expect(complete.output).toContain('[driver] gates skipped — the task produced no change');
        expect(logs.join('\n')).toContain('gates skipped — the task produced no change');
        expect(stack.stack.unregistered).toBe(1);
    });

    it('does not let the no-change skip refuse the publication under a gates-required policy', async () => {
        const board = stubBoard([{ ...gatedJob(1), policy: { gates: true } }]);
        const stack = stubGateStack({ test: 1 });
        const runner = stubRunner(async () => ok(), {
            noChange: true,
            probeTree: 'head:tree',
            sync: { ok: true, reason: null, fingerprint: 'head:tree' },
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(board.board.completed[0]?.output).not.toContain('publication refused');
    });

    it.each([
        ['a changed task', false],
        ['a read that fails', async () => Promise.reject(new Error('probe timed out'))],
    ])('still runs every gate over %s', async (_label, noChange) => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok(), { noChange });

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]?.output).not.toContain('gates skipped');
    });

    // 044 names "timeouts where the gates passed" as a query: a timed-out run keeps its gates.
    it('still runs the gates over a timed-out run', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(async () => ok({ exitCode: 137, output: 'partial', timedOut: true }));

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual(['test', 'lint']);
        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'timeout' });
        expect(board.board.completed[0]?.output).not.toContain('gates skipped');
    });

    it('says nothing about gates for a job that declares none', async () => {
        const board = stubBoard([job(1)]);
        const runner = stubRunner(async () => ok({ exitCode: 2, output: 'boom' }));

        await drive({ ...board, runner });

        expect(board.board.completed[0]?.output).toBe('boom');
    });
});

describe('the agent reporting it is blocked', () => {
    it('reads the close-time blocked line: no gates, no publish, failed blocked', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();
        const runner = stubRunner(
            async () =>
                ok({
                    output: 'I could not start.',
                    summary: 'acli answered 401 on every call. FACTORY_BLOCKED: acli is not authenticated',
                    blockedLine: 'acli is not authenticated',
                }),
            {
                publish: {
                    ok: true,
                    published: true,
                    branch: 'b',
                    prUrl: null,
                    reason: null,
                    cause: null,
                    repository: null,
                    baseBranch: null,
                    prNumber: null,
                },
            }
        );

        await drive({ ...board, runner, gates: stack.gates });

        expect(stack.stack.ran.names).toEqual([]);
        expect(runner.published).toEqual([]);
        const complete = board.board.completed[0]!;
        expect(complete).toMatchObject({ status: 'failed', exitCode: 0, failureKind: 'blocked' });
        expect(complete.output).toContain('[driver] the agent reported it is blocked: acli is not authenticated');
        expect(complete.output).toContain('[driver] gates skipped — the agent reported it is blocked');
    });
});

/**
 * A gate-fix round that changed nothing can only fail the same gate again: the driver reports
 * whether the tree moved since the startup sync, and the board rests the `gate-failed` edge on false.
 */
describe('the tree change behind a failed gate', () => {
    const synced = { ok: true, reason: null, fingerprint: 'head:aaaa' };

    it.each([
        ['unchanged', 'head:aaaa', false],
        ['changed', 'head:bbbb', true],
    ])('reports a %s tree after a failed gate', async (_label, after, changed) => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async () => ok(), { sync: synced, probeTree: after });

        await drive({ ...board, runner, gates: stubGateStack({ test: 1 }).gates });

        expect(runner.probed).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ failureKind: 'gate', treeChanged: changed });
    });

    it.each([
        ['the probe answers nothing', synced, null],
        ['the sync printed no fingerprint', { ok: true, reason: null }, 'head:aaaa'],
    ])('reports nothing when %s', async (_label, sync, probe) => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async () => ok(), { sync, probeTree: probe });

        await drive({ ...board, runner, gates: stubGateStack({ test: 1 }).gates });

        expect(board.board.completed[0]).toMatchObject({ failureKind: 'gate' });
        expect(board.board.completed[0]).not.toHaveProperty('treeChanged');
    });

    it('reports nothing when the gates pass', async () => {
        const board = stubBoard([gatedJob(1)]);
        const runner = stubRunner(async () => ok(), { sync: synced, probeTree: 'head:bbbb' });

        await drive({ ...board, runner, gates: stubGateStack().gates });

        expect(board.board.completed[0]).not.toHaveProperty('treeChanged');
    });

    // A failing gate that writes a non-ignored artifact must not read as the agent's progress.
    it('reads the tree before the gates run', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack({ test: 1 });
        const runner = stubRunner(async () => ok(), { sync: synced });
        let gatesRunAtProbe = -1;
        runner.probeTree = async () => {
            gatesRunAtProbe = stack.stack.ran.names.length;
            return 'head:aaaa';
        };

        await drive({ ...board, runner, gates: stack.gates });

        expect(gatesRunAtProbe).toBe(0);
        expect(board.board.completed[0]).toMatchObject({ failureKind: 'gate', treeChanged: false });
    });
});

/** A Stop or Remove ends every gate of the attempt where it stands — never a failed gate verdict. */
describe('a stop cancels the gates', () => {
    it('aborts the declared gate in flight, runs no later gate, and parks the turn stopped', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const stack = stubGateStack();
        const ran: string[] = [];
        let aborted = false;
        stack.gates.manager.runGate = (_key, name, _command, { signal } = {}) => {
            ran.push(name);
            options.cancelRequested = true;
            return new Promise((resolve) => {
                signal?.addEventListener('abort', () => {
                    aborted = true;
                    resolve({ exitCode: 137, output: 'killed' });
                });
            });
        };
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(aborted).toBe(true);
        expect(ran).toEqual(['test']);
        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([gatedJob(1).id]);
        // The cancelled gate is never reported failed — `gate-failed` cannot read it.
        expect(board.board.gatesReported.flatMap((r) => r.results).some((g) => g.status === 'failed')).toBe(false);
        expect(stack.stack.unregistered).toBe(1);
        expect(runner.servicesReleased).toEqual([gatedJob(1).id]);
    });

    // Codex review: every park waits out the output pump — a write still in flight when a stop lands
    // during the gates would be refused once the row is parked, and its tail lost.
    it('parks a turn stopped during the gates only after the progress write in flight lands', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const events: string[] = [];
        const rawProgress = board.board.progress.bind(board.board);
        board.board.progress = async (claimed, output, runtime) => {
            if (output === 'the last tail') await new Promise((resolve) => setTimeout(resolve, 150));
            events.push(`landed ${output}`);
            return rawProgress(claimed, output, runtime);
        };
        const rawSuspend = board.board.suspend.bind(board.board);
        board.board.suspend = async (claimed) => {
            events.push('parked');
            return rawSuspend(claimed);
        };
        const stack = stubGateStack();
        stack.gates.manager.runGate = (_key, _name, _command, { signal } = {}) =>
            new Promise((resolve) => {
                // The stop lands once the pump has the last tail's write in flight.
                setTimeout(() => {
                    options.cancelRequested = true;
                }, 30);
                signal?.addEventListener('abort', () => resolve({ exitCode: 137, output: 'killed' }));
            });
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('the last tail');
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.suspended).toEqual([gatedJob(1).id]);
        expect(events.indexOf('landed the last tail')).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('landed the last tail')).toBeLessThan(events.indexOf('parked'));
    });

    // Codex review: the drain is bounded — a progress write that never answers costs its tail, never the park.
    it('parks a stopped turn although the progress write in flight never answers', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        board.board.progress = () => new Promise(() => {});
        const stack = stubGateStack();
        stack.gates.manager.runGate = (_key, _name, _command, { signal } = {}) =>
            new Promise((resolve) => {
                setTimeout(() => {
                    options.cancelRequested = true;
                }, 30);
                signal?.addEventListener('abort', () => resolve({ exitCode: 137, output: 'killed' }));
            });
        const runner = stubRunner(async (_job, _session, onOutput) => {
            onOutput?.('a tail the board never takes');
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.suspended).toEqual([gatedJob(1).id]);
    });

    it('settles a removed thread without a verdict when the remove lands during the gates', async () => {
        const options: { removedOnBeat?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const stack = stubGateStack();
        stack.gates.manager.runGate = (_key, _name, _command, { signal } = {}) => {
            options.removedOnBeat = true;
            return new Promise((resolve) => {
                signal?.addEventListener('abort', () => resolve({ exitCode: 137, output: 'killed' }));
            });
        };
        const runner = stubRunner(async () => ok());

        await drive({ ...board, runner, gates: stack.gates });

        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([]);
    });

    // The agent's ad-hoc gate runs go through the gate server, which the runner kill never reaches.
    it('cancels the ad-hoc gate token when the stop lands during the run', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const stack = stubGateStack();
        let token = '';
        stack.gates.server.register = (minted: string) => {
            token = minted;
        };
        const runner = stubRunner(async () => {
            options.cancelRequested = true;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return ok();
        });

        await drive({ ...board, runner, gates: stack.gates });

        expect(token).not.toBe('');
        expect(stack.stack.cancelled).toEqual([token]);
        expect(board.board.suspended).toEqual([gatedJob(1).id]);
    });

    it('cancels nothing on an ordinary finish', async () => {
        const board = stubBoard([gatedJob(1)]);
        const stack = stubGateStack();

        await drive({ ...board, runner: stubRunner(async () => ok()), gates: stack.gates });

        expect(stack.stack.cancelled).toEqual([]);
    });

    // A Stop landing while the tree probe is pending must park the turn without running the
    // gates, never complete a failed gate a `gate-failed` edge reads.
    it('parks the turn stopped when the stop lands during the pre-gate tree probe', async () => {
        const options: { cancelRequested?: boolean } = {};
        const board = stubBoard([gatedJob(1)], options);
        const runner = stubRunner(async () => ok(), {
            sync: { ok: true, reason: null, fingerprint: 'head:aaaa' },
        });
        let probeSignal: AbortSignal | undefined;
        runner.probeTree = async (_job, signal) => {
            probeSignal = signal;
            options.cancelRequested = true;
            while (runner.killed.length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
            return 'head:bbbb';
        };

        await drive({ ...board, runner, gates: stubGateStack({ test: 1 }).gates });

        expect(board.board.completed).toEqual([]);
        expect(board.board.suspended).toEqual([gatedJob(1).id]);
        // The transport is cancelled too, so a pending aux Job never holds the Stop.
        expect(probeSignal?.aborted).toBe(true);
    });
});

describe('a verdict the board refuses with a 5xx', () => {
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

    it('is retried, so the landed work keeps its verdict', async () => {
        const logs: string[] = [];
        const board = stubBoard([{ ...job(1), repo: 'Bellows-AI/factory' }]);
        const complete = board.board.complete.bind(board.board);
        let completes = 0;
        board.board.complete = async (j, result) => {
            completes += 1;
            if (completes < 3) throw new Error('/api/jobs/x/complete answered 503: busy');
            return complete(j, result);
        };
        const runner = stubRunner(async () => ok(), { publish: landed });

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(runner.published).toHaveLength(1);
        expect(completes).toBe(3);
        expect(board.board.completed).toHaveLength(1);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
        expect(logs.some((l) => l.includes('could not run, leaving it to the lease'))).toBe(false);
    });

    // Issue #820: the verdict was decided when the publish landed. A board that stays down past
    // the lease leaves it undelivered — never rewritten into a runner_error by the outer catch.
    it.each([
        ['an attempt with more to come', 1],
        ['the last attempt', 3],
    ])('retries for the lease, then leaves %s to the lease with its verdict unrewritten', async (_l, attempts) => {
        const logs: string[] = [];
        const board = stubBoard([{ ...job(1), repo: 'Bellows-AI/factory', attempts, maxAttempts: 3 }]);
        const sent: Parameters<Board['complete']>[1][] = [];
        board.board.complete = async (_j, result) => {
            sent.push(result);
            throw new BoardHttpError(503, '/api/jobs/x/complete answered 503: busy');
        };
        const runner = stubRunner(async () => ok(), { publish: landed });

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(sent.length).toBeGreaterThan(BOARD_CALL_ATTEMPTS);
        expect(sent.every((result) => result.status === 'succeeded' && result.publication)).toBe(true);
        expect(logs.some((l) => l.includes('could not run'))).toBe(false);
        expect(logs.some((l) => l.includes('the succeeded verdict was not delivered'))).toBe(true);
    });

    it('sends a verdict the board refuses as malformed exactly once', async () => {
        const logs: string[] = [];
        const board = stubBoard([{ ...job(1), repo: 'Bellows-AI/factory' }]);
        let completes = 0;
        board.board.complete = async () => {
            completes += 1;
            throw new BoardHttpError(400, '/api/jobs/x/complete answered 400: bad');
        };
        const runner = stubRunner(async () => ok(), { publish: landed });

        await drive({ ...board, runner, log: (m) => logs.push(m) });

        expect(completes).toBe(1);
        expect(logs.some((l) => l.includes('could not run'))).toBe(false);
    });

    it('answers publishFailed when the runner throws mid-publish', async () => {
        const board = stubBoard([{ ...job(1), repo: 'Bellows-AI/factory' }]);
        const runner = stubRunner(async () => ok(), { publish: landed });
        runner.publishGit = async () => {
            throw new Error('apiserver blip');
        };

        await drive({ ...board, runner });

        expect(board.board.completed[0]).toMatchObject({ status: 'failed', failureKind: 'publish' });
    });
});
