/**
 * The docker runner's daemon plumbing and per-step helpers, beside `createDockerRunner` in
 * docker-runner.ts: the `ExecDocker` seam every daemon call goes through (so a test can stand in
 * for the daemon), error-detail and listing helpers, the worktree-sync argv, the aux-services
 * setup, the runner's create and verdict, and the killed-job guards around the env-file write.
 */

import { JOB_LABEL, LEASE_LABEL, SERVICE_LABEL } from '../labels.js';
import type { KillLedger } from '../kill-ledger.js';
import { execFile, type spawn } from 'node:child_process';
import type { writeFile, rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { type BoardJob, UUID_SHAPE } from '../board/board.js';
import type { DriverConfig } from '../config.js';
import { containerName, dockerArgs, parseDockerServicePs, parseDockerStats } from './docker.js';
import { CONTAINER_GONE } from '../exec-codes.js';
import { telemetryConfig, telemetryConfigTar, telemetryCopyTarget } from '../telemetry-config.js';
import {
    composeRuntimeSample,
    type Read,
    type RunOutcome,
    type RunSession,
    type RuntimeSample,
    SERVICE_RESTART_TIMEOUT_MS,
} from '../runner.js';
import {
    declaredServiceSpecs,
    groupServices,
    recordDeclaredServices,
    serviceContainerName,
    serviceRunArgs,
} from '../services.js';
import { supervisorName } from './docker-mailbox.js';
import { boardIdentity } from '../task-volume.js';
import type { StepSink } from '../step-control.js';
import { controlTokenOf } from '../supervised-steps.js';
import { abortableSleep, anyOf, type Bound, type Sleep, timeLeft } from '../poll.js';
import { awaitServicesRunning, throwIfStoodDown } from '../service-restart.js';
import { type HeldContainer, heldWords, type StartupCause, startupCauseOf, StartupRefused } from '../startup-cause.js';

export const run = promisify(execFile);

/**
 * A group start the daemon refused, typed by the cause its own stderr proves (#824 D11); anything
 * else — a local file the host refused, words that prove no cause — is rethrown as it came. A
 * sidecar's refusal (`held`, #773 D10) names its role and image; the executor's keeps the daemon's words.
 */
export function startupRefusalOf(e: unknown, held?: HeldContainer & { image: string }): unknown {
    const stderr = (e as { stderr?: unknown }).stderr;
    if (typeof stderr !== 'string') return e;
    const cause = startupCauseOf({ message: stderr });
    if (!cause) return e;
    if (!held) return new StartupRefused(stderr.trim(), cause);
    return new StartupRefused(
        `the ${heldWords(held)} image "${held.image}" was refused: ${stderr.trim()}`,
        cause,
        held
    );
}

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
/**
 * `execDocker` refusing every call once `signal` aborts and killing the one in flight when it does;
 * `execDocker` itself without one.
 */
export function untilStandDown(execDocker: ExecDocker, signal?: AbortSignal): ExecDocker {
    if (!signal) return execDocker;
    return async (args, options) => {
        if (signal.aborted) throw new Error('the call was abandoned: the attempt stood down');
        return execDocker(args, {
            ...options,
            signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
        });
    };
}

/**
 * How long one command of an attempt may run before its process is killed: the ceiling of a stalled
 * daemon, not a tuned budget — a service creation may pull its image. Long-running children (the
 * attached run, a log stream) end on the kill signal and their own deadline instead.
 */
export const ATTEMPT_COMMAND_TIMEOUT_MS = 600_000;

/**
 * `execDocker` for an attempt's own commands (#869): each ends by `ATTEMPT_COMMAND_TIMEOUT_MS`
 * unless it names its own bound, and by `signal`, the attempt's kill. Teardown is not made with it.
 */
export function attemptExec(execDocker: ExecDocker, signal: AbortSignal): ExecDocker {
    const standing = untilStandDown(execDocker, signal);
    return (args, options) => standing(args, { ...options, timeout: options?.timeout ?? ATTEMPT_COMMAND_TIMEOUT_MS });
}

/**
 * `execDocker` held to a wait (#869): refusing every call once the absolute `bound.deadline` has
 * passed, ending each by it, and killing the one in flight when `bound.signal` aborts. The docker
 * twin of `withSignal(boundedBy(deps, deadline), signal)`.
 */
export function boundedExec(execDocker: ExecDocker, { deadline, signal }: Bound): ExecDocker {
    const standing = untilStandDown(execDocker, signal);
    return async (args, options) => {
        const left = Math.min(timeLeft(deadline), options?.timeout ?? Infinity);
        if (left === 0) throw new Error('the call was refused: its wait is out of time');
        return standing(args, { ...options, ...(Number.isFinite(left) ? { timeout: left } : {}) });
    };
}

export type ExecDocker = (
    args: string[],
    options?: { timeout?: number; signal?: AbortSignal; input?: Buffer }
) => Promise<{ stdout: string; stderr?: string }>;

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
    return /no such (container|network|object|volume)|not found/i.test(refusalText(e));
}

