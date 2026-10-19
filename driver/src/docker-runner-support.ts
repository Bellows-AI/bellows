/**
 * The docker runner's daemon plumbing and per-step helpers, beside `createDockerRunner` in
 * docker-runner.ts: the `ExecDocker` seam every daemon call goes through (so a test can stand in
 * for the daemon), error-detail and listing helpers, the worktree-sync argv, the aux-services
 * setup, the runner's create and verdict, and the killed-job guards around the env-file write.
 */

import { JOB_LABEL, LEASE_LABEL, SERVICE_LABEL } from './labels.js';
import { execFile, type spawn } from 'node:child_process';
import type { writeFile, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';
import { containerName, dockerArgs, parseDockerServicePs } from './docker.js';
import { CONTAINER_GONE } from './exec-codes.js';
import { telemetryConfig, telemetryConfigTar, telemetryCopyTarget } from './telemetry-config.js';
import type { RunOutcome, RunSession } from './runner.js';
import {
    declaredServiceSpecs,
    serviceContainerName,
    plannedServices,
    recordDeclaredServices,
    networkName,
    serviceRunArgs,
} from './services.js';
import { awaitServicesRunning, throwIfStoodDown } from './service-restart.js';

export const run = promisify(execFile);

export type Spawn = typeof spawn;

/**
 * One child stream read as text, through a decoder of its own (issue #825): a multibyte character
 * split across two chunks decodes once, whole, never as a U+FFFD per half, and the bytes of a
 * character the stream ended inside are flushed at its end, never dropped.
 */
export function readUtf8(stream: Readable | null | undefined, onText: (text: string) => void): void {
    const decoder = new StringDecoder('utf8');
    stream?.on('data', (chunk: Buffer | string) => onText(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
    stream?.on('end', () => {
        const rest = decoder.end();
        if (rest) onText(rest);
    });
}

/**
 * Everything the runner does through the daemon other than the attached `docker start` itself —
 * the fence, the create, the post-run inspect and the cleanup — goes through this one seam, so a
 * test can stand in for the daemon instead of shelling out to it.
 *
 * One `docker` invocation off the hot paths. `timeout` (ms) bounds the whole exec — the process
 * is killed and the promise rejects — which is what keeps a close-time read from holding a
 * runner's verdict open forever when the daemon stalls. An aborted `signal` kills it the same way.
 * `input` is written to the CLI's stdin — the archive a `docker cp -` reads.
 */
export type ExecDocker = (
    args: string[],
    options?: { timeout?: number; signal?: AbortSignal; input?: Buffer }
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Starts a gate environment container (issue #488). A cancelled start may have created the
 * container before the client died, so it goes by name on the way out.
 */
export async function startEnvContainer(
    execDocker: (args: string[], options?: { signal?: AbortSignal }) => Promise<unknown>,
    name: string,
    args: string[],
    signal: AbortSignal | undefined
): Promise<void> {
    try {
        await execDocker(args, signal ? { signal } : undefined);
    } catch (e) {
        if (signal?.aborted) await execDocker(['rm', '-f', name]).catch(() => undefined);
        throw e;
    }
}

/** How much of a failed aux container's own error detail rides in a sync/reclaim/publish reason. */
export const ERROR_DETAIL_MAX_CHARS = 300;

/**
 * The tool's own output from a failed `execDocker` call, never the echoed command: the execFile
 * message is "Command failed: <the whole docker run argv>", which leaves no room for the one
 * line a human can act on ("remote: Permission to ... denied to bellows-ai[bot]" lives in git's
 * stderr).
 */
export function dockerErrorDetail(e: unknown): string {
    const err = e as { stderr?: string | Buffer; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString('utf8') ?? '');
    return stderr.trim() || (err.message ?? '').split('\n').slice(1).join('\n').trim() || (err.message ?? 'failed');
}

/** One name per non-blank line — the shape `docker ps -q` / `docker network ls` answer in. */
export function linesOf(stdout: string): string[] {
    return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

/**
 * Docker's already-gone answer, in any of its spellings — an untyped `inspect` says `No such
 * object` — on stderr or the execFile message.
 * Read from a REMOVAL's own error only — never from a list, where "not found" could never mean
 * anything.
 */
export function alreadyGone(e: unknown): boolean {
    const err = e as { stderr?: string | Buffer; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString('utf8') ?? '');
    return /no such (container|network|object|volume)|not found/i.test(`${stderr} ${err.message ?? ''}`);
}

/** Lists names by label, or throws `${what}: <the daemon's own message>`. */
export async function listByLabelOrThrow(execDocker: ExecDocker, args: string[], what: string): Promise<string[]> {
    try {
        return linesOf((await execDocker(args)).stdout);
    } catch (e) {
        throw new Error(`${what}: ${(e as Error).message}`);
    }
}

/** A `--format` listing each object with its lease label, tab-separated. */
export const LEASE_FORMAT = (field: 'ID' | 'Name'): string => `{{.${field}}}\t{{.Label "${LEASE_LABEL}"}}`;

/**
 * A `LEASE_FORMAT` listing narrowed to the job's OTHER attempts: this attempt's own — the services
 * and the gate environment the loop started before the runner — are never a leftover, and neither
 * is the earlier run it adopted (`spared`, issue #821), kept until the reaper takes it.
 */
export async function listOtherAttemptsOrThrow(
    execDocker: ExecDocker,
    args: string[],
    what: string,
    kept: { leaseToken: string; spared?: string | undefined }
): Promise<string[]> {
    return (await listByLabelOrThrow(execDocker, args, what)).flatMap((line) => {
        const [name = '', lease = ''] = line.split('\t');
        return name && lease !== kept.leaseToken && lease !== kept.spared ? [name] : [];
    });
}

/** The services network the runner joins: the one the loop's service start created, if it did. */
export const servicesNetworkOf = (job: BoardJob): string | null =>
    declaredServiceSpecs(job).length > 0 ? networkName(job) : null;

/**
 * Removes each name, tolerating one that is already gone — a container or network that exited
 * between the list and its removal is the fence succeeding, not failing.
 */
export async function removeEachTolerantly(
    execDocker: ExecDocker,
    names: string[],
    removeArgsFor: (name: string) => string[],
    whatFailed: (name: string) => string
): Promise<void> {
    for (const name of names) {
        try {
            await execDocker(removeArgsFor(name));
        } catch (e) {
            if (alreadyGone(e)) continue;
            throw new Error(`${whatFailed(name)}: ${(e as Error).message}`);
        }
    }
}

/**
 * Auxiliary services (issue #6) for one attempt: creates the network and starts each service of
 * the claim's plan (`BoardJob.services`, resolved and validated by the board), each step with its
 * own verdict. The driver reads no file — an author's refusal never reaches here, it failed the
 * task at the claim (`BoardJob.planRefusal`).
 *
 * A refused service start is INFRASTRUCTURE — the daemon said no to a container this process
 * spawned, the same class as a refused runner spawn — so it throws, and the caller leaves the job
 * to its lease instead of blaming the command. A partial fleet is torn down on the way out.
 *
 * `assertNotKilled` stops a dying attempt from creating more: a kill that lands mid-setup throws,
 * teardown-free by design — kill() ran the attempt-scoped teardown already, and anything created
 * after it is a leftover for the next attempt's fence (the loop also releases an abandoned start).
 */
export async function setupJobServices(
    job: BoardJob,
    config: DriverConfig,
    deps: {
        execDocker: ExecDocker;
        killed: Set<BoardJob['leaseToken']>;
        serviceTeardown: (job: BoardJob) => Promise<void>;
    }
): Promise<{ servicesNetwork: string | null }> {
    if (!config.servicesEnabled) return { servicesNetwork: null };

    // The fleet starts clean: whatever this attempt's lease already has of a fleet goes first,
    // by the same attempt-scoped code that enforces it at teardown. The sync's fence has swept the
    // job's other attempts by then; their leftovers are never this teardown's business.
    await deps.serviceTeardown(job);
    assertJobNotKilled(deps.killed, job);

    const specs = plannedServices(job);
    if (specs.length === 0) return { servicesNetwork: null };

    const servicesNetwork = networkName(job);
    // The fence already swept the job's stale networks, and this name carries this attempt's
    // own token — a create here cannot collide with anything.
    try {
        // Labeled like everything else the attempt creates: factory.job is what the next
        // attempt's fence sweeps networks by, factory.lease what scopes the teardown's removal
        // to this attempt's own.
        await deps.execDocker([
            'network',
            'create',
            '--label',
            `${JOB_LABEL}=${job.id}`,
            '--label',
            `${LEASE_LABEL}=${job.leaseToken}`,
            servicesNetwork,
        ]);
    } catch (e) {
        throw new Error(`could not create the services network: ${(e as Error).message}`);
    }
    assertJobNotKilled(deps.killed, job);
    for (const spec of specs) {
        try {
            await deps.execDocker(serviceRunArgs(job, spec));
        } catch (e) {
            await deps.serviceTeardown(job);
            throw new Error(`could not start service "${spec.name}": ${(e as Error).message}`);
        }
        assertJobNotKilled(deps.killed, job);
    }
    recordDeclaredServices(job, specs);
    return { servicesNetwork };
}

/**
 * The verdict for a close, decided after the process is gone. An exit CONTAINER_GONE is
 * ambiguous on the shared stderr — the daemon's refusal and a command that genuinely exited that
 * code are printed onto the same stream — so the daemon is asked instead: a container that
 * exists ran, and its State is the truth; "no such container" means the create never made one
 * accepted, and nothing ran. Any other failing code is the container's unless it is still `created`.
 *
 * Cleanup is explicit (`--rm` is not on the spawn argv, precisely so the inspect above can see
 * the container): the fence on the next claim would catch it anyway, but leaving one daemon
 * round-trip of litter behind is not tidiness worth keeping. The services are NOT torn down
 * here: they outlive the runner so the loop's declared gates can test against them, and the
 * loop's releaseServices takes them down after — scoped to this attempt's lease, so a release
 * that lands arbitrarily late can only ever name and remove what THIS attempt created.
 */
export async function dockerRunVerdict(
    code: number | null,
    ctx: {
        execDocker: ExecDocker;
        job: BoardJob;
        output: string;
        timedOut: boolean;
        cacheLost: string | null;
        /** The full-run log the accumulator kept (issue #325); absent when nothing ran. */
        fullLog?: string;
        logTruncated?: boolean;
    }
): Promise<RunOutcome> {
    // 125 is the CLI's own refusal or the command's exit — only the daemon can tell, and a
    // container it cannot answer for never ran. Any other failing code from the attached
    // `docker start` (it exits 1 when the runtime cannot start the process) is a verdict unless
    // the daemon still holds the container as `created`.
    let started = true;
    let infraLoss: string | null = null;
    if (code !== null && code !== 0) {
        try {
            const state = JSON.parse(
                (await ctx.execDocker(['inspect', '--format', '{{json .State}}', containerName(ctx.job)])).stdout
            ) as { Status?: string };
            started = code === CONTAINER_GONE ? state.Status === 'exited' : state.Status !== 'created';
        } catch (e) {
            started = code !== CONTAINER_GONE;
            // A container that ran and is gone before its own close was removed under the run —
            // the driver's kill only kills (issue #560). Its exit is the removal's, not the agent's.
            if (started && !ctx.timedOut && alreadyGone(e)) {
                infraLoss = `the runner container was removed before it exited (exit ${code})`;
            }
        }
    }
    await ctx.execDocker(['rm', '-f', containerName(ctx.job)]).catch(() => undefined);
    return {
        exitCode: code,
        output: ctx.output,
        timedOut: ctx.timedOut,
        started,
        ...(infraLoss ? { infraLoss } : {}),
        cacheLost: ctx.cacheLost,
        // The artifact the loop uploads at close (issue #325); present only when the
        // accumulator actually ran — a refused start has no log and uploads nothing.
        ...(ctx.fullLog !== undefined ? { fullLog: ctx.fullLog, logTruncated: ctx.logTruncated === true } : {}),
    };
}

/**
 * Throws when this attempt's lease has already been killed. Checked after every awaited setup
 * step so a dying attempt stops CREATING resources over a lease it no longer holds — see
 * setupJobServices for why the abort is deliberately teardown-free.
 */
export function assertJobNotKilled(killed: Set<BoardJob['leaseToken']>, job: BoardJob): void {
    if (!killed.has(job.leaseToken)) return;
    throw new Error(`job ${job.id}: killed while setting up services`);
}

/**
 * The last kill-check before the spawn, after the env file write: a lease lost while the write
 * was pending would otherwise reach spawnFn. On this abort the just-written file is removed by
 * hand — the run's own cleanup only wraps a settled outcome, and this throw precedes it.
 */
export async function assertNotKilledAfterEnvWrite(
    ctx: { killed: Set<BoardJob['leaseToken']>; job: BoardJob; files: RunnerFiles },
    file: string | null
): Promise<void> {
    try {
        assertJobNotKilled(ctx.killed, ctx.job);
    } catch (abort) {
        if (file) await ctx.files.rm(file).catch(() => undefined);
        throw abort;
    }
}

/** The fs verbs the runner's env files need — injectable for the same reason spawn is. */
export interface RunnerFiles {
    writeFile: typeof writeFile;
    rm: typeof rm;
}

/**
 * Creates the runner container and copies its telemetry config in before anything starts
 * (issue #452): the file decides where telemetry goes and what it carries, and the container runs
 * as the agent's uid, so it arrives from outside, as a root-owned 0444 archive (telemetryConfigTar).
 * A refusal of either step is the daemon's and reads the way a refused `docker run` did — a
 * container that never started, its leftover removed — so it comes back as an outcome; null means
 * the container is ready to start.
 */
export async function createRunnerContainer(
    deps: { config: DriverConfig; execDocker: ExecDocker },
    job: BoardJob,
    session: RunSession | null,
    options: { servicesNetwork: string | null; envFile?: string }
): Promise<RunOutcome | null> {
    const { config, execDocker } = deps;
    try {
        await execDocker(dockerArgs(config, job, session, options));
        const telemetry = telemetryConfig(job.executorType, config.otelEndpoint);
        await execDocker(['cp', '-', `${containerName(job)}:${telemetryCopyTarget(telemetry)}`], {
            input: telemetryConfigTar(telemetry),
        });
        return null;
    } catch (error) {
        return dockerRunVerdict(CONTAINER_GONE, {
            execDocker,
            job,
            output: dockerErrorDetail(error),
            timedOut: false,
            cacheLost: null,
        });
    }
}

/**
 * The declared services, started by the loop's setup phase before the gate environment and run()
 * (`Runner.startServices`), answering only once every one runs — the pre-gate restart's bar — so
 * `environment.setup` never races a container still starting. A service that never runs throws
 * `ServicesNotRunning`; null otherwise (an author's refusal never gets this far: the claim carried it).
 */
export async function startJobServices(
    job: BoardJob,
    config: DriverConfig,
    deps: {
        execDocker: ExecDocker;
        killed: Set<BoardJob['leaseToken']>;
        serviceTeardown: (job: BoardJob) => Promise<void>;
        sleep?: (ms: number) => Promise<void>;
    },
    signal?: AbortSignal
): Promise<RunOutcome | null> {
    const { servicesNetwork } = await setupJobServices(job, config, deps);
    if (servicesNetwork === null) return null;
    await awaitServicesRunning(
        declaredServiceSpecs(job),
        listJobServices(job, deps.execDocker),
        deps.sleep ?? serviceWait,
        {
            signal,
            after: 'the start',
        }
    );
    return null;
}

/** The attempt's service fleet as the readiness wait reads it. */
const listJobServices = (job: BoardJob, execDocker: ExecDocker) => async () =>
    parseDockerServicePs((await execDocker(servicePsArgs(job))).stdout);

/** The attempt's service fleet, exited ones included: the job and lease label pair, service key required. */
export const servicePsArgs = (job: BoardJob): string[] => [
    'ps',
    '-a',
    '--filter',
    `label=${JOB_LABEL}=${job.id}`,
    '--filter',
    `label=${LEASE_LABEL}=${job.leaseToken}`,
    '--filter',
    `label=${SERVICE_LABEL}`,
    '--format',
    '{{json .}}',
];

/** The wait between re-listings of a restarting fleet. */
const serviceWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The pre-gate restart (issue #560): each recorded service's container removed and run again on
 * the attempt's EXISTING network — never the whole teardown, which removes the network the gate
 * containers join by name — then waited until every one runs. Every failure throws; a stand-down
 * ends it and removes whatever it had started again.
 */
export async function restartJobServices(
    job: BoardJob,
    execDocker: ExecDocker,
    signal: AbortSignal,
    sleep: (ms: number) => Promise<void> = serviceWait
): Promise<void> {
    const specs = declaredServiceSpecs(job);
    const remove = (name: string) => execDocker(['rm', '-f', serviceContainerName(job, name)]).catch(() => undefined);
    try {
        for (const spec of specs) {
            throwIfStoodDown(signal);
            await remove(spec.name);
            try {
                await execDocker(serviceRunArgs(job, spec));
            } catch (e) {
                throw new Error(`could not start service "${spec.name}": ${(e as Error).message}`);
            }
        }
        await awaitServicesRunning(specs, listJobServices(job, execDocker), sleep, { signal });
    } catch (e) {
        if (signal.aborted) for (const spec of specs) await remove(spec.name);
        throw e;
    }
}
