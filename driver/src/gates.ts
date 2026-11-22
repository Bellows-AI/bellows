import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { BoardJob, DeclaredGate } from './board/board.js';
import { parseGateRequest, type GateRequest } from './gate-request.js';
import { AD_HOC_MAX_MINUTES, type GateManager } from './gate-manager.js';
import { createGateAdmission, type GateAdmission } from './gate-admission.js';
import { CONTAINER_GONE } from './exec-codes.js';
import { GateRecordRefused, recordGateRun, type GateEnd, type GateLedger } from './gate-record.js';

import type { GateRunNote } from './timeout-note.js';
import type { ConnectionRelay } from './connection-control.js';
import type { GateTokenRelay } from './gate-token-control.js';
import type { InputDelivery } from './input-control.js';
import { attachersOf, createControlChannel, type FinishRelay, gateRunAttacher } from './control-channel.js';
import type { DaemonState, Read } from './runner.js';
import { withDaemonNote } from './dockerd-loss.js';
import { stepLost, type StepBroker } from './step-control.js';
import { respondJson } from './http.js';
import type { PublishRelay } from './publish/publish-control.js';
import type { ReviewRelay } from './review/review-control.js';
import type { CheckpointRelay, ExportRelay } from './export-control.js';
import type { QuestionRelay, QuestionResolution } from './question-control.js';

export type { GateExecution, GateLedger, GateMeasure, GateRunStart, TreeProbeFn } from './gate-record.js';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL_SERVER_ERROR = 500;
const HTTP_SERVICE_UNAVAILABLE = 503;

const MS_PER_MINUTE = 60_000;

/** A declared gate's `timeout:` in ms; undefined when it declares none (or the claim carried no positive number). */
export const declaredTimeoutMs = (gate: DeclaredGate): number | undefined =>
    gate.timeoutMinutes !== undefined && Number.isFinite(gate.timeoutMinutes) && gate.timeoutMinutes > 0
        ? gate.timeoutMinutes * MS_PER_MINUTE
        : undefined;

/**
 * The ad-hoc channel: a tiny HTTP server the RUNNER's agent calls to run one declared gate and
 * read its output, mid-run — "partially run tests in the environment image".
 *
 * The security posture, in one place: the endpoint listens on loopback by default (the bind
 * address is the access control, the dashboard's own rule); a call must carry a bearer token the
 * loop minted for ONE job; a gate request carries only a gate NAME the job's own `.bellows.yaml`
 * declared; and an `exec` request runs an arbitrary command only in that attempt's own gate
 * container — in its task group, reaching nothing the agent's own container cannot — with no GitHub
 * token, no record and no verdict. The values travel by env file into the runner, never in argv,
 * like every credential here.
 */
/** One gated job's registration with the ad-hoc endpoint. */
export interface GateClaim {
    key: string;
    image: string;
    envBody?: string;
    job: BoardJob;
    gates: readonly DeclaredGate[];
    /** The dead-service note the loop's sampler last set; set on the stored claim, never at register. */
    deadServices?: string | undefined;
    /**
     * Told when an ad-hoc gate found the attempt's supervisor lost (`stepLost`): the
     * agent's call answers incomplete, and the attempt is the loop's to interrupt.
     */
    onInfraLoss?: (reason: string) => void;
    /** The attempt's docker daemon restart read (`Runner.dockerdRestarts`): a failed run it moved under gets a note. */
    dockerdRestarts?: (signal: AbortSignal) => Promise<Read<DaemonState>>;
    /** The claim's gate-run record; absent, an ad-hoc run is not recorded. */
    ledger?: GateLedger;
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
     * Closes the token to new ad-hoc runs (503, retryable) and resolves once every one already admitted
     * has settled, its terminal row written: the completion pass reads the gate record only
     * after this, so no run is still on its way to a verdict it would not see. `register` reopens it.
     */
    quiesce(token: string): Promise<void>;
    /**
     * The latest ad-hoc run per declared gate name, as the server recorded it completing (issue
     * #339) — what a timed-out run's kill note quotes as "the last gate verdicts". A harness
     * failure (409/500) is not a verdict and records nothing; unregister clears.
     */
    lastRuns(token: string): readonly GateRunNote[];
    /**
     * Sets the dead-service note every later ad-hoc answer of this token carries as
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
    /** Gives an open control token its supervisor's checkpoint relay (the `/checkpoint` routes). */
    attachCheckpoint(token: string, checkpoint: CheckpointRelay): void;
    attachInputs(token: string, name: string, delivery: InputDelivery): void;
    /** Gives an open control token the relay of its agent's connection ask. */
    attachConnection(token: string, connection: ConnectionRelay): void;
    /** Gives an open control token the relay of its supervisor's gate token ask (`POST /gate-token`). */
    attachGateToken(token: string, gateToken: GateTokenRelay): void;
    /**
     * Opens `POST /gate/run` on an open control token for its agent: the ad-hoc run of the registered `gateToken`, with
     * the admission, quiesce, filter and cancellation rules of any ad-hoc run. Null for a job that declares no gates, which
     * answers `404 no gates`. Once the gate token is unregistered the route answers a retryable 503 again, never a run.
     */
    attachGateRun(controlToken: string, gateToken: string | null): void;
    /**
     * Opens `POST /gate/finish` on an open control token for its agent: `relay` runs the finish pass (`loop-finish.ts`).
     * Null for a job with no gate environment, which answers `404 no gates`; unattached, a retryable 503.
     */
    attachFinish(controlToken: string, relay: FinishRelay | null): void;
    /**
     * Reopens a token's ad-hoc admission a `quiesce` closed — a finish pass is over and the agent works on. A no-op for
     * a token that is not registered: an ended attempt is never reopened.
     */
    reopen(token: string): void;
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
    /** Leaves the attempt to a newer holder: every token of it is hung up on for `forMs`, never answered 401. */
    departControl(token: string, forMs: number): void;
    /** Idempotent. Resolves with the bound port, which is what the advertised URL is built from. */
    listen(): Promise<number>;
    close(): Promise<void>;
}

