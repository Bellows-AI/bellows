import { describe, expect, it, vitest } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BoardJob } from '../../src/board/board.js';
import {
    carriedPastLoss,
    decisionOf,
    LOSS_ROWS,
    TERMINATION_ROWS,
    type TerminationRow,
} from '../fixtures/termination-table.js';
import { RETENTION_ROWS } from '../fixtures/retention-table.js';
import { STARTUP_ROWS, type StartupRow, startupDecisionOf } from '../fixtures/startup-table.js';
import { containerName } from '../../src/docker/docker.js';
import { StartupRefused } from '../../src/startup-cause.js';
import type { RunOutcome } from '../../src/runner.js';
import { commandMark } from '../../src/runner.js';
import { supervisorName } from '../../src/docker/docker-mailbox.js';
import type { RunnerFiles } from '../../src/docker/docker-runner-support.js';
import type { SupervisorReport } from '../../src/supervisor-contract.js';
import {
    job,
    FINALIZED,
    fakeSteps,
    syncSteps,
    SESSION,
    fakeChild,
    isAdoptListing,
    withState,
    labelDaemon,
    dockerRunner,
} from '../fixtures/docker-suite.js';

const MISMATCH_ROW = 'a run specced for another session than its group' as const;

const SILENT_ROW = 'a supervisor that started and never answered' as const;

const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';

