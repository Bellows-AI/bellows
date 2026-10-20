import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BoardJob, DeclaredGate } from './board.js';
import type { DriverConfig } from './config.js';
import { CONTAINER_GONE } from './exec-codes.js';
import type { GateRunNote } from './timeout-note.js';
import { createControlChannel } from './control-channel.js';
import { GATE_IMAGE, GATE_KEY } from './publish.js';
import { TASK_MOUNT } from './task-volume.js';
import { reportTail } from './runner.js';
import { stepLost, type StepBroker } from './step-control.js';
import type { GateStepRequest } from './supervised-steps.js';
import type { StepResult } from './supervisor-contract.js';
import { readBody, respondJson } from './http.js';
import type { PublishRelay } from './publish-control.js';
import type { ReviewRelay } from './review-control.js';
import type { ExportRelay } from './export-control.js';
import type { QuestionRelay, QuestionResolution } from './question-control.js';
import { parseJsonObject } from './json-parse.js';

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;
/** What a gate cancelled before it started answers — discarded by the loop that cancelled it. */
const CANCELLED_EXIT_CODE = 130;
/** `timeout(1)`'s status: what a gate the supervisor killed at its deadline answers. */
const TIMEOUT_EXIT_CODE = 124;

/**
 * The gates of an attempt (issue #773): every declared gate and the `environment.setup` run in the
 * attempt's own task group — the declared image as a gate container beside the task supervisor, on
 * both executors — as one supervised step each (`Runner.runGate`), which the supervisor hands the
 * gate container through the mailbox only the two of them mount. This module owns what the loop and
 * the ad-hoc endpoint ask of that: the per-checkout queue, the setup ledger, the deadline, and the
 * translation of a step's answer into a gate verdict — or into a harness failure, or a lost
 * supervisor, which are no verdict at all.
 *
 * This module is still a client of nothing but the runner and the loopback interface: it imports no
 * board, no database and no core, per this package's zero-dependency rule.
 */

/** What one gate run came back with. `exitCode` is the gate command's own status. */
export interface GateRun {
    exitCode: number | null;
    output: string;
    /** True when the environment's `setup` command failed: the gate itself never ran. */
    setupFailed?: true;
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
}

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
     * Runs the attempt's `gates.setup` now, before the agent starts (issue #733), under `timeoutMs`
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

const MS_PER_MINUTE = 60_000;

/** A declared gate's `timeout:` in ms; undefined when it declares none (or the claim carried no positive number). */
export const declaredTimeoutMs = (gate: DeclaredGate): number | undefined =>
    gate.timeoutMinutes !== undefined && Number.isFinite(gate.timeoutMinutes) && gate.timeoutMinutes > 0
        ? gate.timeoutMinutes * MS_PER_MINUTE
        : undefined;

/**
 * The longest gate an ad-hoc call may start: the agent's shell tool gives up on one command at 10
 * minutes, and the hangup cancels the run, so a longer gate would be killed every time.
 */
const AD_HOC_MAX_MINUTES = 10;

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
 * lost mid-run), which rejects: never a verdict.
 */
function gateRunOf(result: StepResult, deadlineMs: number): GateRun {
    const output = reportTail(`${result.stdout}${result.stderr}`.trim());
    if (result.timedOut) {
        return { exitCode: TIMEOUT_EXIT_CODE, output: output || `[driver] gate killed after ${deadlineMs}ms` };
    }
    if (result.exitCode === null) throw gateHarness(result.stderr.trim() || 'the gate container answered no exit');
    return { exitCode: result.exitCode, output };
}

interface SupervisedEntry {
    /** The checkout key: the worktree under the mount every request names. */
    key: string;
    job: BoardJob;
    envBody: string;
    /** The `.bellows.yaml` setup command, until it has succeeded once for this attempt. */
    pendingSetup: string | null;
}