/**
 * Whether a docker read was refused because the named object does not exist, in docker's own words
 * for `kinds` (`no such container`, `no such volume`) — never a generic "not found", which a
 * daemon, a proxy or a registry can say of anything (#824).
 */
export function noSuchObject(e: unknown, kinds: readonly string[]): boolean {
    return new RegExp(`no such (${kinds.join('|')})`, 'i').test(refusalText(e));
}

/** A failed docker call's stderr and message, as one string. */
function refusalText(e: unknown): string {
    const err = e as { stderr?: string | Buffer; message?: string };
    const stderr = typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString('utf8') ?? '');
    return `${stderr} ${err.message ?? ''}`;
}

/** A container's id as `docker ps -q` and `{{.ID}}` answer it: lowercase hex, 12 characters short or 64 long. */
export const CONTAINER_ID = /^[0-9a-f]{12,64}$/;

/** A docker object's name (`{{.Names}}`, a network or volume name): never prose, HTML or JSON. */
export const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * A docker read's answer (#869): what the daemon said, parsed by the listing's own parser. A
 * refusal, and an answer the parser cannot read, are `inconclusive` — never an empty list; only
 * the daemon's own `no such <kind>` for a kind in `absentOn` is `absent`.
 */
export async function readDocker<T>(
    execDocker: ExecDocker,
    args: string[],
    what: string,
    { parse, absentOn }: { parse: (stdout: string) => T | null; absentOn?: readonly string[] }
): Promise<Read<T>> {
    let stdout: string;
    try {
        ({ stdout } = await execDocker(args));
    } catch (e) {
        if (absentOn && noSuchObject(e, absentOn)) return { kind: 'absent' };
        return { kind: 'inconclusive', reason: `${what}: ${(e as Error).message}` };
    }
    const value = typeof stdout === 'string' ? parse(stdout) : null;
    return value === null
        ? { kind: 'inconclusive', reason: `${what}: the daemon answered what is not the listing` }
        : { kind: 'value', value };
}

/** A listing's non-blank lines, whole (a tab-separated row may end in an empty field). */
const rowsOf = (stdout: string): string[] =>
    stdout
        .split('\n')
        .map((line) => line.replace(/\r$/, ''))
        .filter((line) => line.trim() !== '');

/** The ids one per line, `[]` for an empty answer; null when any line is not an id. */
export const idLines = (stdout: string): string[] | null => {
    const ids = rowsOf(stdout).map((line) => line.trim());
    return ids.every((id) => CONTAINER_ID.test(id)) ? ids : null;
};

/** The names one per line, `[]` for an empty answer; null when any line is not a name. */
export const nameLines = (stdout: string): string[] | null => {
    const names = rowsOf(stdout).map((line) => line.trim());
    return names.every((name) => DOCKER_NAME.test(name)) ? names : null;
};

/**
 * Tab-separated rows of exactly `fields` fields whose first is an id of `grammar`; the rest may be
 * empty (a label the object lacks). Null when any row has another shape.
 */
export const tabRows =
    (fields: number, grammar: RegExp = DOCKER_NAME) =>
    (stdout: string): string[][] | null => {
        const rows = rowsOf(stdout).map((line) => line.split('\t'));
        return rows.every((row) => row.length === fields && grammar.test(row[0] ?? '')) ? rows : null;
    };