describe('how a started run ends, on docker (the conformance table)', () => {
    interface End {
        code: number;
        supervisorExit: string;
        report?: SupervisorReport;
        removed?: boolean;
        kill?: boolean;
    }
    /** One attached run ended as `end` says: the agent's close, the supervisor's exit, its report. */
    const endOnDocker = async (end: End): Promise<RunOutcome> => {
        const child = new EventEmitter() as ChildProcess;
        child.stdout = new EventEmitter() as Readable;
        child.stderr = new EventEmitter() as Readable;
        let spawned!: () => void;
        const started = new Promise<void>((resolve) => {
            spawned = resolve;
        });
        const exec = (async (args: string[]) => {
            // The supervisor's exit lands after its report, as it does for a supervisor that reports.
            if (args[0] === 'wait') {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return { stdout: `${end.supervisorExit}\n` };
            }
            if (args[0] === 'inspect' && end.removed) {
                throw Object.assign(new Error('docker inspect exited 1'), { stderr: 'Error: No such container: x' });
            }
            if (args[0] === 'inspect') return { stdout: '{"Status":"exited"}' };
            if (args[0] === 'ps' && args.some((a) => a.startsWith('label=factory.lease')))
                return { stdout: 'a0a0a0a0a001\n' };
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, {
            spawn: (() => {
                spawned();
                return child;
            }) as unknown as typeof spawn,
            steps: fakeSteps(undefined, end.report ?? new Promise<never>(() => undefined)).sink,
        });
        const pending = runner.run(job, { id: SESSION, resume: false });
        await started;
        if (end.kill) await runner.kill(job);
        process.nextTick(() => child.emit('close', end.code));
        return pending;
    };

    const LOST_AGENT = { ...FINALIZED, outcome: 'lost', cause: 'lost', agentExit: null, agentEnd: 'lost' };
    const ends: Record<TerminationRow, End> = {
        'an agent that exits 0 under a finalizing supervisor': { code: 0, supervisorExit: '0', report: FINALIZED },
        'an agent its run budget ended': {
            code: 137,
            supervisorExit: '124',
            report: { ...FINALIZED, outcome: 'timed_out', cause: 'timeout', agentExit: 137, agentEnd: 'killed' },
        },
        'a group the driver hard-killed mid-run': { code: 137, supervisorExit: '137', kill: true },
        'a runner the platform took away mid-run': { code: 137, supervisorExit: '137', removed: true },
        'a runner the platform took away after the budget ended its agent': {
            code: 137,
            supervisorExit: '137',
            removed: true,
            report: { ...FINALIZED, outcome: 'timed_out', cause: 'timeout', agentExit: 137, agentEnd: 'killed' },
        },
        'a supervisor that ended without finalizing, nothing initiating it': { code: 0, supervisorExit: '70' },
        'a supervisor that reported, then crashed before the verdict read': {
            code: 0,
            supervisorExit: '70',
            report: FINALIZED,
        },
        // A report that finalized nothing (the driver was lost before the agent was released) is no
        // finalization: the attached run takes it as `reportFinalized` does, an interruption.
        'a supervisor that reported an unlaunched group, then crashed': {
            code: 0,
            supervisorExit: '70',
            report: { ...FINALIZED, agentEnd: 'unlaunched' },
        },
        // A lost agent is no finalized run either: the runner went, the work did not end.
        'a supervisor that reported its agent lost, then crashed': {
            code: 0,
            supervisorExit: '70',
            report: LOST_AGENT,
        },
        'a runner the platform took away after the supervisor reported its agent lost': {
            code: 137,
            supervisorExit: '137',
            removed: true,
            report: LOST_AGENT,
        },
    };

    it.each(TERMINATION_ROWS)('%s: %s', async (row, expected) => {
        expect(decisionOf(await endOnDocker(ends[row]))).toBe(expected);
    });

    it.each(LOSS_ROWS)('%s: carries nothing past the loss', async (row) => {
        const outcome = await endOnDocker(ends[row]);
        expect(outcome.infraLoss).toBeDefined();
        expect(carriedPastLoss(outcome)).toEqual([]);
    });
});

describe('what a closed run leaves for the next claim, on docker (the retention conformance table, #828)', () => {
    const adopter: BoardJob = { ...job, leaseToken: '99999999-9999-4999-8999-999999999999', claimSeq: 2 };
    const listed = `${containerName(job)}\t${job.leaseToken}\t1\t${SESSION}\t${commandMark(job.command)}\n`;

    it.each(RETENTION_ROWS)('%s: %s', async (_row, expected) => {
        // One daemon for both claims: the runner container is listed as exited until something removes it.
        let removed = false;
        const exec = (async (args: string[]) => {
            if (args[0] === 'rm') removed = true;
            if (args[0] === 'wait') return { stdout: '0\n' };
            if (isAdoptListing(args)) return { stdout: removed ? '' : withState(listed, 'exited') };
            if (args[0] === 'ps' && args.some((a) => a.startsWith('label=factory.lease')))
                return { stdout: 'a0a0a0a0a001\n' };
            if (args[0] === 'volume' && args[1] === 'inspect') {
                throw Object.assign(new Error('docker volume inspect exited 1'), {
                    stderr: 'Error response from daemon: get factory-kill: no such volume',
                });
            }
            if (args[0] === 'inspect') {
                return { stdout: '{"Status":"exited","ExitCode":0,"StartedAt":"2026-10-01T00:00:00Z"}\n' };
            }
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const attached = new EventEmitter() as ChildProcess;
        attached.stdout = new EventEmitter() as Readable;
        attached.stderr = new EventEmitter() as Readable;
        let spawned!: () => void;
        const started = new Promise<void>((resolve) => {
            spawned = resolve;
        });
        const spawnFor = ((_command: string, args: string[]) => {
            if (args[0] === 'logs') return fakeChild('did the work\n', '', 0);
            spawned();
            return attached;
        }) as unknown as typeof spawn;

        const first = dockerRunner(exec, { spawn: spawnFor, steps: fakeSteps(undefined, FINALIZED).sink });
        const pending = first.run(job, { id: SESSION, resume: false });
        await started;
        process.nextTick(() => attached.emit('close', 0));
        await pending;

        const adopted = await dockerRunner(exec, { spawn: spawnFor }).adopt(adopter);
        const found = adopted ? 'adoptable' : 'gone';
        expect(found).toBe(expected);
        if (adopted) expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true } });
    });
});

