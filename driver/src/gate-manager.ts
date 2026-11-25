import type { Attributes } from '@opentelemetry/api';
import type { BoardJob } from './board/board.js';
import type { DriverConfig } from './config.js';
import type { GateOutcome } from './driver-metrics.js';
import { CONTAINER_GONE } from './exec-codes.js';
import { type GateResources, type GateResult, gateResultOf } from './gate-result.js';
import { type GateExecution, type GateMeasure, measuredRun } from './gate-record.js';
import { annotateActiveSpan, withChildSpan } from './lifecycle-span.js';
import { GATE_IMAGE, GATE_KEY } from './publish/publish.js';
import { failureExcerpt } from './gate-excerpt.js';
import { ARTIFACT_LIMIT, REPORT_BYTE_LIMIT, tailKept } from './runner.js';
import { StepTokenUnanswered } from './step-control.js';
import type { GateStepRequest } from './supervised-steps.js';
import type { StepResult } from './supervisor-contract.js';
import { TASK_MOUNT } from './task-volume.js';

/**
 * The gates of an attempt: every declared gate and the `environment.setup` run in the attempt's own task
 * group — the declared image as a gate container beside the task supervisor, on both executors — as one
 * supervised step each (`Runner.runGate`), which the supervisor hands the gate container through the
 * mailbox only the two of them mount. This module owns what the loop and the ad-hoc endpoint (`gates.ts`)
 * ask of that: the per-checkout queue, the setup ledger, the deadline, and the translation of a step's
 * answer into a gate verdict — or into a harness failure, or a lost supervisor, which are no verdict at all.
 *
 * This module is still a client of nothing but the runner and the loopback interface: it imports no
 * board, no database and no core, per this package's zero-dependency rule.
 */

/** Told of each gate run that ended (`DriverMetrics.gate`): the gate, how it ended, its seconds and the guest's resources. */
export type GateObserver = (gate: string, outcome: GateOutcome, seconds: number, resources?: GateResources) => void;

/** What a gate cancelled before it started answers — discarded by the loop that cancelled it. */
const CANCELLED_EXIT_CODE = 130;
/** `timeout(1)`'s status: what a gate the supervisor killed at its deadline answers. */
const TIMEOUT_EXIT_CODE = 124;

/** What one gate run came back with. `exitCode` is the gate command's own status. */
export interface GateRun {
    exitCode: number | null;
    /** What the answer carries: the whole output when it fits, else the failure lines and the tail (`failureExcerpt`). */
    output: string;
    /**
     * The run's whole output, tail-kept at `ARTIFACT_LIMIT` — what the gate-log artifact stream stores. Absent when
     * `output` is all of it; `fullTruncated` when the head was cut.
     */
    fullOutput?: string;
    fullTruncated?: true;
    /** True when the environment's `setup` command failed: the gate itself never ran. */
    setupFailed?: true;
    /** What the run measured around the gate command; present only for a run given an `execution`. */
    measure?: GateMeasure;
    /** What the gate recorded beside its output: failed tests, selection, slowest files, the guest's resources. */
    result?: GateResult;
}

/**
 * The attempt one `acquire` is for: the job whose task group runs the gates. An aborted `signal` (the
 * attempt's stand-down) refuses the acquire.
 */
export interface GateAttempt {
    job: BoardJob;
    signal?: AbortSignal;
}

/** How one gate run is bounded: the cancel `signal`, and the gate's own declared `timeoutMs`. */
export interface GateRunOptions {
    signal?: AbortSignal | undefined;
    timeoutMs?: number | undefined;
    /** The ad-hoc request's narrowing, set as env `GATE_FILTER` for this one run; never part of the command. */
    filter?: string | undefined;
    /** Records the run: probes the tree inside the queue around it and writes the running row first. */
    execution?: GateExecution | undefined;
    /**
     * The run takes no turn in the checkout's queue: gates asked this way together run at once, and the caller waits
     * for all of them before it asks for the next serial one. The pending setup still runs first, once for the group.
     */
    parallel?: boolean | undefined;
    /**
     * An agent's exec (`{"exec"}` on the ad-hoc endpoint): the command it asked for, in the checkout's queue, under
     * the ad-hoc cap, with no setup run first, no record and no GitHub token (`StepRequest.tokenless`).
     */
    exec?: true | undefined;
}

/**
 * The longest run an ad-hoc call may start: the agent's shell tool gives up on one command at 10
 * minutes, and the hangup cancels the run, so a longer gate would be killed every time.
 */