/** A `--format` listing each object with its lease label, tab-separated. */
export const LEASE_FORMAT = (field: 'ID' | 'Name'): string => `{{.${field}}}\t{{.Label "${LEASE_LABEL}"}}`;

/**
 * A `LEASE_FORMAT` listing narrowed to the job's OTHER attempts: this attempt's own — the services
 * and the gate environment the loop started before the runner — are never a leftover, and neither
 * is the earlier run it adopted (`spared`, issue #821), kept until the reaper takes it. `kept.grammar` is
 * the first field's: container ids for `ps`, names for networks and volumes. Throws
 * `${what}: <reason>` when the listing cannot be read, so the fence removes nothing on it.
 */
export async function listOtherAttemptsOrThrow(
    execDocker: ExecDocker,
    args: string[],
    what: string,
    kept: { leaseToken: string; spared?: string | undefined; grammar: RegExp }
): Promise<string[]> {
    // Every row names the attempt it belongs to: a lease that is no lease would make the row an
    // "other attempt" and so a delete target (#869).
    const parse = (stdout: string): string[][] | null => {
        const rows = tabRows(2, kept.grammar)(stdout);
        return rows?.every(([, lease = '']) => UUID_SHAPE.test(lease)) ? rows : null;
    };
    const read = await readDocker(execDocker, args, what, { parse });
    if (read.kind !== 'value') throw new Error(read.kind === 'inconclusive' ? read.reason : `${what}: absent`);
    return read.value.flatMap(([name = '', lease = '']) =>
        lease !== kept.leaseToken && lease !== kept.spared ? [name] : []
    );
}

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
 * Auxiliary services (issue #6) for one attempt: starts each service of the claim's plan
 * (`BoardJob.services`, resolved and validated by the board) in the network namespace of the
 * attempt's group supervisor (issue #773), whose hosts file already names every one on loopback,
 * each step with its own verdict. The driver reads no file — an author's refusal never reaches
 * here, it failed the task at the claim (`BoardJob.planRefusal`). Answers whether any started.
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
        ledger: Pick<KillLedger, 'was'>;
        serviceTeardown: (job: BoardJob) => Promise<void>;
    }
): Promise<boolean> {
    const specs = groupServices(config, job);
    if (specs.length === 0) return false;
    // The fleet starts clean: whatever this attempt's lease already has of a fleet goes first,
    // by the same attempt-scoped code that enforces it at teardown. The sync's fence has swept the
    // job's other attempts by then; their leftovers are never this teardown's business.
    await deps.serviceTeardown(job);
    assertJobNotKilled(deps.ledger, job);
    for (const spec of specs) {
        try {
            await deps.execDocker(serviceRunArgs(job, spec, supervisorName(job), boardIdentity(config)));
        } catch (e) {
            await deps.serviceTeardown(job);
            throw new Error(`could not start service "${spec.name}": ${(e as Error).message}`);
        }
        assertJobNotKilled(deps.ledger, job);
    }
    recordDeclaredServices(job, specs);
    return true;
}

/** Docker's start time for a container it never started. */
const NEVER_STARTED_AT = '0001-01-01T00:00:00Z';

/** A failing close as the daemon answered it: `neverRan` is the daemon's proof, never a guess (#824 D11). */
export interface ClosedState {
    started: boolean;
    neverRan: boolean;
    infraLoss: string | null;
}

/**
 * Whether a container that closed failing ever ran, as the daemon answers it: one that never ran is
 * still `created`, or carries no start time — a status alone (`dead`, `exited`) is no such proof. The
 * fallback when the daemon cannot answer is a guess, never that proof.
 */