describe('how a refused group start ends, on docker (the startup conformance table, #824 D11)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };
    /** The daemon's own words for each refusal, as the CLI prints them on its stderr. */
    const refusals: Record<Exclude<StartupRow, typeof MISMATCH_ROW | typeof SILENT_ROW>, string> = {
        'the platform never brought the group up':
            'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        'a registry that timed out':
            'Error response from daemon: Get "https://registry.example/v2/": dial tcp 10.0.0.1:443: i/o timeout',
        'a registry rate limit': 'Error response from daemon: toomanyrequests: You have reached your pull rate limit.',
        'a TLS handshake that timed out':
            'Error response from daemon: Get "https://registry.example/v2/": net/http: TLS handshake timeout',
        'a missing image':
            'Error response from daemon: manifest for registry.example/claude-executor:latest not found: manifest unknown',
        'an invalid image reference': 'docker: invalid reference format.',
        'an unauthorized pull':
            'Error response from daemon: Head "https://registry.example/v2/claude-executor/manifests/latest": unauthorized: authentication required',
        'an untrusted registry certificate':
            'Error response from daemon: Get "https://registry.example/v2/": tls: failed to verify certificate: x509: certificate signed by unknown authority',
        'a container configuration the platform refuses':
            'Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /srv/missing',
        'a refusal whose words prove no cause':
            'Error response from daemon: Conflict. The container name "/x" is already in use by container "y"',
    };
    /** The sync, its group's supervisor create refused with `stderr`: what it threw, or null. */
    const refusedSync = async (stderr: string): Promise<unknown> => {
        const d = labelDaemon({
            fail: (args) => (args[0] === 'create' && args.includes(supervisorName(repoJob)) ? stderr : null),
        });
        return dockerRunner(d.exec, { steps: syncSteps().sink })
            .syncCheckout(repoJob)
            .then(
                () => null,
                (e: unknown) => e
            );
    };

    /** The sync under session `SESSION`, then a run specced as `run` says: what the run threw, and the daemon. */
    const mismatchedRun = async (run: { id: string; resume: boolean }) => {
        const d = labelDaemon();
        const runner = dockerRunner(d.exec, { steps: syncSteps().sink });
        await runner.syncCheckout(repoJob, undefined, { id: SESSION, resume: false });
        const thrown = await runner.run(repoJob, run).then(
            () => null,
            (e: unknown) => e
        );
        return { thrown, d };
    };
    const startups: Record<StartupRow, () => Promise<unknown>> = {
        ...(Object.fromEntries(
            Object.entries(refusals).map(([row, stderr]) => [row, () => refusedSync(stderr)])
        ) as Record<Exclude<StartupRow, typeof MISMATCH_ROW | typeof SILENT_ROW>, () => Promise<unknown>>),
        [MISMATCH_ROW]: async () => (await mismatchedRun({ id: OTHER_SESSION, resume: false })).thrown,
        // The supervisor started and never pulled: the bound is reached on elapsed time, and nothing proves why.
        [SILENT_ROW]: async () =>
            dockerRunner(labelDaemon().exec, { steps: { ...syncSteps().sink, contacted: () => false } })
                .syncCheckout(repoJob)
                .then(
                    () => null,
                    (e: unknown) => e
                ),
    };

    it.each(STARTUP_ROWS)('%s: %s', async (row, expected) => {
        const thrown = await startups[row]();
        expect(thrown).not.toBeNull();
        expect(startupDecisionOf(thrown)).toBe(expected);
    });

    it('refuses a run specced for another session than its group', async () => {
        const message = `the task group of job ${repoJob.id} was specced for another session than the run's`;
        for (const run of [
            { id: OTHER_SESSION, resume: false },
            { id: SESSION, resume: true },
        ]) {
            const { thrown, d } = await mismatchedRun(run);
            expect((thrown as Error).message).toBe(message);
            expect(d.calls.some((a) => a[0] === 'create' && a.includes(containerName(repoJob)))).toBe(false);
        }
    });

    // A local failure — the env file the create reads, refused by the host — is no platform refusal,
    // whatever its words: it carries no stderr, so no cause is read from it.
    it('reads no startup cause from a local file the host refused', async () => {
        const d = labelDaemon();
        const files: RunnerFiles = {
            writeFile: (async () => {
                throw Object.assign(new Error("EACCES: permission denied, open '/tmp/env'"), { code: 'EACCES' });
            }) as unknown as RunnerFiles['writeFile'],
            rm: (async () => undefined) as unknown as RunnerFiles['rm'],
        };
        const thrown = await dockerRunner(d.exec, { steps: syncSteps().sink, files })
            .syncCheckout(repoJob)
            .then(
                () => null,
                (e: unknown) => e
            );
        expect((thrown as Error).message).toContain('EACCES');
        expect(startupDecisionOf(thrown)).toBe('unclassified');
    });
});