export const AD_HOC_MAX_MINUTES = 10;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1000;

export interface GateManager {
    /**
     * Files the attempt under the checkout key with the env its gates get, validating the key and
     * the image. Idempotent: a re-acquire of the same attempt keeps whether its setup succeeded and
     * takes the newer env body. The attempt's `gates.setup` runs before the agent starts
     * (`runSetup`); a setup still pending after it — it failed — runs again before the next gate,
     * which answers `setupFailed` when it fails.
     */
    acquire(key: string, image: string, envBody?: string, attempt?: GateAttempt): Promise<void>;
    /**
     * Runs one declared gate in the attempt's gate container. An abort of `signal` cancels the gate
     * where it stands — the supervisor has the gate container kill it — and the run answers whatever
     * the cancellation left; the caller discards it. `timeoutMs` is the gate's own declared budget
     * (`gateDeadlineMs`); setup always runs under the driver default. A lost supervisor rejects
     * (`stepLost`): no verdict, the attempt's interruption.
     */
    runGate(key: string, name: string, command: string, options?: GateRunOptions): Promise<GateRun>;
    /**
     * Runs the attempt's `gates.setup` now, before the agent starts, under `timeoutMs`
     * rather than the gate default; null when the checkout declares none. Always runs — a new
     * attempt re-runs it, relying on its idempotency. A success clears the pending setup the first
     * gate would run; a failure leaves it pending, so that gate retries it.
     */
    runSetup(key: string, options?: GateRunOptions): Promise<GateRun | null>;
    /** Forgets the checkout, unless another attempt has taken it over since (`job` is the releaser). */
    release(key: string, job: BoardJob): void;
    /** Forgets every checkout — the driver drain. */
    stop(): Promise<void>;
}

/** What the manager needs of the runner: one gate execution in the attempt's task group. */
export interface GateRunner {
    runGate(job: BoardJob, gate: GateStepRequest, signal?: AbortSignal): Promise<StepResult>;
}

/** What a gate cancelled before it started answers — discarded by whoever cancelled it. */
const cancelledRun = (): GateRun => ({ exitCode: CANCELLED_EXIT_CODE, output: '[driver] gate cancelled' });

/** A harness failure, not a verdict: the gate could not be run at all. */
const gateHarness = (message: string): Error => Object.assign(new Error(message), { code: CONTAINER_GONE });

/**
 * A Stop while the gate still waits its turn answers at once — the run ahead can hold the queue
 * for the whole gate timeout; the queued work itself bails when it starts.
 */