export async function closedStateOf(
    code: number,
    ctx: { execDocker: ExecDocker; job: BoardJob; timedOut: boolean }
): Promise<ClosedState> {
    try {
        const state = JSON.parse(
            (await ctx.execDocker(['inspect', '--format', '{{json .State}}', containerName(ctx.job)])).stdout
        ) as { Status?: string; StartedAt?: string };
        const neverRan = state.Status === 'created' || state.StartedAt === NEVER_STARTED_AT;
        return { started: !neverRan, neverRan, infraLoss: null };
    } catch (e) {
        const started = code !== CONTAINER_GONE;
        // A container that ran and is gone before its own close was removed under the run —
        // the driver's kill only kills (issue #560). Its exit is the removal's, not the agent's.
        const removed = started && !ctx.timedOut && alreadyGone(e);
        return {
            started,
            neverRan: false,
            infraLoss: removed ? `the runner container was removed before it exited (exit ${code})` : null,
        };
    }
}

/**
 * The verdict for a close, decided after the process is gone. An exit CONTAINER_GONE is
 * ambiguous on the shared stderr — the daemon's refusal and a command that genuinely exited that
 * code are printed onto the same stream — so the daemon is asked instead: a container that
 * exists ran, and its State is the truth; "no such container" means the create never made one
 * accepted, and nothing ran. Any other failing code is the container's unless it is still `created`.
 *
 * Cleanup is explicit (`--rm` is not on the spawn argv, precisely so the inspect above can see
 * the container): a container that never ran is removed here; one that ran stays for the attempt's
 * end to remove, so a driver lost before the verdict is staged leaves it for adoption. The services are NOT torn down
 * here: they outlive the runner so the loop's declared gates can test against them, and the
 * loop's releaseServices takes them down after — scoped to this attempt's lease, so a release
 * that lands arbitrarily late can only ever name and remove what THIS attempt created.
 */
export async function dockerRunVerdict(
    code: number | null,
    ctx: {
        execDocker: ExecDocker;
        /** Removes the container of a start that never ran; uncancelled, where `execDocker` ends with the attempt. */
        teardown?: ExecDocker;
        job: BoardJob;
        output: string;
        timedOut: boolean;
        cacheLost: string | null;
        /** The full-run log the accumulator kept (issue #325); absent when nothing ran. */
        fullLog?: string;
        logTruncated?: boolean;
        /** The cause a refused create's own stderr proves (#824 D11): the refusal is the evidence. */
        refusalCause?: StartupCause | null;
        /** The daemon's answer already read for this close (`provenStartRefusal`): never asked twice. */
        closed?: ClosedState | null;
    }
): Promise<RunOutcome> {
    // 125 is the CLI's own refusal or the command's exit — only the daemon can tell, and a
    // container it cannot answer for never ran. Any other failing code from the attached
    // `docker start` (it exits 1 when the runtime cannot start the process) is a verdict unless
    // the daemon still holds the container as `created`.
    const { started, neverRan, infraLoss } =
        code !== null && code !== 0
            ? (ctx.closed ?? (await closedStateOf(code, ctx)))
            : { started: true, neverRan: false, infraLoss: null };
    // A container that never ran is litter to remove now; one that ran is the evidence a replacement
    // claim adopts the run from, so it stays until the attempt's end (`finishGroup`).
    if (!started) await (ctx.teardown ?? ctx.execDocker)(['rm', '-f', containerName(ctx.job)]).catch(() => undefined);
    // A startup cause only on proof the container never ran — the refused create's own stderr, or the
    // daemon's answer — when what printed is the daemon's, never the agent's own words (#824 D11).
    const startupCause = started
        ? null
        : (ctx.refusalCause ?? (neverRan ? startupCauseOf({ message: ctx.output }) : null));
    return {
        exitCode: code,
        output: ctx.output,
        timedOut: ctx.timedOut,
        started,
        ...(infraLoss ? { infraLoss } : {}),
        ...(startupCause ? { startupCause } : {}),
        cacheLost: ctx.cacheLost,
        // The artifact the loop uploads at close (issue #325); present only when the
        // accumulator actually ran — a refused start has no log and uploads nothing.
        ...(ctx.fullLog !== undefined ? { fullLog: ctx.fullLog, logTruncated: ctx.logTruncated === true } : {}),
    };
}

/**
 * Whether the daemon confirms the runner container over (#920): `exited` or `dead`, never running, created or
 * paused. A failed, timed-out or unparsable answer is no confirmation — the container may still run — so the
 * caller says nothing to the supervisor and its own windows stay the bound.
 */