describe('docker waits for the supervisor of a started group to make contact (#828)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/bellows' };
    /** A sink whose `contacted` answers `answers` in turn, then the last one for ever. */
    const contactAfter = (supervised: ReturnType<typeof fakeSteps>, answers: boolean[]) => {
        let reads = 0;
        return { ...supervised.sink, contacted: () => answers[Math.min(reads++, answers.length - 1)]! };
    };
    const settled = (p: Promise<unknown>) =>
        p.then(
            () => null,
            (e: unknown) => e as Error
        );

    it('submits nothing to a group before its supervisor has pulled', async () => {
        const supervised = syncSteps();
        const submittedAtSleep: number[] = [];
        const runner = dockerRunner(labelDaemon().exec, {
            steps: contactAfter(supervised, [false, false, false, false, true]), // read before and after each probe
            sleep: async () => void submittedAtSleep.push(supervised.submitted.length),
        });
        await runner.syncCheckout(repoJob);
        expect(submittedAtSleep).toEqual([0, 0]);
        expect(supervised.ofKind('sync')).toHaveLength(1);
    });

    it('ends the wait on elapsed time with a plain error naming the supervisor, then removes the group', async () => {
        let now = 0;
        const spy = vitest.spyOn(Date, 'now').mockImplementation(() => (now += 120_000));
        const slept: number[] = [];
        const d = labelDaemon();
        const supervised = syncSteps();
        try {
            const thrown = await settled(
                dockerRunner(d.exec, {
                    steps: contactAfter(supervised, [false]),
                    sleep: async (ms) => void slept.push(ms),
                }).syncCheckout(repoJob)
            );
            expect(thrown).toBeInstanceOf(Error);
            expect(startupDecisionOf(thrown)).toBe('unclassified');
            expect(thrown!.message).toContain(supervisorName(repoJob));
            expect(thrown!.message).toContain('600000');
        } finally {
            spy.mockRestore();
        }
        expect(slept.length).toBeLessThan(20);
        expect(supervised.submitted).toEqual([]);
        expect(d.calls.some((a) => a[0] === 'rm' && a.includes(supervisorName(repoJob)))).toBe(true);
    });

    // #924, the docker counterpart of the kubernetes pod lost before first contact.
    describe('a supervisor container lost before it made contact', () => {
        const GONE = Object.assign(new Error('Command failed'), { stderr: 'Error: No such object: supervisor' });
        async function lostSync(inspected: (read: number) => string | Error) {
            const d = labelDaemon();
            const supervised = syncSteps();
            let reads = 0;
            const exec = async (args: string[]) => {
                if (args[0] === 'inspect' && args.includes(supervisorName(repoJob))) {
                    reads += 1;
                    const answer = inspected(reads);
                    if (answer instanceof Error) throw answer;
                    return { stdout: answer };
                }
                return d.exec(args);
            };
            const thrown = await settled(
                dockerRunner(exec, { steps: contactAfter(supervised, [false]) }).syncCheckout(repoJob)
            );
            return { thrown, reads, supervised, d };
        }

        it.each([
            ['removed', () => GONE],
            ['exited', () => '{"Running":false,"Status":"exited"}'],
        ])('is a transient refusal as soon as a supervisor seen running is %s', async (_how, after) => {
            const { thrown, reads, supervised, d } = await lostSync((read) =>
                read < 3 ? '{"Running":true}' : after()
            );

            expect(thrown).toBeInstanceOf(StartupRefused);
            expect(thrown).toMatchObject({ startupCause: 'transient', message: expect.stringContaining('was lost') });
            expect(reads).toBeLessThanOrEqual(4);
            expect(supervised.submitted).toEqual([]);
            expect(d.calls.some((a) => a[0] === 'rm' && a.includes(supervisorName(repoJob)))).toBe(true);
        });

        it('counts no supervisor that was never seen running, and no read that did not answer', async () => {
            for (const answer of [GONE, new Error('Cannot connect to the Docker daemon')]) {
                const { thrown, reads } = await lostSync(() => answer);
                expect(thrown).not.toBeInstanceOf(StartupRefused);
                expect(thrown).toBeInstanceOf(Error);
                expect(reads).toBeGreaterThan(100);
            }
            const { thrown, reads } = await lostSync((read) => (read < 3 ? '{"Running":true}' : new Error('timeout')));
            expect(thrown).not.toBeInstanceOf(StartupRefused);
            expect(reads).toBeGreaterThan(100);
        });
    });

    it('stops waiting for a group whose job was killed while it came up', async () => {
        const slept: number[] = [];
        const d = labelDaemon();
        let runner: ReturnType<typeof dockerRunner> | undefined;
        runner = dockerRunner(d.exec, {
            steps: contactAfter(syncSteps(), [false]),
            sleep: async (ms) => {
                slept.push(ms);
                await runner!.kill(repoJob);
            },
        });
        const thrown = await settled(runner.syncCheckout(repoJob));
        expect(thrown?.message).toMatch(/killed while its task group came up/);
        expect(slept.length).toBeLessThanOrEqual(2);
        expect(d.calls.some((a) => a[0] === 'rm' && a.includes(supervisorName(repoJob)))).toBe(true);
    });
});