/** Why an ad-hoc call of `gate` answers 422, or null: a timeout past what the call can wait, a filter it did not opt into. */
const adHocRefusal = (gate: DeclaredGate, filter: string | undefined): string | null => {
    if ((declaredTimeoutMs(gate) ?? 0) > AD_HOC_MAX_MINUTES * MS_PER_MINUTE) {
        return `gate "${gate.name}" declares timeout: ${gate.timeoutMinutes}, longer than an ad-hoc run can wait (${AD_HOC_MAX_MINUTES} minutes); ${gate.onDemand ? 'it is on_demand, so the end-of-run gates pass skips it too' : 'it runs in the end-of-run gates pass'}`;
    }
    if (filter !== undefined && !gate.filter) {
        return `gate "${gate.name}" does not accept a filter: its .bellows.yaml entry does not set filter: true`;
    }
    return null;
};

/** `factory-gate <name> --last`: the thread's latest stored verdict of the gate, as the claim carried it. */
const lastReportAnswer = (job: BoardJob, name: string): { status: number; body: unknown } => {
    const stored = job.lastGateReports?.find((report) => report.name === name);
    if (!stored) {
        return { status: HTTP_NOT_FOUND, body: { error: `no stored report for gate "${name}" in this thread` } };
    }
    const { status, exitCode, output } = stored;
    return { status: HTTP_OK, body: { status, exitCode, output, last: true } };
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
    target: { gate: DeclaredGate; filter?: string | undefined },
    signal: AbortSignal
): Promise<{ status: number; body: unknown }> => {
    // A cancelled token runs nothing more.
    const { gate, filter } = target;
    if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
    // The run's record: one execution id, a running row before the gate executes, and
    // exactly one terminal row on every exit below — `end` is what the `finally` writes.
    const record = claim.ledger
        ? recordGateRun(claim.ledger, {
              gate,
              source: 'adhoc',
              filtered: filter !== undefined,
              requireRecord: true,
              signal,
          })
        : null;
    let end: GateEnd = { error: new Error('the gate run ended without an answer') };
    try {
        const unready = await acquireFor(manager, claim);
        if (unready) {
            end = { error: unready };
            return {
                status: HTTP_INTERNAL_SERVER_ERROR,
                body: { error: `gate environment failed to start: ${unready.message}` },
            };
        }
        try {
            const outcome = await manager.runGate(claim.key, gate.name, gate.command, {
                signal,
                timeoutMs: declaredTimeoutMs(gate),
                filter,
                execution: record?.execution,
            });
            end = { run: outcome, cancelled: signal.aborted };
            // A cancelled run's answer is whatever the kill left — never a verdict to record.
            if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
            const { measure: _measure, ...verdict } = outcome;
            return { status: HTTP_OK, body: record ? { ...verdict, executionId: record.executionId } : verdict };
        } catch (e) {
            end = { error: e, cancelled: signal.aborted };
            return failedRunAnswer(e, claim, signal);
        }
    } finally {
        await record?.finish(end);
    }
};