export async function agentContainerEnded(execDocker: ExecDocker, job: BoardJob): Promise<boolean> {
    try {
        const state: unknown = JSON.parse(
            (await execDocker(['inspect', '--format', '{{json .State}}', containerName(job)])).stdout
        );
        const status = typeof state === 'object' && state !== null && 'Status' in state ? state.Status : undefined;
        return status === 'exited' || status === 'dead';
    } catch {
        return false;
    }
}

/**
 * Tells the supervisor, which cannot see the container, that the agent container is over (#920): an agent that died
 * before it wrote an exit marker is read as lost in seconds, not at its start or heartbeat window. `confirmed` is
 * an end the caller already holds the daemon's word for; otherwise the daemon is asked, and no answer says nothing.
 */
export async function tellAgentOver(
    execDocker: ExecDocker,
    job: BoardJob,
    sink: Pick<StepSink, 'agentEnded'>,
    confirmed: boolean
): Promise<void> {
    if (confirmed || (await agentContainerEnded(execDocker, job))) sink.agentEnded(controlTokenOf(job));
}

/**
 * Throws when this attempt's lease has already been killed. Checked after every awaited setup
 * step so a dying attempt stops CREATING resources over a lease it no longer holds — see
 * setupJobServices for why the abort is deliberately teardown-free.
 */
export function assertJobNotKilled(ledger: Pick<KillLedger, 'was'>, job: BoardJob): void {
    if (!ledger.was(job).stopped) return;
    throw new Error(`job ${job.id}: killed while setting up services`);
}

/**
 * The last kill-check before the spawn, after the env file write: a lease lost while the write
 * was pending would otherwise reach spawnFn. On this abort the just-written file is removed by
 * hand — the run's own cleanup only wraps a settled outcome, and this throw precedes it.
 */
export async function assertNotKilledAfterEnvWrite(
    ctx: { ledger: Pick<KillLedger, 'was'>; job: BoardJob; files: RunnerFiles },
    file: string | null
): Promise<void> {
    try {
        assertJobNotKilled(ctx.ledger, ctx.job);
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
    deps: { config: DriverConfig; execDocker: ExecDocker; teardown?: ExecDocker },
    job: BoardJob,
    session: RunSession | null,
    options: { envFile?: string }
): Promise<RunOutcome | null> {
    const { config, execDocker, teardown } = deps;
    try {
        await execDocker(dockerArgs(config, job, session, options));
        const telemetry = telemetryConfig(job.executorType, config.otelEndpoint);
        await execDocker(['cp', '-', `${containerName(job)}:${telemetryCopyTarget(telemetry)}`], {
            input: telemetryConfigTar(telemetry),
        });
        return null;
    } catch (error) {
        const refused = startupRefusalOf(error);
        return dockerRunVerdict(CONTAINER_GONE, {
            execDocker,
            ...(teardown ? { teardown } : {}),
            job,
            output: dockerErrorDetail(error),
            timedOut: false,
            cacheLost: null,
            refusalCause: refused instanceof StartupRefused ? refused.startupCause : null,
        });
    }
}

/**
 * An attached start the daemon refused, proven before anything waits on the run (#824 D11): a
 * failing close, the daemon's proof the container never ran (`closedStateOf`), and words that prove
 * a cause — answered with that daemon state, for the verdict to keep rather than ask again. An
 * inspect that cannot answer proves nothing (null). Reads only: the container stays for the verdict.
 */
export async function provenStartRefusal(
    execDocker: ExecDocker,
    job: BoardJob,
    code: number | null,
    output: string
): Promise<ClosedState | null> {
    if (code === null || code === 0 || startupCauseOf({ message: output }) === null) return null;
    const closed = await closedStateOf(code, { execDocker, job, timedOut: false });
    return closed.neverRan ? closed : null;
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
        ledger: Pick<KillLedger, 'was' | 'signal'>;
        serviceTeardown: (job: BoardJob) => Promise<void>;
        sleep?: Sleep;
    },
    signal?: AbortSignal
): Promise<RunOutcome | null> {
    if (!(await setupJobServices(job, config, deps))) return null;
    // The supplied stand-down and the attempt's kill end the readiness wait and its listings alike.
    const stand = anyOf(signal, deps.ledger.signal(job));
    await awaitServicesRunning(
        declaredServiceSpecs(job),
        listJobServices(job, deps.execDocker, stand),
        deps.sleep ?? abortableSleep,
        {
            signal: stand,
            after: 'the start',
        }
    );
    return null;
}