/** What a re-acquire of the same attempt keeps — whether its setup succeeded; a different attempt starts over. */
const pendingSetupOf = (prev: SupervisedEntry | undefined, job: BoardJob): string | null =>
    prev && prev.job.id === job.id && prev.job.leaseToken === job.leaseToken
        ? prev.pendingSetup
        : (job.gates?.setup ?? null);

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
 * The gate manager of both executors (issue #773): a gate run is one supervised step in the
 * attempt's task group, whose gate container runs it in the checkout. Nothing here starts a
 * container, a Job or a cooldown: the gate container lives and ends with its group.
 */
export function createSupervisedGateManager({
    config,
    runner,
    gateTimeoutMs = config.gateTimeoutMs,
}: {
    config: DriverConfig;
    runner: GateRunner;
    /** The wall-clock cap on ONE gate. A hung gate must fail the gate, not stall the verdict forever. */
    gateTimeoutMs?: number;
}): GateManager {
    const entries = new Map<string, SupervisedEntry>();
    const serialize = keyQueue();

    /** One command in the checkout's worktree, under `deadlineMs`, as the attempt's gate step. */
    const exec = async (
        entry: SupervisedEntry,
        run: { command: string; deadlineMs: number; signal: AbortSignal | undefined }
    ): Promise<GateRun> => {
        const gate = {
            command: run.command,
            cwd: `${TASK_MOUNT}/${entry.key.split('/')[1]}`,
            env: envBodyRecord(entry.envBody),
            timeoutMs: run.deadlineMs,
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
        const cancelled: GateRun = { exitCode: CANCELLED_EXIT_CODE, output: '[driver] gate cancelled' };
        if (signal?.aborted) return Promise.resolve(cancelled);
        const queued = serialize(key, async (): Promise<GateRun> => {
            if (signal?.aborted) return cancelled;
            const entry = entries.get(key);
            if (!entry) throw gateHarness(`no gate environment for ${key}`);
            return work(entry);
        });
        return signal ? answerOnAbort(queued, signal, cancelled) : queued;
    };

    return {
        async acquire(key, image, envBody = '', attempt) {
            const job = assertAcquirable(key, image, attempt);
            entries.set(key, { key, job, envBody, pendingSetup: pendingSetupOf(entries.get(key), job) });
        },

        runGate(key, _name, command, { signal, timeoutMs } = {}) {
            return inQueue(key, signal, async (entry) => {
                // The worktree persists across the attempt's gates, so setup runs once, before the
                // first gate, until it succeeds.
                const pending = entry.pendingSetup;
                if (pending) {
                    const setupRun = await exec(entry, { command: pending, deadlineMs: gateTimeoutMs, signal });
                    if (setupRun.exitCode !== 0) return { ...setupRun, setupFailed: true as const };
                    if (entry.pendingSetup === pending) entry.pendingSetup = null;
                }
                return exec(entry, { command, deadlineMs: gateDeadlineMs(config, gateTimeoutMs, timeoutMs), signal });
            });
        },

        runSetup(key, { signal, timeoutMs } = {}) {
            const owner = entries.get(key);
            if (!owner) return Promise.reject(gateHarness(`no gate environment for ${key}`));
            const setup = owner.job.gates?.setup;
            if (!setup) return Promise.resolve(null);
            return inQueue(key, signal, async (entry) => {
                const run = await exec(entry, { command: setup, deadlineMs: timeoutMs ?? gateTimeoutMs, signal });
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

/**
 * The ad-hoc channel: a tiny HTTP server the RUNNER's agent calls to run one declared gate and
 * read its output, mid-run — "partially run tests in the environment image".
 *
 * The security posture, in one place: the endpoint listens on loopback by default (the bind
 * address is the access control, the dashboard's own rule); a call must carry a bearer token the
 * loop minted for ONE job; and the only thing a call can ask for is a gate NAME the job's own
 * `.bellows.yaml` declared — never an arbitrary command. The values travel by env file into the
 * runner, never in argv, like every credential here.
 */
/** One gated job's registration with the ad-hoc endpoint. */
export interface GateClaim {
    key: string;
    image: string;
    envBody?: string;
    job: BoardJob;
    gates: readonly DeclaredGate[];
    /** The env body asked for when a run starts (a GitHub token of its own); absent, `envBody` stands. */
    freshEnv?: () => Promise<string>;
    /** The dead-service note the loop's sampler last set (issue #487); set on the stored claim, never at register. */
    deadServices?: string | undefined;
    /**
     * Told when an ad-hoc gate found the attempt's supervisor lost (`stepLost`, issue #773): the
     * agent's call answers incomplete, and the attempt is the loop's to interrupt.
     */
    onInfraLoss?: (reason: string) => void;
}

export interface GateServer {
    /**
     * Registers one gated job: its minted token, the checkout key, the environment image, the
     * gates that job's `.bellows.yaml` declared, and the job itself — the attempt context every
     * acquire needs (the manager refuses one without it). Unregistered on every exit path by the loop.
     */
    register(token: string, claim: GateClaim): void;
    /**
     * Ends the token: no new ad-hoc run, and every one of it still in flight is cancelled (the
     * supervisor has the gate container kill it) — a finished attempt must not leave a gate
     * writing its worktree. Killing the runner does not stop a gate the agent asked for.
     */
    unregister(token: string): void;
    /** A stop, lost lease or Remove: the same as `unregister`, named for the loop's intent. */
    cancel(token: string): void;
    /**
     * The latest ad-hoc run per declared gate name, as the server recorded it completing (issue
     * #339) — what a timed-out run's kill note quotes as "the last gate verdicts". A harness
     * failure (409/500) is not a verdict and records nothing; unregister clears.
     */
    lastRuns(token: string): readonly GateRunNote[];
    /**
     * Sets the dead-service note (issue #487) every later ad-hoc answer of this token carries as
     * `deadServices` — the one channel to an agent mid-run. Null clears it; an unknown token does nothing.
     */
    setDeadServices(token: string, note: string | null): void;
    /**
     * Opens the run-control channel for one attempt: `GET /control` under the supervisor `token`
     * answers `{ stop, kill }`, false until `raiseStop` / `raiseKill`. Independent of any gate
     * registration — every launched attempt gets one, gated or not. Idempotent.
     */
    openControl(token: string, relay?: QuestionRelay, publisher?: PublishRelay, reviewer?: ReviewRelay): void;
    /** Opens the agent's own token beside an open supervisor `token`: the publish and review routes only. */
    grantAgent(token: string, agentToken: string): void;
    /** Opens the transcript exporter's own token beside an open supervisor `token`: the export routes only. */
    grantExporter(token: string, exporterToken: string, exporter?: ExportRelay): void;
    /** Closes a bound exporter token (a review's close-time export) once its step is over. */
    revokeExporter(exporterToken: string): void;
    /** Gives an open control token its transcript exporter's relay (the `/export` routes). */
    attachExporter(token: string, exporter: ExportRelay): void;
    /**
     * Settles a pending question on an open control token: an answer the board recorded, or an
     * answer arriving. False — and nothing changes — for an unknown token or id and a question
     * already settled, so a heartbeat repeating an answer is a no-op.
     */
    resolveQuestion(token: string, questionId: string, resolution: QuestionResolution): boolean;
    /** Whether a question is pending on the token — the wait a Stop must drain rather than kill. */
    hasPendingQuestion(token: string): boolean;
    /** Turns every pending question of the token into `cancelled`. */
    cancelQuestions(token: string): void;
    /**
     * Whether a runner has read this control token at least once. A stop is cooperative only when
     * something is listening: an unpolled token (an old image, an unreachable endpoint) is killed
     * at once instead of waiting out the grace.
     */
    controlPolled(token: string): boolean;
    /** Raises the stop on an open control token; repeated calls and unknown tokens do nothing. */
    raiseStop(token: string): void;
    /** Raises the kill order on an open control token: the supervisor ends the agent now. Idempotent. */
    raiseKill(token: string): void;
    /** Ends the control token: the supervisor and the agent both get 401 from here on. */
    closeControl(token: string): void;
    /** Idempotent. Resolves with the bound port, which is what the advertised URL is built from. */
    listen(): Promise<number>;
    close(): Promise<void>;
}

/** `{"gate":"<≤64 chars>"}` — a body many times that size is an attack, not a request. */
const BODY_LIMIT = 4096;

type GateRequest = { ok: true; gate: string } | { ok: false; status: number; error: string };

/** Reads and validates the ad-hoc endpoint's request body: `{"gate": "<declared name>"}`. */
const parseGateRequest = async (request: IncomingMessage): Promise<GateRequest> => {
    const raw = await readBody(request, BODY_LIMIT);
    if (raw === null) return { ok: false, status: HTTP_PAYLOAD_TOO_LARGE, error: 'body too large' };
    const parsed = parseJsonObject(raw);
    if (parsed === null) return { ok: false, status: HTTP_BAD_REQUEST, error: 'body must be JSON' };
    if (typeof parsed.gate !== 'string' || !parsed.gate.trim()) {
        return { ok: false, status: HTTP_BAD_REQUEST, error: 'gate must be a name' };
    }
    return { ok: true, gate: parsed.gate };
};

/**
 * Acquires the checkout's gate environment and runs the declared gate in it, translating the
 * outcome into the ad-hoc endpoint's response. CONTAINER_GONE means the gate could not be run — its
 * container never took it or was lost mid-run — and is reported 409 rather than 500 so the agent's
 * own retry can ask again. A lost supervisor is the attempt's loss: 503, incomplete, and the claim
 * is told (`onInfraLoss`).
 */
const runRegisteredGate = async (
    manager: Pick<GateManager, 'acquire' | 'runGate'>,
    claim: GateClaim,
    gate: DeclaredGate,
    signal: AbortSignal
): Promise<{ status: number; body: unknown }> => {
    // A cancelled token runs nothing more.
    if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
    try {
        const envBody = claim.freshEnv ? await claim.freshEnv() : (claim.envBody ?? '');
        await manager.acquire(claim.key, claim.image, envBody, claim.job && { job: claim.job });
    } catch (e) {
        return {
            status: HTTP_INTERNAL_SERVER_ERROR,
            body: { error: `gate environment failed to start: ${(e as Error).message}` },
        };
    }
    try {
        const outcome = await manager.runGate(claim.key, gate.name, gate.command, {
            signal,
            timeoutMs: declaredTimeoutMs(gate),
        });
        // A cancelled run's answer is whatever the kill left — never a verdict to record.
        if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
        return { status: HTTP_OK, body: outcome };
    } catch (e) {
        if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
        if (stepLost(e)) {
            const reason = `the task supervisor running the gate was lost: ${(e as Error).message}`;
            claim.onInfraLoss?.(reason);
            return { status: HTTP_SERVICE_UNAVAILABLE, body: { error: reason, incomplete: true } };
        }
        if ((e as { code?: number }).code === CONTAINER_GONE) {
            return { status: HTTP_CONFLICT, body: { error: 'gate environment is gone' } };
        }
        return { status: HTTP_INTERNAL_SERVER_ERROR, body: { error: (e as Error).message } };
    }
};

/** Mutates the STORED claim — replacing it would read as a cancel to a request already holding it. */
const setDeadNote = (claim: GateClaim | undefined, note: string | null): void => {
    if (claim) claim.deadServices = note ?? undefined;
};

/** An answered gate run carries the claim's dead-service note beside its verdict (issue #487). */
const withDeadNote = (result: { status: number; body: unknown }, claim: GateClaim): unknown =>
    result.status === HTTP_OK && claim.deadServices
        ? { ...(result.body as object), deadServices: claim.deadServices }
        : result.body;

/**
 * Aborts when the agent hangs up before the answer is written (its runner was killed): the run
 * it asked for is cancelled the same as by the token's own cancel.
 */
const hangupSignal = (reply: ServerResponse): AbortSignal => {
    const hangup = new AbortController();
    reply.on('close', () => {
        if (!reply.writableFinished) hangup.abort();
    });
    return hangup.signal;
};

export function createGateServer({
    host,
    manager,
    steps,
}: {
    host: string;
    manager: Pick<GateManager, 'acquire' | 'runGate'>;
    /** The supervised-step broker the control channel serves; the runners submit to the same one. */
    steps?: StepBroker;
}): GateServer {
    const claims = new Map<string, GateClaim>();
    /** Per token, the controller every ad-hoc run of it listens on — `cancel` aborts it. */
    const cancels = new Map<string, AbortController>();
    /** Per token, the latest completed run per gate name — the timeout note's raw material. */
    const history = new Map<string, Map<string, GateRunNote>>();
    /** The stop poll and the question routes, per control token (`control-channel.ts`). */
    const channel = createControlChannel(steps);
    let server: Server | null = null;
    let listening: Promise<number> | null = null;

    const respond = respondJson;

    const handle = async (request: IncomingMessage, reply: ServerResponse): Promise<void> => {
        const auth = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
        if (await channel.serve(request, reply, auth)) return;
        if (request.method !== 'POST' || request.url !== '/run') {
            return respond(reply, HTTP_NOT_FOUND, { error: 'not found' });
        }
        return handleRun(request, reply, auth);
    };

    /** The ad-hoc gate call: `POST /run` under a gate token. */
    const handleRun = async (request: IncomingMessage, reply: ServerResponse, auth: string): Promise<void> => {
        const claim = claims.get(auth);
        if (!claim) return respond(reply, HTTP_UNAUTHORIZED, { error: 'unknown token' });

        const hangup = hangupSignal(reply);

        const parsedRequest = await readGateRequest(request, auth, claim);
        if (!parsedRequest.ok) return respond(reply, parsedRequest.status, { error: parsedRequest.error });

        // Only a DECLARED name runs. An arbitrary command string here would make the runner's
        // agent a shell on the host through a container the driver owns — the one thing the
        // declare-then-run model exists to prevent.
        const gate = claim.gates.find((candidate) => candidate.name === parsedRequest.gate);
        if (!gate) return respond(reply, HTTP_NOT_FOUND, { error: `no declared gate "${parsedRequest.gate}"` });
        if ((declaredTimeoutMs(gate) ?? 0) > AD_HOC_MAX_MINUTES * MS_PER_MINUTE) {
            return respond(reply, HTTP_UNPROCESSABLE, {
                error: `gate "${gate.name}" declares timeout: ${gate.timeoutMinutes}, longer than an ad-hoc run can wait (${AD_HOC_MAX_MINUTES} minutes); ${gate.onDemand ? 'it is on_demand, so the end-of-run gates pass skips it too' : 'it runs in the end-of-run gates pass'}`,
            });
        }

        const cancelled = AbortSignal.any([cancels.get(auth)?.signal ?? AbortSignal.abort(), hangup]);
        const result = await runRegisteredGate(manager, claim, gate, cancelled);
        if (result.status === HTTP_OK) record(auth, gate.name, (result.body as { exitCode: number | null }).exitCode);
        return respond(reply, result.status, withDeadNote(result, claim));
    };

    /**
     * The request's body, unless its token was cancelled while the body was still arriving: the
     * claim read before is then the dead session's, and nothing may be acquired for it.
     */
    const readGateRequest = async (request: IncomingMessage, token: string, claim: GateClaim): Promise<GateRequest> => {
        const parsed = await parseGateRequest(request);
        if (claims.get(token) !== claim) return { ok: false, status: HTTP_CONFLICT, error: 'gate run cancelled' };
        return parsed;
    };

    const record = (token: string, name: string, exitCode: number | null): void => {
        const runs = history.get(token) ?? new Map<string, GateRunNote>();
        runs.set(name, { name, exitCode, at: new Date().toISOString() });
        history.set(token, runs);
    };

    return {
        register(token, claim) {
            claims.set(token, { ...claim, envBody: claim.envBody ?? '' });
            history.set(token, new Map());
            cancels.set(token, new AbortController());
        },
        unregister(token) {
            const controller = cancels.get(token);
            claims.delete(token);
            history.delete(token);
            cancels.delete(token);
            controller?.abort();
        },
        cancel(token) {
            this.unregister(token);
        },
        openControl: (token, relay, publisher, reviewer) => channel.open(token, relay, publisher, reviewer),
        grantAgent: (token, agentToken) => channel.grantAgent(token, agentToken),
        grantExporter: (token, exporterToken, exporter) => channel.grantExporter(token, exporterToken, exporter),
        revokeExporter: (exporterToken) => channel.revokeExporter(exporterToken),
        attachExporter: (token, exporter) => channel.attachExporter(token, exporter),
        resolveQuestion: (token, id, resolution) => channel.resolveQuestion(token, id, resolution),
        hasPendingQuestion: (token) => channel.hasPendingQuestion(token),
        cancelQuestions: (token) => channel.cancelQuestions(token),
        controlPolled: (token) => channel.polled(token),
        raiseStop: (token) => channel.raiseStop(token),
        raiseKill: (token) => channel.raiseKill(token),
        closeControl: (token) => channel.close(token),
        setDeadServices: (token, note) => setDeadNote(claims.get(token), note),
        lastRuns(token) {
            return [...(history.get(token)?.values() ?? [])];
        },
        listen() {
            // One promise per bind, cached: a second claim racing the first's bind awaits the
            // SAME promise instead of racing port 0 against a half-built server — and a failed
            // bind clears both, so the next call retries instead of answering port 0 forever.
            if (listening) return listening;
            const created = createServer((request, reply) => {
                void handle(request, reply).catch(() =>
                    respond(reply, HTTP_INTERNAL_SERVER_ERROR, { error: 'internal error' })
                );
            });
            server = created;
            const pending = new Promise<number>((resolve, reject) => {
                // The listener stays attached past the bind: a server error arriving later would
                // otherwise surface as an uncaught exception and take the driver down. Only the
                // first error settles the promise; past the bind the handler absorbs the rest.
                let settled = false;
                created.on('error', (error) => {
                    if (!settled) {
                        settled = true;
                        reject(error);
                    }
                });
                created.listen(0, host, () => {
                    settled = true;
                    const address = created.address();
                    resolve(typeof address === 'object' && address ? address.port : 0);
                });
            });
            listening = pending;
            pending.catch(() => {
                if (listening === pending) listening = null;
                if (server === created) server = null;
            });
            return listening;
        },
        close() {
            if (!server) return Promise.resolve();
            const closing = server;
            server = null;
            listening = null;
            claims.clear();
            channel.clear();
            history.clear();
            closing.closeAllConnections();
            return new Promise((resolve) => closing.close(() => resolve()));
        },
    };
}