function answerOnAbort(queued: Promise<GateRun>, signal: AbortSignal, cancelled: GateRun): Promise<GateRun> {
    let onAbort = (): void => {};
    const stoppedWhileQueued = new Promise<GateRun>((resolve) => {
        onAbort = () => resolve(cancelled);
        signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([queued, stoppedWhileQueued]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** One tree probe around a gate run: a probe that outlasts it reads as unknown, never as a hang of the gate. */
export const GATE_RUN_PROBE_MS = 15_000;

/** A gate's deadline: its own timeout, capped by DRIVER_JOB_TIMEOUT_MS, else the driver default. */
export const gateDeadlineMs = (config: { jobTimeoutMs: number }, defaultMs: number, timeoutMs?: number): number =>
    timeoutMs === undefined ? defaultMs : Math.min(timeoutMs, config.jobTimeoutMs);

/**
 * The per-checkout serialization point: one gate at a time per checkout — two suites in one worktree
 * give flaky verdicts — and the setup in the same turn as the gates.
 */
export function keyQueue(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
    const queues = new Map<string, Promise<unknown>>();
    return (key, work) => {
        const chained = (queues.get(key) ?? Promise.resolve()).then(work, work);
        queues.set(
            key,
            chained.catch(() => undefined)
        );
        return chained;
    };
}

/**
 * The env body (`NAME=value` lines, `gateEnvBody`) as the gate step's env. A line is split at its
 * first `=`; the supervisor refuses a name `sh` cannot export, so nothing here is silently dropped.
 */
export function envBodyRecord(body: string): Record<string, string> {
    const env: Record<string, string> = Object.create(null);
    for (const line of body.split('\n')) {
        if (!line) continue;
        const eq = line.indexOf('=');
        if (eq < 0) env[line] = '';
        else env[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return env;
}

/**
 * A step's answer as a gate verdict: its status and its output's tail, trimmed like a terminal's —
 * or, for a gate the supervisor killed at its deadline, 124 with the deadline named when it said
 * nothing. No exit at all is a harness failure (the gate container never took the request, or was
 * lost mid-run), which rejects: never a verdict. A gate whose GitHub token ask went unanswered rejects
 * as a lost step (`stepLost`) whatever it exited with.
 */
function gateRunOf(result: StepResult, deadlineMs: number): GateRun {
    if (result.tokenAskUnanswered) throw new StepTokenUnanswered();
    const raw = `${result.stdout}${result.stderr}`.trim();
    // The excerpt comes from the uncut output: the stored log keeps a tail, and a failure list that stacks
    // pushed past it must still be named in the answer and in the report. Past the supervisor's own cut
    // (`STEP_OUTPUT_LIMIT_BYTES`) the lines it read off the whole file stand in for the head.
    const output = failureExcerpt(raw, REPORT_BYTE_LIMIT, result.failureLines);
    const full = tailKept(raw, ARTIFACT_LIMIT);
    // A log cut here, or by the supervisor before the driver saw it, is a tail: the stream must say so.
    const cut = full.truncated || result.outputCut === true;
    // Beside the answer only when the answer is less than the log: output that fits is its own whole.
    const whole =
        full.content === output && !cut
            ? {}
            : { fullOutput: full.content, ...(cut ? { fullTruncated: true as const } : {}) };
    const recorded = gateResultOf(result.report, result.timedOut);
    const structured = recorded ? { result: recorded } : {};
    if (result.timedOut) {
        return {
            exitCode: TIMEOUT_EXIT_CODE,
            output: output || `[driver] gate killed after ${deadlineMs}ms`,
            ...whole,
            ...structured,
        };
    }
    if (result.exitCode === null) throw gateHarness(result.stderr.trim() || 'the gate container answered no exit');
    return { exitCode: result.exitCode, output, ...whole, ...structured };
}

interface SupervisedEntry {
    /** The checkout key: the worktree under the mount every request names. */
    key: string;
    job: BoardJob;
    envBody: string;
    /** The `.bellows.yaml` setup command, until it has succeeded once for this attempt. */
    pendingSetup: string | null;
    /** The pending setup while it runs: every gate that finds it joins it, so one run answers a whole group. */
    settingUp?: Promise<GateRun | null>;
}

/** Whether two jobs are the same attempt: a re-acquire of it keeps whether its setup succeeded; another starts over. */
const sameAttempt = (a: BoardJob, b: BoardJob): boolean => a.id === b.id && a.leaseToken === b.leaseToken;

/** The checks an acquire makes before it files anything: an attempt, and the key and image shapes. */
function assertAcquirable(key: string, image: string, attempt: GateAttempt | undefined): BoardJob {
    if (attempt?.signal?.aborted) throw gateHarness(`the gate environment of ${key} was cancelled`);
    if (!attempt?.job)
        throw gateHarness('the gate manager runs gates in their attempt’s task group, and no job was given');
    if (!GATE_KEY.test(key)) {
        throw gateHarness(`refusing to run a gate in a checkout key that is not <uuid>/<repo segment>: ${key}`);
    }
    if (!GATE_IMAGE.test(image)) {
        throw gateHarness(`refusing to run a gate in an image that is not a plain image reference: "${image}"`);
    }
    return attempt.job;
}

/**
 * The gate manager of both executors: a gate run is one supervised step in the
 * attempt's task group, whose gate container runs it in the checkout. Nothing here starts a
 * container, a Job or a cooldown: the gate container lives and ends with its group.
 */
export function createSupervisedGateManager({
    config,
    runner,
    gateTimeoutMs = config.gateTimeoutMs,
    probeTimeoutMs = GATE_RUN_PROBE_MS,
    observe,
}: {
    config: DriverConfig;
    runner: GateRunner;
    /** The wall-clock cap on ONE gate. A hung gate must fail the gate, not stall the verdict forever. */
    gateTimeoutMs?: number;
    /** The cap on one tree probe around a recorded gate. */
    probeTimeoutMs?: number;
    /** Told of each declared gate run that ended, for the gate metrics. */
    observe?: GateObserver;
}): GateManager {
    const entries = new Map<string, SupervisedEntry>();
    const serialize = keyQueue();

    /** One command in the checkout's worktree, under `deadlineMs`, as the attempt's gate step. */
    const exec = async (
        entry: SupervisedEntry,
        run: {
            command: string;
            deadlineMs: number;
            signal: AbortSignal | undefined;
            filter?: string | undefined;
            parallel?: boolean | undefined;
            tokenless?: boolean | undefined;
        },
        setup = false
    ): Promise<GateRun> => {
        const gate = {
            command: run.command,
            cwd: `${TASK_MOUNT}/${entry.key.split('/')[1]}`,
            env: {
                ...envBodyRecord(entry.envBody),
                ...(run.filter === undefined ? {} : { [GATE_FILTER_ENV]: run.filter }),
                ...(setup ? { [GATE_SETUP_ENV]: '1' } : {}),
            },
            timeoutMs: run.deadlineMs,
            ...(run.parallel ? { parallel: true as const } : {}),
            ...(run.tokenless ? { tokenless: true as const } : {}),
        };
        return gateRunOf(await runner.runGate(entry.job, gate, run.signal), run.deadlineMs);
    };

    /**
     * The queue and cancel discipline every run in a checkout shares — a gate and the pre-agent
     * setup alike. The entry is read when the run's turn comes, not when it was asked for: an attempt
     * that took the key over while it waited is the one whose gate container it uses.
     */
    const inQueue = (
        key: string,
        signal: AbortSignal | undefined,
        work: (entry: SupervisedEntry) => Promise<GateRun>
    ): Promise<GateRun> => {
        if (!entries.has(key)) return Promise.reject(gateHarness(`no gate environment for ${key}`));
        const cancelled = cancelledRun();
        if (signal?.aborted) return Promise.resolve(cancelled);
        const queued = serialize(key, async (): Promise<GateRun> => {
            if (signal?.aborted) return cancelled;
            const entry = entries.get(key);
            if (!entry) throw gateHarness(`no gate environment for ${key}`);
            return work(entry);
        });
        return signal ? answerOnAbort(queued, signal, cancelled) : queued;
    };

    /**
     * The attempt's pending setup, run now unless it succeeded: null when there is none to run or it passed, the
     * failed run (answered `setupFailed`) otherwise. The worktree persists across the attempt's gates, so setup
     * runs once, before the first gate, until it succeeds. A caller that arrives while it runs joins it.
     */
    const ensureSetup = (entry: SupervisedEntry, signal: AbortSignal | undefined): Promise<GateRun | null> => {
        const pending = entry.pendingSetup;
        if (!pending) return Promise.resolve(null);
        entry.settingUp ??= (async () => {
            try {
                const setupRun = await exec(entry, { command: pending, deadlineMs: gateTimeoutMs, signal }, true);
                if (setupRun.exitCode !== 0) return { ...setupRun, setupFailed: true as const };
                if (entry.pendingSetup === pending) entry.pendingSetup = null;
                return null;
            } finally {
                delete entry.settingUp;
            }
        })();
        return entry.settingUp;
    };

    /** The gate in the worktree, recorded when it is given an `execution`; an exec skips setup and record. */
    const runAfterSetup = async (
        entry: SupervisedEntry,
        command: string,
        { signal, timeoutMs, filter, execution, parallel, exec: isExec }: GateRunOptions
    ): Promise<GateRun> => {
        // An exec leaves a failed setup pending, so the agent can use it to debug that setup.
        if (isExec) {
            const deadlineMs = gateDeadlineMs(config, gateTimeoutMs, AD_HOC_MAX_MINUTES * MS_PER_MINUTE);
            return exec(entry, { command, deadlineMs, signal, tokenless: true });
        }
        const setupFailure = await ensureSetup(entry, signal);
        if (setupFailure) return setupFailure;
        const run = { command, deadlineMs: gateDeadlineMs(config, gateTimeoutMs, timeoutMs), signal, filter, parallel };
        if (!execution) return exec(entry, run);
        return (await measuredRun(execution, { signal, probeTimeoutMs }, () => exec(entry, run))) ?? cancelledRun();
    };

    /** A run outside the checkout's queue, with the cancel discipline of one in it. */
    const alongside = (
        key: string,
        signal: AbortSignal | undefined,
        work: (entry: SupervisedEntry) => Promise<GateRun>
    ): Promise<GateRun> => {
        const entry = entries.get(key);
        if (!entry) return Promise.reject(gateHarness(`no gate environment for ${key}`));
        if (signal?.aborted) return Promise.resolve(cancelledRun());
        return work(entry);
    };

    return {
        async acquire(key, image, envBody = '', attempt) {
            const job = assertAcquirable(key, image, attempt);
            const prev = entries.get(key);
            // The same attempt asking again — each gate of a group does — updates its entry in place, so the
            // setup a sibling gate is running still settles the entry every later gate reads.
            if (prev && sameAttempt(prev.job, job)) Object.assign(prev, { job, envBody });
            else entries.set(key, { key, job, envBody, pendingSetup: job.gates?.setup ?? null });
        },

        runGate(key, name, command, options = {}) {
            const work = (entry: SupervisedEntry): Promise<GateRun> =>
                options.exec
                    ? runAfterSetup(entry, command, options)
                    : observed(name, options.signal, observe, () => runAfterSetup(entry, command, options));
            return options.parallel && !options.exec
                ? alongside(key, options.signal, work)
                : inQueue(key, options.signal, work);
        },

        runSetup(key, { signal, timeoutMs } = {}) {
            const owner = entries.get(key);
            if (!owner) return Promise.reject(gateHarness(`no gate environment for ${key}`));
            const setup = owner.job.gates?.setup;
            if (!setup) return Promise.resolve(null);
            return inQueue(key, signal, async (entry) => {
                const run = await exec(entry, { command: setup, deadlineMs: timeoutMs ?? gateTimeoutMs, signal }, true);
                // A setup queued for one attempt never settles another's.
                const current = entries.get(key);
                if (current?.job.leaseToken === owner.job.leaseToken) {
                    current.pendingSetup = run.exitCode === 0 ? null : setup;
                }
                return run;
            });
        },

        release(key, job) {
            if (entries.get(key)?.job.leaseToken === job.leaseToken) entries.delete(key);
        },

        async stop() {
            entries.clear();
        },
    };
}

/** The env name a filter reaches the gate command as. */
const GATE_FILTER_ENV = 'GATE_FILTER';
/** Tells the gate shell the run is `environment.setup`: see scripts/gate-shell.sh. */
const GATE_SETUP_ENV = 'FACTORY_GATE_SETUP';

/** What the `gate.run` span says of a run: its verdict and what the gate recorded beside its output. */
function gateSpanAttributes(outcome: GateOutcome, run: GateRun): Attributes {
    const { result } = run;
    const { cpu, throttledMs, load, memAvailableMb } = result?.resources ?? {};
    return {
        'bellows.gate.outcome': outcome,
        ...(run.exitCode === null ? {} : { 'bellows.gate.exit_code': run.exitCode }),
        ...(result?.failures ? { 'bellows.gate.failed_tests': result.failures.length } : {}),
        ...(result?.inFlight ? { 'bellows.gate.in_flight_files': result.inFlight.length } : {}),
        ...(result?.selection ? { 'bellows.gate.selection.mode': result.selection.mode } : {}),
        ...(result?.slowest?.[0] ? { 'bellows.gate.slowest.ms': result.slowest[0].ms } : {}),
        ...(cpu
            ? {
                  'bellows.gate.cpu.user_pct': cpu.user,
                  'bellows.gate.cpu.system_pct': cpu.system,
                  'bellows.gate.cpu.iowait_pct': cpu.iowait,
                  'bellows.gate.cpu.steal_pct': cpu.steal,
                  'bellows.gate.cpu.idle_pct': cpu.idle,
              }
            : {}),
        ...(throttledMs === undefined ? {} : { 'bellows.gate.throttled_ms': throttledMs }),
        ...(load ? { 'bellows.gate.load.max': load.max } : {}),
        ...(memAvailableMb ? { 'bellows.gate.memory.available_min_mb': memAvailableMb.min } : {}),
    };
}

/**
 * One declared gate run as a `gate.run` span naming the gate, its outcome and what it recorded, and the observer's
 * call. A setup failure and a cancel are the gate's no-verdict cases: no outcome is observed; a run that threw is the
 * span's ERROR.
 */
const observed = (
    name: string,
    signal: AbortSignal | undefined,
    observe: GateObserver | undefined,
    run: () => Promise<GateRun>
): Promise<GateRun> =>
    withChildSpan('gate.run', { 'bellows.gate.name': name }, async () => {
        const started = performance.now();
        const outcome = await run();
        if (outcome.setupFailed || signal?.aborted) return outcome;
        const seconds = (performance.now() - started) / MS_PER_SECOND;
        const verdict: GateOutcome =
            outcome.exitCode === TIMEOUT_EXIT_CODE ? 'timeout' : outcome.exitCode === 0 ? 'passed' : 'failed';
        annotateActiveSpan(gateSpanAttributes(verdict, outcome));
        observe?.(name, verdict, seconds, outcome.result?.resources);
        return outcome;
    });
