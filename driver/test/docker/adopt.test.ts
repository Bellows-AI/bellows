import { describe, expect, it, vitest } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { killMarkName } from '../../src/docker/docker-mailbox.js';
import { containerName, dockerArgs } from '../../src/docker/docker.js';
import { AdoptionBlocked, type AdoptedRun } from '../../src/runner.js';
import { ARTIFACT_LIMIT, CLOSE_READ_DEADLINE_MS, commandMark } from '../../src/runner.js';
import { supervisorName } from '../../src/docker/docker-mailbox.js';
import { SUPERVISOR_EXIT, SUPERVISOR_REPORT_PREFIX, SUPERVISOR_WINDDOWN_MS } from '../../src/supervisor-contract.js';
import { finalizeWaitMs, takeoverBoundMs } from '../../src/supervisor-plan.js';
import {
    job,
    hangsUntilAborted,
    hangsUntilTimeout,
    endsSoon,
    SESSION,
    opencodeJob,
    fakeChild,
    isAdoptListing,
    withState,
    chunkedChild,
    CUT_SHORT,
    splitEuro,
    SPLIT_EURO_CASES,
    expectWholeEuro,
    dockerRunner,
} from '../fixtures/docker-suite.js';

/*
 * Issue #792, the docker twin: a driver restarted while its runner container ran on. The claim
 * that superseded it reads the EXITED runner container of the earlier claim — exit code, log,
 * session — and only then removes it; the run is never redone.
 */