/** The attempt's service fleet as the readiness wait reads it. */
const listJobServices = (job: BoardJob, execDocker: ExecDocker, signal?: AbortSignal) => async (deadline: number) => {
    const listed = parseDockerServicePs(
        (await boundedExec(execDocker, { deadline, signal })(servicePsArgs(job))).stdout
    );
    if (listed === null) throw new Error('listing the attempt services: the daemon answered what is not the listing');
    return listed;
};

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

/**
 * The pre-gate restart (issues #560, #773): EVERY recorded service's container removed and run
 * again into the same network namespace — its group supervisor's, whose hosts file still names it —
 * then waited until every one runs. Every failure throws; a stand-down ends it and removes whatever
 * it had started again.
 */
export async function restartJobServices(
    job: BoardJob,
    { config, execDocker }: { config: DriverConfig; execDocker: ExecDocker },
    signal: AbortSignal,
    sleep: Sleep = abortableSleep
): Promise<void> {
    const specs = declaredServiceSpecs(job);
    const remove = (exec: ExecDocker, name: string) =>
        exec(['rm', '-f', serviceContainerName(job, name)]).catch(() => undefined);
    // One absolute deadline for the removals, the runs and the readiness wait; the stand-down's own removals stay off it.
    const deadline = Date.now() + SERVICE_RESTART_TIMEOUT_MS;
    const bounded = boundedExec(execDocker, { deadline, signal });
    try {
        for (const spec of specs) {
            throwIfStoodDown(signal);
            await remove(bounded, spec.name);
            try {
                await bounded(serviceRunArgs(job, spec, supervisorName(job), boardIdentity(config)));
            } catch (e) {
                throw new Error(`could not start service "${spec.name}": ${(e as Error).message}`);
            }
        }
        await awaitServicesRunning(specs, listJobServices(job, execDocker, signal), sleep, {
            signal,
            timeoutMs: timeLeft(deadline),
        });
    } catch (e) {
        if (signal.aborted) for (const spec of specs) await remove(execDocker, spec.name);
        throw e;
    }
}

// The agent container's own start, read off its inspect: `StartedAt` stays the zero time for a
// container the daemon never managed to start (an OCI exec failure included), however much that
// failed start printed. An unreadable or absent container proves nothing.
export async function dockerAgentStarted(execDocker: ExecDocker, job: BoardJob): Promise<boolean> {
    try {
        const { stdout } = await execDocker(['inspect', '--format', '{{.State.StartedAt}}', containerName(job)]);
        const startedAt = stdout.trim();
        return startedAt !== '' && !startedAt.startsWith('0001-01-01');
    } catch {
        return false;
    }
}

// The container is named by this attempt's lease token, so a sample can only ever resolve
// its own attempt's runner — the same attempt-scoping every per-attempt operation here
// leans on. A refused read (the container exited between the ask and the stats round-trip,
// the daemon is busy) answers null, which the loop reads as "report no vitals this round".
// The service fleet is read in the same sampling round, scoped by the same label pair the
// teardown tears down with and requiring the `factory.service` key, so the runner and
// gate containers never answer it; a failed read costs the fleet, not the sample.
export async function dockerSampleRuntime(
    execDocker: ExecDocker,
    config: DriverConfig,
    job: BoardJob
): Promise<Omit<RuntimeSample, 'sampledAt'> | null> {
    const read = await execDocker(['stats', '--no-stream', '--format', '{{json .}}', containerName(job)]).catch(
        () => null
    );
    const vitals = read ? parseDockerStats(read.stdout) : null;
    const services = config.servicesEnabled
        ? await execDocker(servicePsArgs(job))
              .then((found) => parseDockerServicePs(found.stdout))
              .catch(() => null)
        : undefined;
    return composeRuntimeSample(vitals, services);
}