/** Acquires the checkout's gate environment for the claim; the error that kept it from starting, or null. */
const acquireFor = async (manager: Pick<GateManager, 'acquire'>, claim: GateClaim): Promise<Error | null> => {
    try {
        await manager.acquire(claim.key, claim.image, claim.envBody ?? '', claim.job && { job: claim.job });
        return null;
    } catch (e) {
        return e as Error;
    }
};

/** The ad-hoc answer for a gate run that threw: cancelled, unrecorded, a lost supervisor, a gone container, or a fault. */
const failedRunAnswer = (e: unknown, claim: GateClaim, signal: AbortSignal): { status: number; body: unknown } => {
    if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
    if (e instanceof GateRecordRefused) {
        return { status: HTTP_SERVICE_UNAVAILABLE, body: { error: e.message, retryable: true } };
    }
    if (stepLost(e)) {
        const reason = `the task supervisor running the gate was lost: ${(e as Error).message}`;
        claim.onInfraLoss?.(reason);
        return { status: HTTP_SERVICE_UNAVAILABLE, body: { error: reason, incomplete: true } };
    }
    if ((e as { code?: number }).code === CONTAINER_GONE) {
        return { status: HTTP_CONFLICT, body: { error: 'gate environment is gone' } };
    }
    return { status: HTTP_INTERNAL_SERVER_ERROR, body: { error: (e as Error).message } };
};

/** Mutates the STORED claim — replacing it would read as a cancel to a request already holding it. */
const setDeadNote = (claim: GateClaim | undefined, note: string | null): void => {
    if (claim) claim.deadServices = note ?? undefined;
};

/** An answered gate run carries the claim's dead-service note beside its verdict. */
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

/**
 * The request's body, unless its token was cancelled while the body was still arriving: the
 * claim read before is then the dead session's, and nothing may be acquired for it.
 */
const readGateRequest = async (request: IncomingMessage, stillLive: () => boolean): Promise<GateRequest> => {
    const parsed = await parseGateRequest(request);
    if (!stillLive()) return { ok: false, status: HTTP_CONFLICT, error: 'gate run cancelled' };
    return parsed;
};

/** The declared gate an ad-hoc request names, or the refusal it answers. */
const declaredGateOf = (
    claim: GateClaim,
    request: Extract<GateRequest, { gate: string }>
): { gate: DeclaredGate } | { status: number; body: unknown } => {
    const refused = (status: number, error: string) => ({ status, body: { error } });
    // A setup-only or image-only environment holds a registered door yet declares nothing to run.
    if (claim.gates.length === 0) return refused(HTTP_NOT_FOUND, 'no gates');
    // A gate request runs only a DECLARED name: its verdict is evidence, so the command is the repo's, never the
    // agent's. The agent's own commands come as `exec`, which runs unrecorded and tokenless (`runExec`).
    const gate = claim.gates.find((candidate) => candidate.name === request.gate);
    if (!gate) return refused(HTTP_NOT_FOUND, `no declared gate "${request.gate}"`);
    // `--last` reads a stored report and runs nothing, whatever the gate's timeout.
    if (request.last) return lastReportAnswer(claim.job, gate.name);
    const refusal = adHocRefusal(gate, request.filter);
    if (refusal) return refused(HTTP_UNPROCESSABLE, refusal);
    return { gate };
};

/**
 * An agent's exec in the attempt's gate container: the command it sent, one at a time with the checkout's gates,
 * never recorded and never a gate's latest run — its answer is the command's exit and output, no verdict.
 */
const runExec = async (
    manager: Pick<GateManager, 'acquire' | 'runGate'>,
    claim: GateClaim,
    command: string,
    signal: AbortSignal
): Promise<{ status: number; body: unknown }> => {
    if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
    const unready = await acquireFor(manager, claim);
    if (unready) {
        return {
            status: HTTP_INTERNAL_SERVER_ERROR,
            body: { error: `gate environment failed to start: ${unready.message}` },
        };
    }
    try {
        const outcome = await manager.runGate(claim.key, 'exec', command, { signal, exec: true });
        if (signal.aborted) return { status: HTTP_CONFLICT, body: { error: 'gate run cancelled' } };
        return { status: HTTP_OK, body: { exitCode: outcome.exitCode, output: outcome.output } };
    } catch (e) {
        return failedRunAnswer(e, claim, signal);
    }
};