describe('adopting a finished runner container of an earlier claim (#792)', () => {
    const adopter: BoardJob = { ...job, leaseToken: '99999999-9999-4999-8999-999999999999', claimSeq: 2 };
    const listing = (
        seq = '1',
        lease = job.leaseToken,
        name = containerName({ ...job, leaseToken: lease }),
        command = commandMark(job.command)
    ) => `${name}\t${lease}\t${seq}\t${SESSION}\t${command}\n`;

    /** An attempt older than the one adopted, whose leftovers no adoption reads. */
    const OLDER = '77777777-7777-4777-8777-777777777777';
    /**
     * The fence's own listing: every container of the job by id and lease — the read run's runner
     * and exporter, and an older attempt's leftover.
     */
    const FENCE_PS = `a4a4a4a4a4a4\t${job.leaseToken}\na3a3a3a3a3a3\t${job.leaseToken}\na5a5a5a5a5a5\t${OLDER}\n`;
    /** The fence's volume listing: the read run's mailbox, and the older attempt's. */
    const FENCE_VOLUMES = `read-mailbox\t${job.leaseToken}\nolder-mailbox\t${OLDER}\n`;

    /**
     * The daemon, and the `docker logs` read the adoption streams through spawn — its argv recorded
     * among the daemon calls, in order, its child printing `log` and exiting `logExit`.
     */
    const daemon = (
        ps: string,
        supervisorExit = '0',
        log: string | Buffer[] = 'did the work\n',
        { logExit = 0, running = '' }: { logExit?: number; running?: string | Error } = {}
    ) => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            // The adoption's ONE listing of the job's runners (#829): the exited ones the test gave as `ps`, the
            // still-running ones as `running` (none unless a test lists one), each row ending in its state.
            if (isAdoptListing(args)) {
                return running instanceof Error
                    ? Promise.reject(running)
                    : Promise.resolve({ stdout: `${withState(ps, 'exited')}${withState(running, 'running')}` });
            }
            // The earlier attempt's supervisor: finalized (0) unless a test says how it ended.
            if (args[0] === 'wait') return Promise.resolve({ stdout: `${supervisorExit}\n` });
            if (args[0] === 'ps') return Promise.resolve({ stdout: FENCE_PS });
            if (args[0] === 'volume' && args[1] === 'ls') return Promise.resolve({ stdout: FENCE_VOLUMES });
            // No kill marker recorded: the daemon's own refusal for a volume that does not exist.
            if (args[0] === 'volume' && args[1] === 'inspect') {
                return Promise.reject(
                    Object.assign(new Error('docker volume inspect exited 1'), {
                        stderr: 'Error response from daemon: get factory-kill: no such volume',
                    })
                );
            }
            if (args[0] === 'inspect') {
                return Promise.resolve({
                    stdout: '{"Status":"exited","ExitCode":0,"StartedAt":"2026-10-01T00:00:00Z"}\n',
                });
            }
            return Promise.resolve({ stdout: '' });
        };
        const logs = ((_command: string, args: string[]) => {
            calls.push(args);
            return typeof log === 'string' ? fakeChild(log, '', logExit) : chunkedChild(log, logExit);
        }) as unknown as typeof spawn;
        return { exec, calls, logs };
    };

    /** The removals the daemon was asked for, by the name or id each named last. */
    const removals = (calls: string[][]) =>
        calls
            .filter((args) => args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm'))
            .map((args) => args.at(-1));
    /** Whether the runner's own log was read, or anything removed — the supervisor's report is read first. */
    const readOrRemoved = (calls: string[][]) =>
        calls.some((args) => (args[0] === 'logs' && !args.includes(supervisorName(job))) || args[0] === 'rm');
    /** The daemon of `daemon`, whose earlier supervisor logged `report` as its last line. */
    const withReport =
        (base: (args: string[]) => Promise<{ stdout: string }>, report: Record<string, unknown>) => (args: string[]) =>
            args[0] === 'logs' && args.includes(supervisorName(job))
                ? Promise.resolve({
                      stdout: `serving steps\n${SUPERVISOR_REPORT_PREFIX}${JSON.stringify({
                          outcome: 'completed',
                          cause: null,
                          agentExit: 0,
                          agentEnd: 'exit',
                          drained: true,
                          ...report,
                      })}\n`,
                  })
                : base(args);

    it('never misses a runner that exits while the earlier runners are listed: one listing, whatever the state', async () => {
        const { exec: base, calls, logs } = daemon('', '0', 'did the work\n');
        // The runner runs at the first listing and has exited by the next: a status filter would see it in neither.
        let listings = 0;
        const row = `${containerName(job)}\t${job.leaseToken}\t1\t${SESSION}\t${commandMark(job.command)}\n`;
        const exec = (args: string[]) => {
            if (!isAdoptListing(args)) return base(args);
            listings += 1;
            const filtered = args.find((arg) => arg.startsWith('status='));
            const state = listings === 1 ? 'running' : 'exited';
            return Promise.resolve({
                stdout: !filtered || filtered === `status=${state}` ? withState(row, state) : '',
            });
        };

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(listings).toBe(1);
        expect(calls.some((args) => args[0] === 'rm')).toBe(false);
    });

    // Issue #821 (D1): the read run is the evidence a later claim adopts again if this one is lost
    // before its verdict lands — kept, like the kubernetes Job the adoption spares, until the
    // reaper takes it once the job is terminal. Every older attempt's leftover goes, read first.
    it('reads the exit code, log and session, keeps the read run and sweeps the older leftovers', async () => {
        const { exec, calls, logs } = daemon(listing());

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, timedOut: false, sessionId: SESSION },
        });
        expect((adopted as AdoptedRun).outcome.output).toContain('did the work');
        // ONE listing of the job's runners, whatever state each is in: a runner that exits between two never goes unseen.
        expect(calls.filter(isAdoptListing)).toEqual([
            expect.arrayContaining(['ps', '-a', `label=factory.job=${job.id}`]),
        ]);
        expect(calls[0]).toSatisfy(isAdoptListing);
        expect(calls.some((args) => args.some((arg) => arg.startsWith('status=')))).toBe(false);
        const read = calls.findIndex((args) => args[0] === 'logs');
        const swept = calls.findIndex((args) => args[0] === 'rm' && args.includes('a5a5a5a5a5a5'));
        expect(read).toBeGreaterThanOrEqual(0);
        expect(swept).toBeGreaterThan(read);
        expect(removals(calls)).toEqual(['a5a5a5a5a5a5', 'older-mailbox']);
    });

    it('keeps the read run through every later fence of the adopting attempt', async () => {
        const { exec, calls, logs } = daemon(listing());
        const runner = dockerRunner(exec, { spawn: logs });

        await runner.adopt(adopter);
        calls.length = 0;
        await runner.probeTree(adopter, new AbortController().signal).catch(() => null);

        expect(calls.some((args) => args[0] === 'ps' && !isAdoptListing(args))).toBe(true);
        expect(removals(calls)).not.toContain('a4a4a4a4a4a4');
        expect(removals(calls)).not.toContain('a3a3a3a3a3a3');
        expect(removals(calls)).not.toContain('read-mailbox');
    });

    it('still sweeps every earlier attempt for a claim that adopted nothing', async () => {
        const { exec, calls, logs } = daemon(listing());

        await dockerRunner(exec, { spawn: logs })
            .probeTree(adopter, new AbortController().signal)
            .catch(() => null);

        expect(removals(calls)).toEqual(
            expect.arrayContaining(['a4a4a4a4a4a4', 'a3a3a3a3a3a3', 'a5a5a5a5a5a5', 'read-mailbox', 'older-mailbox'])
        );
    });

    // A run whose driver could not land its verdict closed its control endpoint and left the group:
    // with nothing left to serve, its supervisor exited finalized — the run the next claim adopts.
    it('adopts a group whose supervisor exited finalized after its endpoint closed', async () => {
        const { exec, logs } = daemon(listing(), String(SUPERVISOR_EXIT.finalized));

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true, timedOut: false } });
        expect((adopted as AdoptedRun | null)?.outcome).not.toHaveProperty('infraLoss');
    });

    // Issue #796: a run read but never swept is no adoption — and, like the kubernetes twin, the
    // attempt stands down to its lease rather than run afresh over that run's tree (#824).
    it('rejects when an older leftover cannot be swept', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const exec = (args: string[]) => {
            if (args[0] !== 'rm') return base(args);
            calls.push(args);
            return Promise.reject(new Error('the daemon answered 503'));
        };

        const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter);
        await expect(adopting).rejects.toBeInstanceOf(AdoptionBlocked);
        await expect(adopting).rejects.toThrow('the daemon answered 503');

        const read = calls.findIndex((args) => args[0] === 'logs');
        expect(read).toBeGreaterThanOrEqual(0);
        expect(calls.findIndex((args) => args[0] === 'rm')).toBeGreaterThan(read);
    });

    // #869: the supplied stand-down ends every read of the adoption — the evidence, the log stream and the
    // close-time readout — never a daemon call or a child that outlives the abandoned attempt.
    it.each([
        ['the kill-record read', (args: string[]) => args[0] === 'volume' && args[1] === 'inspect'],
        ['the supervisor report read', (args: string[]) => args[0] === 'logs' && args.includes(supervisorName(job))],
        ['the exited runner inspect', (args: string[]) => args[0] === 'inspect'],
        ['the close-time session readout', (args: string[]) => args[0] === 'run'],
    ])('ends %s on the supplied signal', async (_name, hang) => {
        const { exec: base, logs } = daemon(listing());
        let hung = false;
        const exec = (args: string[], options?: { signal?: AbortSignal }) => {
            if (!hang(args)) return base(args);
            hung = true;
            return hangsUntilAborted(options);
        };
        const stop = new AbortController();

        const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter, stop.signal);
        await vitest.waitFor(() => expect(hung).toBe(true));
        stop.abort();
        expect(await endsSoon(adopting)).toBe(true);
    });

    // #869: every read of the adoption ends by ONE absolute deadline; a stalled daemon holds none of them.
    it.each([
        ['the kill-record read', (args: string[]) => args[0] === 'volume' && args[1] === 'inspect'],
        ['the supervisor report read', (args: string[]) => args[0] === 'logs' && args.includes(supervisorName(job))],
        ['the exited runner inspect', (args: string[]) => args[0] === 'inspect'],
    ])('ends %s by the adoption’s deadline', async (_name, hang) => {
        vitest.useFakeTimers();
        try {
            const { exec: base, logs } = daemon(listing());
            const exec = (args: string[], options?: { timeout?: number }) =>
                hang(args) ? hangsUntilTimeout(options) : base(args);
            let ended = false;
            const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter);
            adopting.then(
                () => (ended = true),
                () => (ended = true)
            );

            await vitest.advanceTimersByTimeAsync(CLOSE_READ_DEADLINE_MS + 1_000);

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
    });

    it('kills the runner log stream at the adoption’s deadline', async () => {
        vitest.useFakeTimers();
        try {
            const { exec } = daemon(listing());
            const logs = ((_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
                const child = new EventEmitter() as ChildProcess;
                child.stdout = new EventEmitter() as Readable;
                child.stderr = new EventEmitter() as Readable;
                options?.signal?.addEventListener('abort', () => child.emit('error', new Error('aborted')));
                return child;
            }) as unknown as typeof spawn;
            let ended = false;
            const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter);
            adopting.then(
                () => (ended = true),
                () => (ended = true)
            );

            await vitest.advanceTimersByTimeAsync(CLOSE_READ_DEADLINE_MS + 1_000);

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
    });

    it('ends the runner log stream on the supplied signal', async () => {
        const { exec, calls } = daemon(listing());
        let streamed: AbortSignal | undefined;
        const logs = ((_command: string, args: string[], options?: { signal?: AbortSignal }) => {
            calls.push(args);
            streamed = options?.signal;
            const child = new EventEmitter() as ChildProcess;
            child.stdout = new EventEmitter() as Readable;
            child.stderr = new EventEmitter() as Readable;
            options?.signal?.addEventListener('abort', () => child.emit('error', new Error('aborted')));
            return child;
        }) as unknown as typeof spawn;
        const stop = new AbortController();

        const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter, stop.signal);
        await vitest.waitFor(() => expect(streamed).toBeDefined());
        stop.abort();
        expect(await endsSoon(adopting)).toBe(true);
    });

    // The supervisor outlives the agent to finalize: the next claim waits for it rather than
    // reading a half-finished group, and a supervisor lost mid-finalize adopts nothing — and
    // sweeps nothing: the group stays for the fence the sync runs.
    it('waits for the earlier attempt’s supervisor before it reads, and reads its deadline exit as a timeout', async () => {
        const { exec, calls, logs } = daemon(listing(), '124');

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome.timedOut).toBe(true);
        const waited = calls.findIndex((args) => args[0] === 'wait');
        expect(waited).toBeGreaterThanOrEqual(0);
        expect(calls.findIndex((args) => args[0] === 'logs')).toBeGreaterThan(waited);
    });

    // #829 S3: a released group's supervisor may wait the takeover grace for a holder before it finalizes.
    it('waits for the earlier attempt’s supervisor the wind-down and the takeover grace', async () => {
        const { exec: base, logs } = daemon(listing());
        const timeouts: (number | undefined)[] = [];
        const exec = (args: string[], options?: { timeout?: number }) => {
            if (args[0] === 'wait') timeouts.push(options?.timeout);
            return base(args);
        };

        await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(timeouts).toEqual([finalizeWaitMs(loadDriverConfig({}))]);
    });

    // The wait scales with the lease it must outlast: a fixed one ends before a long lease's takeover bound.
    it('waits for the earlier supervisor longer at a long lease', async () => {
        const { exec: base, logs } = daemon(listing());
        const timeouts: (number | undefined)[] = [];
        const exec = (args: string[], options?: { timeout?: number }) => {
            if (args[0] === 'wait') timeouts.push(options?.timeout);
            return base(args);
        };
        const env = { DRIVER_LEASE_SECONDS: '3600' };

        await dockerRunner(exec, { spawn: logs, env }).adopt(adopter);

        expect(timeouts).toEqual([finalizeWaitMs(loadDriverConfig(env))]);
        expect(timeouts[0]).toBeGreaterThan(takeoverBoundMs(loadDriverConfig(env)));
    });

    // A killed supervisor with no recorded reason is a supervisor lost — also where a record the
    // daemon refused leaves a run its driver killed: the job runs again, its checkout and session kept.
    it('adopts nothing and removes nothing when the earlier supervisor was lost before it finalized', async () => {
        const { exec, calls, logs } = daemon(listing(), '137');

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    it('adopts nothing when the earlier supervisor lost its driver before it released the agent', async () => {
        const { exec, calls, logs } = daemon(listing(), String(SUPERVISOR_EXIT.lost));

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    // A group whose driver was lost before it released the agent reports too, and exits 75: no run.
    it('adopts nothing when the lost supervisor logged that its agent was never launched', async () => {
        const { exec: base, calls, logs } = daemon(listing(), String(SUPERVISOR_EXIT.lost));
        const exec = withReport(base, {
            outcome: 'lost',
            cause: 'driver_lost',
            agentExit: null,
            agentEnd: 'unlaunched',
        });

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    // Issue #824: the report is the supervisor's finalization — a crash after it does not unsay it.
    it('adopts a run whose supervisor crashed after logging its final report', async () => {
        const { exec: base, logs } = daemon(listing(), String(SUPERVISOR_EXIT.failed));

        const adopted = await dockerRunner(withReport(base, {}), { spawn: logs }).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true } });
        expect((adopted as AdoptedRun | null)?.outcome).not.toHaveProperty('infraLoss');
    });

    /** The daemon of `daemon`, refusing the earlier supervisor's `docker logs` with `stderr`. */
    const refusingSupervisorLog =
        (base: (args: string[]) => Promise<{ stdout: string }>, stderr: string) => (args: string[]) =>
            args[0] === 'logs' && args.includes(supervisorName(job))
                ? Promise.reject(Object.assign(new Error('docker logs exited 1'), { stderr }))
                : base(args);

    // Failure injection: a supervisor log the daemon would not serve is no answer — not "no report".
    it('stands down, removing nothing, when the earlier supervisor log cannot be read', async () => {
        const { exec: base, calls, logs } = daemon(listing(), String(SUPERVISOR_EXIT.failed));
        const exec = refusingSupervisorLog(base, 'Error response from daemon: i/o timeout');

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
        expect(readOrRemoved(calls)).toBe(false);
    });

    it('reads a supervisor container already gone as one that logged no report', async () => {
        const { exec: base, calls, logs } = daemon(listing(), String(SUPERVISOR_EXIT.failed));
        const exec = refusingSupervisorLog(base, 'Error response from daemon: No such container: factory-supervisor');

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    // A Stop while the re-claim fence lists what to remove: the abandoned adoption removes nothing.
    it('removes nothing once the attempt stands down during the fence of an adopted run', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const standDown = new AbortController();
        const exec = (args: string[]) => {
            if (args[0] === 'ps' && !isAdoptListing(args)) standDown.abort();
            return base(args);
        };

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);
        expect(removals(calls)).toEqual([]);
    });

    // Once an exited earlier runner is found, nothing unexpected may fall through to a fresh run,
    // whose fence would remove that run unread: any throw stands the attempt down.
    it('stands down, removing nothing, on any unexpected throw once an exited runner is found', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const exec = (args: string[]) =>
            args[0] === 'inspect' ? Promise.reject(new TypeError('something unforeseen')) : base(args);

        const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter);

        await expect(adopting).rejects.toBeInstanceOf(AdoptionBlocked);
        await expect(adopting).rejects.toThrow('something unforeseen');
        expect(removals(calls)).toEqual([]);
    });

    /** The daemon of `daemon`, refusing the adoption's exited-runner listing `refusals` times. */
    const refusingDiscovery = (base: (args: string[]) => Promise<{ stdout: string }>, refusals: number) => {
        let left = refusals;
        return (args: string[]) =>
            isAdoptListing(args) && left-- > 0
                ? Promise.reject(new Error('Cannot connect to the Docker daemon'))
                : base(args);
    };

    // Failure injection: a listing the daemon refused is no "nothing to adopt" — a fresh run's fence
    // would remove a finalizing group unread once the daemon answers again.
    it('stands down, removing nothing, when the exited runners cannot be listed', async () => {
        const { exec: base, calls, logs } = daemon(listing());

        await expect(dockerRunner(refusingDiscovery(base, 99), { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(
            AdoptionBlocked
        );
        expect(removals(calls)).toEqual([]);
    });

    // #869: an earlier runner whose discovery labels are corrupt is no "nothing to adopt" either.
    it.each([
        ['a corrupt claim sequence', listing('corrupt')],
        ['a lease label that is no lease', listing('1', 'corrupt', 'factory-runner-x')],
    ])('stands down, removing nothing, when an exited runner is listed with %s', async (_name, ps) => {
        const { exec, calls, logs } = daemon(ps);

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
        expect(removals(calls)).toEqual([]);
    });

    it('lists the exited runners again after a refusal, and adopts the one it finds', async () => {
        const { exec: base, logs } = daemon(listing());

        expect(await dockerRunner(refusingDiscovery(base, 1), { spawn: logs }).adopt(adopter)).toMatchObject({
            claimSeq: 1,
        });
    });

    /*
     * Class (a), #824: a docker answer that is not confirmed is never taken for "gone", "no record"
     * or an exit. Each row answers one read of the adoption with something that proves nothing.
     */
    const answering =
        (base: (args: string[]) => Promise<{ stdout: string }>, match: (args: string[]) => boolean, stdout: string) =>
        (args: string[]) =>
            match(args) ? Promise.resolve({ stdout }) : base(args);
    const isWait = (args: string[]) => args[0] === 'wait';
    it.each<
        [
            string,
            (base: (args: string[]) => Promise<{ stdout: string }>) => (args: string[]) => Promise<{ stdout: string }>,
        ]
    >([
        ['an empty `docker wait` answer', (base) => answering(base, isWait, '')],
        ['a non-numeric `docker wait` answer', (base) => answering(base, isWait, 'exited\n')],
        ['a `docker wait` answer with trailing garbage', (base) => answering(base, isWait, '0 garbage\n')],
        ['an inspect state with no exit code', (base) => answering(base, (args) => args[0] === 'inspect', '{}\n')],
        [
            'kill marker labels that are not JSON',
            (base) => answering(base, (args) => args[0] === 'volume' && args[1] === 'inspect', '{not json\n'),
        ],
        [
            'kill marker labels that are not a label map',
            (base) => withMarks(base, { [killMarkName(job, 'timeout')]: 'x' as never }),
        ],
        [
            'a supervisor log refused with a generic "not found"',
            (base) => refusingSupervisorLog(base, 'Error response from daemon: page not found'),
        ],
    ])('stands down, removing nothing, on %s', async (_what, wrap) => {
        const { exec: base, calls, logs } = daemon(listing());

        await expect(dockerRunner(wrap(base), { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
        expect(readOrRemoved(calls)).toBe(false);
    });

    // Paced like the kubernetes listing (its verdict reads sleep between retries), and a stand-down
    // during the pause ends it: no further listing, the adoption abandoned.
    it('pauses between listings of the exited runners after a refusal', async () => {
        const { exec: base, logs } = daemon(listing());
        const events: string[] = [];
        const listed = refusingDiscovery(base, 1);
        const exec = (args: string[]) => {
            if (isAdoptListing(args)) events.push('ps');
            return listed(args);
        };
        const sleep = async (ms: number) => {
            events.push(`sleep ${ms > 0}`);
        };

        expect(await dockerRunner(exec, { spawn: logs, sleep }).adopt(adopter)).toMatchObject({ claimSeq: 1 });
        expect(events).toEqual(['ps', 'sleep true', 'ps']);
    });

    it('abandons the adoption when the attempt stands down during the pause between listings', async () => {
        const { exec: base, logs } = daemon(listing());
        const standDown = new AbortController();
        let listings = 0;
        const listed = refusingDiscovery(base, 1);
        const exec = (args: string[]) => {
            if (isAdoptListing(args)) listings += 1;
            return listed(args);
        };
        const sleep = (_ms: number, signal?: AbortSignal) => {
            standDown.abort();
            return signal?.aborted ? Promise.reject(new Error('The operation was aborted')) : Promise.resolve();
        };

        await expect(dockerRunner(exec, { spawn: logs, sleep }).adopt(adopter, standDown.signal)).rejects.toThrow(
            /abandoned/
        );
        expect(listings).toBe(1);
    });

    /** The daemon of `daemon`, whose `docker wait` on the earlier supervisor rejects with `error`. */
    const failingWait = (base: (args: string[]) => Promise<{ stdout: string }>, error: Error) => (args: string[]) =>
        args[0] === 'wait' ? Promise.reject(error) : base(args);

    // Failure injection: a `docker wait` the daemon failed is no answer — not the wind-down elapsed,
    // which would leave a supervisor still finalizing to the sweep.
    it('stands down, removing nothing, when the wait on the earlier supervisor fails', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const failure = Object.assign(new Error('docker wait exited 1'), {
            stderr: 'Error response from daemon: connection reset',
        });

        await expect(dockerRunner(failingWait(base, failure), { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(
            AdoptionBlocked
        );
        expect(readOrRemoved(calls)).toBe(false);
    });

    it('takes a supervisor still running at the end of the wind-down as one that did not finalize', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const timedOut = Object.assign(new Error('docker wait timed out'), { killed: true, signal: 'SIGTERM' });

        expect(await dockerRunner(failingWait(base, timedOut), { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    // A Stop or a lost lease while the supervisor finalizes: the abandoned adoption removes nothing.
    it('abandons the wait when the attempt stands down, removing nothing', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const standDown = new AbortController();
        // The supervisor ends at the very moment the attempt stands down.
        const exec = (args: string[]) => {
            if (args[0] === 'wait') standDown.abort();
            return base(args);
        };

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);
        expect(readOrRemoved(calls)).toBe(false);
    });

    /** The daemon of `daemon`, holding the kill marker volumes `marks` (name → labels); any other is no such volume. */
    const withMarks =
        (base: (args: string[]) => Promise<{ stdout: string }>, marks: Record<string, Record<string, string>>) =>
        (args: string[]) => {
            if (args[0] !== 'volume' || args[1] !== 'inspect') return base(args);
            const labels = marks[args.at(-1) as string];
            if (labels) return Promise.resolve({ stdout: `${JSON.stringify(labels)}\n` });
            const refused = Object.assign(new Error('docker volume inspect exited 1'), {
                stderr: 'Error response from daemon: get factory-kill: no such volume',
            });
            return Promise.reject(refused);
        };
    const mark = (reason: string, detail: string, lease = job.leaseToken) => ({
        [killMarkName(job, reason)]: {
            'factory.job': job.id,
            'factory.lease': lease,
            [`factory.kill.${reason}`]: detail,
        },
    });

    // Why the lost driver ended the run was recorded on the attempt before its kill: the adoption
    // reads the verdict the attached run would have, never the supervisor the kill took down.
    it.each<[string, string, Record<string, unknown>]>([
        [
            'a cache loss',
            'cache_lost',
            { cacheLost: '3 consecutive turns with no prompt-cache reads', timedOut: false },
        ],
        ['a timeout', 'timeout', { timedOut: true }],
    ])('adopts a run its lost driver hard-killed for %s as that verdict', async (_what, reason, fields) => {
        const { exec: base, calls, logs } = daemon(listing(), '137');
        const detail = reason === 'cache_lost' ? '3 consecutive turns with no prompt-cache reads' : '';
        const exec = withMarks(base, mark(reason, detail));

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome).toMatchObject({ started: true, ...fields });
        expect((adopted as AdoptedRun | null)?.outcome).not.toHaveProperty('infraLoss');
        // The record is the earlier attempt's, kept with the read run for a later adoption (#821).
        expect(calls.some((args) => args[0] === 'rm' && args.includes('a4a4a4a4a4a4'))).toBe(false);
    });

    it('adopts a supervised stop its lost driver recorded for a full spool, with the spool fault', async () => {
        const { exec: base, logs } = daemon(listing(), '0');
        const exec = withMarks(base, mark('artifact_spool_full', '2000000000 bytes'));

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome.artifactSpoolFull).toBe('2000000000 bytes');
    });

    // A full spool rides a supervised stop, so its record never explains how the supervisor ended:
    // one lost after it (#805), or taken down when the stop fell back to the hard kill — which on
    // kubernetes deletes the Job and its record — is run again, on both executors.
    it.each(['70', '137'])(
        'never takes a recorded full spool for the end of a supervisor that exited %s',
        async (exit) => {
            const { exec: base, calls, logs } = daemon(listing(), exit);
            const exec = withMarks(base, mark('artifact_spool_full', '2000000000 bytes'));

            expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
            expect(readOrRemoved(calls)).toBe(false);
        }
    );

    it('never reads a record of another attempt as this one’s', async () => {
        const { exec: base, logs } = daemon(listing(), '137');
        const exec = withMarks(base, mark('cache_lost', 'collapsed', '77777777-7777-4777-8777-777777777777'));

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
    });

    // Issue #824: a stop the supervisor raised itself (its own spool watch) is in the report it logged.
    it('adopts a full spool the earlier supervisor raised itself, from its final report', async () => {
        const { exec: base, logs } = daemon(listing(), '0');
        const exec = withReport(base, { outcome: 'failed', cause: 'artifact_spool_full', agentEnd: 'killed' });

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome.artifactSpoolFull).toBe(
            'the supervisor reported the spool full'
        );
        expect((adopted as AdoptedRun | null)?.outcome).not.toHaveProperty('infraLoss');
    });

    it('reads no stop from a supervisor that logged no report', async () => {
        const { exec, logs } = daemon(listing(), '0');

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome.artifactSpoolFull).toBeUndefined();
    });

    // A queued task's command can be edited after a handover: a run of the old command is not its run.
    it('never adopts a run of a command since edited', async () => {
        const { exec, calls, logs } = daemon(
            listing('1', job.leaseToken, containerName(job), commandMark('another command'))
        );

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(calls.some((args) => args[0] === 'logs')).toBe(false);
    });

    // Failure injection (#825): a log past an exec's output buffer streams; it never fails the adoption.
    it('adopts a runner whose log outgrew an exec buffer: its tail kept, flagged truncated', async () => {
        const EXEC_MAX_BUFFER = 1024 * 1024;
        const line = 'body line\n';
        const { exec: base, calls, logs } = daemon(listing(), '0', line.repeat(EXEC_MAX_BUFFER / line.length + 1));
        const exec = (args: string[]) =>
            args[0] === 'logs' && !args.includes(supervisorName(job))
                ? Promise.reject(
                      Object.assign(new Error('stdout maxBuffer length exceeded'), {
                          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                      })
                  )
                : base(args);

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome.logTruncated).toBe(true);
        expect((adopted as AdoptedRun | null)?.outcome.fullLog?.endsWith(line)).toBe(true);
        expect(Buffer.byteLength((adopted as AdoptedRun | null)?.outcome.fullLog ?? '')).toBeLessThanOrEqual(
            ARTIFACT_LIMIT
        );
        expect(Buffer.byteLength((adopted as AdoptedRun | null)?.outcome.output ?? '')).toBeLessThanOrEqual(16 * 1024);
        const read = calls.findIndex((args) => args[0] === 'logs');
        expect(read).toBeGreaterThanOrEqual(0);
        expect(calls.findIndex((args) => args[0] === 'rm')).toBeGreaterThan(read);
    });

    it('adopts a short log whole and complete', async () => {
        const { exec, logs } = daemon(listing());

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome).toMatchObject({
            fullLog: 'did the work\n',
            logTruncated: false,
        });
    });

    it('decodes a multibyte character split across two log chunks once, whole — below and above the cap', async () => {
        for (const [body, truncated] of SPLIT_EURO_CASES) {
            const { exec, logs } = daemon(listing(), '0', splitEuro(body));

            const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

            expectWholeEuro((adopted as AdoptedRun | null)?.outcome, truncated);
        }
    });

    it('keeps the bytes of an adopted log that ended inside a character, never drops them', async () => {
        const { exec, logs } = daemon(listing(), '0', CUT_SHORT);

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect((adopted as AdoptedRun | null)?.outcome).toMatchObject({ fullLog: 'ok\uFFFD', logTruncated: false });
    });

    it('rejects an adoption whose log read failed, and removes nothing', async () => {
        const { exec, calls, logs } = daemon(listing(), '0', 'Error: No such container\n', { logExit: 1 });

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toThrow(/docker logs/);
        expect(calls.some((args) => args[0] === 'rm')).toBe(false);
    });

    it('adopts nothing of its own claim, a newer one, or a container that is not the runner', async () => {
        const own = listing('2', adopter.leaseToken);
        const notRunner = listing('1', job.leaseToken, `factory-svc-${job.id}-db`);
        const { exec, calls, logs } = daemon(own + notRunner);

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(calls.some((args) => args[0] === 'rm')).toBe(false);
    });

    it('answers null when no earlier runner exited', async () => {
        const { exec } = daemon('');
        expect(await dockerRunner(exec).adopt(adopter)).toBeNull();
    });

    it('labels every runner container with its claim sequence and session', () => {
        const args = dockerArgs(
            loadDriverConfig({}),
            job,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(args).toEqual(
            expect.arrayContaining([
                '--label',
                'factory.claim-seq=1',
                '--label',
                `factory.session=${SESSION}`,
                '--label',
                `factory.command=${commandMark(job.command)}`,
            ])
        );
    });

    // Issue #822: a claim continuing an interrupted attempt is framed in its prompt alone; the
    // container is labelled with the unframed command, as the interrupted attempt's runner was.
    it.each([
        ['claude-code', job, SESSION],
        ['opencode', opencodeJob, 'ses_abc123'],
    ])(
        'frames a %s continuation into its prompt alone, labelling the container with the unframed command',
        (_name, claimed, session) => {
            const line = dockerArgs(
                loadDriverConfig({}),
                { ...claimed, claimSeq: 2, resumeSessionId: session, ownSession: true, continuesInterrupted: true },
                { id: session, resume: true },
                { envFile: '/tmp/env-file' }
            );

            expect(line.at(-1)?.startsWith('Your previous run of this task was interrupted')).toBe(true);
            expect(line.at(-1)?.endsWith(`The task, for reference:\n\n${claimed.command}`)).toBe(true);
            expect(line).toContain(`factory.command=${commandMark(claimed.command)}`);
        }
    );

    // Issue #822: the runner of an interrupted attempt exited while its takeover or handover was
    // being claimed. The continuing claim carries the command the first claim ran, so the label
    // that runner was started with is its own, and the run is adopted, never redone.
    it('adopts, for a claim continuing an interrupted attempt, the runner its first claim started', async () => {
        const started = dockerArgs(
            loadDriverConfig({}),
            job,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        const mark = started.find((arg) => arg.startsWith('factory.command='))!.slice('factory.command='.length);
        const { exec, logs } = daemon(listing('1', job.leaseToken, containerName(job), mark));
        const continuing = { ...adopter, resumeSessionId: SESSION, ownSession: true, continuesInterrupted: true };

        expect(await dockerRunner(exec, { spawn: logs }).adopt(continuing)).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, sessionId: SESSION },
        });
    });

    // #829: a released group's agent still runs (its runner container is up): taken over, not read.
    describe('a live run (#829)', () => {
        const supervisorUp = (up: boolean | 'garbled') => (args: string[]) => {
            if (args[0] !== 'inspect') return;
            if (args.includes(supervisorName(job))) {
                return Promise.resolve({
                    stdout:
                        up === 'garbled' ? 'not json' : `{"Status":"${up ? 'running' : 'exited'}","Running":${up}}\n`,
                });
            }
            return Promise.resolve({
                stdout: '{"Status":"running","Running":true,"StartedAt":"2026-10-01T00:00:00Z"}\n',
            });
        };
        const liveDaemon = (up: boolean | 'garbled' = true, running: string | Error = listing()) => {
            const { exec: base, calls, logs } = daemon('', '0', 'did the work\n', { running });
            const inspect = supervisorUp(up);
            const exec = (args: string[]) => inspect(args) ?? base(args);
            return { exec, calls, logs };
        };

        it('answers a running runner whose supervisor runs as live, recording the group and sweeping only the older', async () => {
            const { exec, calls, logs } = liveDaemon();

            const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

            expect(adopted).toMatchObject({
                live: true,
                claimSeq: 1,
                session: SESSION,
                startedAt: '2026-10-01T00:00:00Z',
                prior: { id: job.id, leaseToken: job.leaseToken },
            });
            // The live run's own objects stay; the older attempt's go.
            expect(removals(calls)).toEqual(['a5a5a5a5a5a5', 'older-mailbox']);
            expect(calls.some((args) => args[0] === 'logs')).toBe(false);
            expect(calls.some((args) => args[0] === 'wait')).toBe(false);
        });

        it('follows the live runner of the prior lease on a resumed run: no create, no env, no start, no go order', async () => {
            const { exec, calls, logs } = liveDaemon();
            const runner = dockerRunner(exec, { spawn: logs });
            const live = await runner.adopt(adopter);
            expect(live).toMatchObject({ live: true });
            calls.length = 0;
            const taken: BoardJob = {
                ...adopter,
                groupLease: job.leaseToken,
                supervisorEnv: { SUPERVISOR_CONTROL_TOKEN: 'tok-new', SUPERVISOR_CONTROL_URL: 'http://driver/' },
            };

            const outcome = await runner.run(taken, { id: SESSION, resume: true });

            // The followed log ended and the bounded `docker wait` said how the runner exited.
            expect(outcome).toMatchObject({ exitCode: 0 });
            expect(calls.some((args) => args[0] === 'wait')).toBe(true);

            const named = containerName({ ...job, leaseToken: job.leaseToken });
            // The very first daemon call is the follow: nothing was created, copied or started before it.
            expect(calls[0]).toEqual(['logs', '-f', named]);
            for (const args of calls) {
                expect(args[0]).not.toMatch(/^(create|start|cp)$/);
                expect(args.join(' ')).not.toContain(containerName(adopter));
            }
        });

        /** A `docker logs -f` held open until the test closes it, remembering the signal it was spawned with. */
        const heldFollow = () => {
            const seen: { signal: AbortSignal | undefined; close: (code: number | null) => void }[] = [];
            const spawnHeld = ((_command: string, args: string[], options?: { signal?: AbortSignal }) => {
                const child = new EventEmitter() as ChildProcess;
                child.stdout = new EventEmitter() as Readable;
                child.stderr = new EventEmitter() as Readable;
                const entry = {
                    signal: options?.signal,
                    close: (code: number | null) => void child.emit('close', code),
                };
                options?.signal?.addEventListener('abort', () => entry.close(null));
                if (args[0] === 'logs' && args[1] === '-f') seen.push(entry);
                else process.nextTick(() => child.emit('close', 0));
                return child;
            }) as unknown as typeof spawn;
            return { seen, spawnHeld };
        };
        const takenJob = (): BoardJob => ({
            ...adopter,
            groupLease: job.leaseToken,
            supervisorEnv: { SUPERVISOR_CONTROL_TOKEN: 'tok-new', SUPERVISOR_CONTROL_URL: 'http://driver/' },
        });

        it('keeps the followed log open through a kill, then reads the exit like a started run', async () => {
            const { exec } = liveDaemon(true, listing());
            const { seen, spawnHeld } = heldFollow();
            const runner = dockerRunner(
                (args) =>
                    args[0] === 'wait' && !args.includes(supervisorName(job))
                        ? Promise.resolve({ stdout: '137\n' })
                        : exec(args),
                { spawn: spawnHeld }
            );
            await runner.adopt(adopter);
            const taken = takenJob();
            const running = runner.run(taken, { id: SESSION, resume: true });
            await vitest.waitFor(() => expect(seen).toHaveLength(1));

            await runner.kill(taken);

            // The kill ends the container, not the stream: the log closes by itself, as `start -a` does.
            expect(seen[0]?.signal?.aborted).toBe(false);
            seen[0]?.close(0);
            await expect(running).resolves.toMatchObject({ exitCode: 137 });
        });

        it('keeps the followed log open through a Stop, then reads the exit like a started run', async () => {
            const { exec, calls } = liveDaemon(true, listing());
            const { seen, spawnHeld } = heldFollow();
            const runner = dockerRunner(
                (args) =>
                    args[0] === 'wait' && !args.includes(supervisorName(job))
                        ? Promise.resolve({ stdout: '143\n' })
                        : exec(args),
                { spawn: spawnHeld }
            );
            await runner.adopt(adopter);
            const taken = takenJob();
            const running = runner.run(taken, { id: SESSION, resume: true });
            await vitest.waitFor(() => expect(seen).toHaveLength(1));

            await runner.stopAgent(taken);

            // The Stop ends the agent, not the stream: the log closes by itself and the exit is read from the runner.
            expect(seen[0]?.signal?.aborted).toBe(false);
            expect(calls.some((args) => args[0] === 'ps' && args.includes('label=factory.role=agent'))).toBe(true);
            seen[0]?.close(0);
            await expect(running).resolves.toMatchObject({ exitCode: 143, timedOut: false });
        });

        it('times a resumed run out when its budget and wind-down have passed with the runner still up', async () => {
            vitest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            try {
                const { exec } = liveDaemon(true, listing());
                const { seen, spawnHeld } = heldFollow();
                const runner = dockerRunner(exec, { spawn: spawnHeld });
                const live = await runner.adopt(adopter);
                expect(live).toMatchObject({ live: true, startedAt: '2026-10-01T00:00:00Z' });
                // The run started a budget ago: only the wind-down is left on its backstop.
                vitest.setSystemTime(Date.parse('2026-10-01T00:00:00Z') + 24 * 60 * 60 * 1000);
                const running = runner.run(takenJob(), { id: SESSION, resume: true });
                await vitest.advanceTimersByTimeAsync(0);
                expect(seen).toHaveLength(1);

                await vitest.advanceTimersByTimeAsync(SUPERVISOR_WINDDOWN_MS + 1_000);
                seen[0]?.close(0);

                await expect(running).resolves.toMatchObject({ timedOut: true });
            } finally {
                vitest.useRealTimers();
            }
        });

        it('counts nothing spent when the runner start cannot be read: the backstop keeps the whole budget', async () => {
            vitest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            try {
                const { exec } = liveDaemon(true, listing());
                const { seen, spawnHeld } = heldFollow();
                const runner = dockerRunner(
                    (args) =>
                        args[0] === 'inspect' && !args.includes(supervisorName(job))
                            ? Promise.resolve({ stdout: '{"Status":"running","Running":true}\n' })
                            : exec(args),
                    { spawn: spawnHeld }
                );
                const live = await runner.adopt(adopter);
                expect(live).toMatchObject({ live: true, startedAt: '' });
                const running = runner.run(takenJob(), { id: SESSION, resume: true });
                await vitest.advanceTimersByTimeAsync(0);
                expect(seen).toHaveLength(1);

                // Past the wind-down alone, which is all a start read as the epoch would leave.
                await vitest.advanceTimersByTimeAsync(SUPERVISOR_WINDDOWN_MS + 1_000);
                seen[0]?.close(0);

                await expect(running).resolves.toMatchObject({ timedOut: false });
            } finally {
                vitest.useRealTimers();
            }
        });

        it('hangs up on the followed log only when the attempt is abandoned', async () => {
            const { exec } = liveDaemon(true, listing());
            const { seen, spawnHeld } = heldFollow();
            const runner = dockerRunner(exec, { spawn: spawnHeld });
            await runner.adopt(adopter);
            const taken = takenJob();
            const running = runner.run(taken, { id: SESSION, resume: true });
            await vitest.waitFor(() => expect(seen).toHaveLength(1));

            runner.abandon(taken);

            expect(seen[0]?.signal?.aborted).toBe(true);
            await expect(running).rejects.toThrow(/ended with a signal/);
        });

        it('answers nothing for a group no runner container runs (created, never started)', async () => {
            const { exec, calls, logs } = liveDaemon(true, '');

            expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
            expect(removals(calls)).toEqual([]);
        });

        it.each([
            ['refused', new Error('the daemon answered 503')],
            ['garbled', 'a\tb\n'],
        ])('blocks the attempt when the running listing is %s', async (_label, running) => {
            const { exec, calls, logs } = liveDaemon(true, running);

            await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
            expect(removals(calls)).toEqual([]);
        });

        it.each([
            ['stopped', false],
            ['unreadable', 'garbled' as const],
        ])(
            'blocks the attempt, removing nothing, when the supervisor of a running runner is %s',
            async (_label, up) => {
                const { exec, calls, logs } = liveDaemon(up);

                await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(
                    AdoptionBlocked
                );
                expect(removals(calls)).toEqual([]);
            }
        );

        describe('whose runner exited while its supervisor still serves the steps', () => {
            const RELEASED = 'supervisor: released the agent';
            const SERVED = 'supervisor: stopped serving the steps';
            /** An exited runner whose supervisor answers `inspect` and `logs` as given (a string, or a rejection). */
            const exitedDaemon = (
                inspect: string | Error = '{"Status":"running","Running":true}\n',
                log: string | Error = `serving\n${RELEASED}\n`
            ) => {
                const { exec: base, calls, logs } = daemon(listing(), '0', 'did the work\n');
                const exec = (args: string[]) => {
                    const forSupervisor = args.includes(supervisorName(job));
                    if (args[0] === 'inspect' && forSupervisor) {
                        calls.push(args);
                        return inspect instanceof Error
                            ? Promise.reject(inspect)
                            : Promise.resolve({ stdout: inspect });
                    }
                    if (args[0] === 'logs' && forSupervisor && !args.includes('--tail')) {
                        calls.push(args);
                        return log instanceof Error ? Promise.reject(log) : Promise.resolve({ stdout: log });
                    }
                    return base(args);
                };
                return { exec, calls, logs };
            };
            const waitedForSupervisor = (calls: string[][]) =>
                calls.some((args) => args[0] === 'wait' && args.includes(supervisorName(job)));

            it('is taken over as live: no wait for the supervisor, the live run spared, only the older swept', async () => {
                const { exec, calls, logs } = exitedDaemon();

                const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

                expect(adopted).toMatchObject({
                    live: true,
                    claimSeq: 1,
                    session: SESSION,
                    prior: { id: job.id, leaseToken: job.leaseToken },
                });
                expect(waitedForSupervisor(calls)).toBe(false);
                expect(removals(calls)).toEqual(['a5a5a5a5a5a5', 'older-mailbox']);
            });

            // Characterization: the followed log of an exited container closes at once; the bounded wait says
            // how it exited, and nothing is created, started or ordered.
            it('follows the exited runner of the prior lease to its exit, creating nothing', async () => {
                const { exec, calls, logs } = exitedDaemon();
                const runner = dockerRunner(exec, { spawn: logs });
                expect(await runner.adopt(adopter)).toMatchObject({ live: true });
                calls.length = 0;
                const taken: BoardJob = {
                    ...adopter,
                    groupLease: job.leaseToken,
                    supervisorEnv: { SUPERVISOR_CONTROL_TOKEN: 'tok-new', SUPERVISOR_CONTROL_URL: 'http://driver/' },
                };

                const outcome = await runner.run(taken, { id: SESSION, resume: true });

                expect(outcome).toMatchObject({ exitCode: 0, timedOut: false });
                expect(calls[0]).toEqual(['logs', '-f', containerName(job)]);
                expect(calls.some((args) => args[0] === 'wait')).toBe(true);
                for (const args of calls) expect(args[0]).not.toMatch(/^(create|start|cp)$/);
            });

            // Characterization: the finalize wait stands for everything but a proven, still-serving supervisor.
            it.each([
                ['has logged that it stopped serving', `${RELEASED}\n${SERVED}\n`, undefined],
                ['never logged the release', 'serving\n', undefined],
                ['is stopped', `${RELEASED}\n`, '{"Status":"exited","Running":false}\n'],
                ['cannot be inspected', `${RELEASED}\n`, new Error('docker inspect exited 1')],
                ['answers an inspect that is not JSON', `${RELEASED}\n`, 'not json'],
                ['has a log the daemon refuses', new Error('docker logs exited 1'), undefined],
            ])('waits for the supervisor, taking nothing over, when it %s', async (_label, log, inspect) => {
                const { exec, calls, logs } = exitedDaemon(inspect, log);

                const adopted = await dockerRunner(exec, { spawn: logs })
                    .adopt(adopter)
                    .catch((e: unknown) => e);

                expect((adopted as { live?: boolean } | null)?.live).not.toBe(true);
                expect(waitedForSupervisor(calls)).toBe(true);
            });

            // A daemon silent for the whole read deadline would stall the finalize wait's reads as long again.
            it('blocks the attempt, removing nothing, when the supervisor reads outlast the read deadline', async () => {
                vitest.useFakeTimers();
                try {
                    const { exec: base, calls, logs } = exitedDaemon();
                    const exec = (args: string[], options?: { timeout?: number }) =>
                        args[0] === 'inspect' && args.includes(supervisorName(job))
                            ? hangsUntilTimeout(options)
                            : base(args);
                    const adopting = dockerRunner(exec, { spawn: logs })
                        .adopt(adopter)
                        .catch((e: unknown) => e);

                    await vitest.advanceTimersByTimeAsync(CLOSE_READ_DEADLINE_MS + 1_000);

                    expect(await adopting).toBeInstanceOf(AdoptionBlocked);
                    expect(removals(calls)).toEqual([]);
                } finally {
                    vitest.useRealTimers();
                }
            });
        });
    });
});