/** An exec request under its token: admitted like a gate run (503 once closed), never recorded or noted. */
const answerExec = async (
    at: {
        manager: Pick<GateManager, 'acquire' | 'runGate'>;
        admission: GateAdmission;
        auth: string;
        claim: GateClaim;
        reply: ServerResponse;
    },
    command: string,
    cancelled: AbortSignal
): Promise<void> => {
    const { manager, admission, auth, claim, reply } = at;
    if (admission.isClosed(auth)) {
        return respondJson(reply, HTTP_SERVICE_UNAVAILABLE, { error: 'ad-hoc gate runs are closed', retryable: true });
    }
    const run = () => runExec(manager, claim, command, cancelled);
    const result = await admission.admit(auth, withDaemonNote(claim.dockerdRestarts, cancelled, run));
    return respondJson(reply, result.status, withDeadNote(result, claim));
};

/** Notes the latest completed run of a gate for its token: the timeout note's raw material. */
const recordNote = (
    history: Map<string, Map<string, GateRunNote>>,
    token: string,
    name: string,
    exitCode: number | null
): void => {
    const runs = history.get(token) ?? new Map<string, GateRunNote>();
    runs.set(name, { name, exitCode, at: new Date().toISOString() });
    history.set(token, runs);
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
    /** Per token, the ad-hoc runs admitted and not yet settled, and whether more are still admitted. */
    const admission = createGateAdmission();
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

        const parsedRequest = await readGateRequest(request, () => claims.get(auth) === claim);
        if (!parsedRequest.ok) return respond(reply, parsedRequest.status, { error: parsedRequest.error });
        const cancelled = AbortSignal.any([cancels.get(auth)?.signal ?? AbortSignal.abort(), hangup]);
        if ('exec' in parsedRequest) {
            return answerExec({ manager, admission, auth, claim, reply }, parsedRequest.exec, cancelled);
        }

        const declared = declaredGateOf(claim, parsedRequest);
        if (!('gate' in declared)) return respond(reply, declared.status, declared.body);
        const { gate } = declared;

        if (admission.isClosed(auth)) {
            return respond(reply, HTTP_SERVICE_UNAVAILABLE, { error: 'ad-hoc gate runs are closed', retryable: true });
        }
        const run = () => runRegisteredGate(manager, claim, { gate, filter: parsedRequest.filter }, cancelled);
        const result = await admission.admit(auth, withDaemonNote(claim.dockerdRestarts, cancelled, run));
        // A filtered run is a partial answer: it never stands as the gate's latest run.
        if (result.status === HTTP_OK && parsedRequest.filter === undefined)
            recordNote(history, auth, gate.name, (result.body as { exitCode: number | null }).exitCode);
        return respond(reply, result.status, withDeadNote(result, claim));
    };

    return {
        register(token, claim) {
            claims.set(token, { ...claim, envBody: claim.envBody ?? '' });
            admission.open(token);
            history.set(token, new Map());
            cancels.set(token, new AbortController());
        },
        unregister(token) {
            const controller = cancels.get(token);
            claims.delete(token);
            history.delete(token);
            cancels.delete(token);
            admission.forget(token);
            controller?.abort();
        },
        cancel(token) {
            this.unregister(token);
        },
        quiesce: (token) => admission.close(token),
        reopen(token) {
            if (claims.has(token)) admission.open(token);
        },
        openControl: (token, relay, publisher, reviewer) => channel.open(token, relay, publisher, reviewer),
        grantAgent: (token, agentToken) => channel.grantAgent(token, agentToken),
        grantExporter: (token, exporterToken, exporter) => channel.grantExporter(token, exporterToken, exporter),
        revokeExporter: (exporterToken) => channel.revokeExporter(exporterToken),
        ...attachersOf(channel),
        attachGateRun: gateRunAttacher(channel, claims, handleRun),
        resolveQuestion: (token, id, resolution) => channel.resolveQuestion(token, id, resolution),
        hasPendingQuestion: (token) => channel.hasPendingQuestion(token),
        cancelQuestions: (token) => channel.cancelQuestions(token),
        controlPolled: (token) => channel.polled(token),
        raiseStop: (token) => channel.raiseStop(token),
        raiseKill: (token) => channel.raiseKill(token),
        closeControl: (token) => channel.close(token),
        departControl: (token, forMs) => channel.depart(token, forMs),
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
