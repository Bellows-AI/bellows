import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { Agent, request as httpsRequest } from 'node:https';
import type { DriverConfig } from '../config.js';
import { ARTIFACT_LIMIT } from '../runner.js';
import type { Read } from '../runner.js';
import type { RuntimeSample } from '../runner.js';
import { UUID } from '../publish/publish.js';
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE, MERGE_PATCH_CONTENT_TYPE } from '../http.js';
import type { Board, BoardLease } from '../board/board.js';
import type { KillLedger } from '../kill-ledger.js';
import type { StepSink, SupervisorEndpoint } from '../step-control.js';
import type { TaskGroup } from './k8s-group.js';
import type { TeardownIdentity } from './k8s-teardown.js';
import { parseJsonObject } from '../json-parse.js';
import { type Bound, type Sleep, timeLeft } from '../poll.js';

/**
 * The kubernetes executor's shared low-level vocabulary: the wire types (`K8sResponse`,
 * `K8sJobStatus`, `K8sPodList`, `K8sClaim`), the real transport (`inClusterRequest`), and the
 * protocol constants and status thresholds every other `k8s-*.ts` file reads by import — the
 * transport is injected, the way `createBoard` takes `fetch`, so nothing here needs a cluster to
 * test. See docs/kubernetes.md for the full module map.
 */

/** A uuid, and nothing else — asserted before an id is interpolated into an API path or a pod name. */
export const JOB_ID = UUID;

/** Finished Job objects are reaped after an hour: the log is on the board, the pod is not worth keeping. */
export const TTL_SECONDS = 3_600;

/** `activeDeadlineSeconds` is whole seconds; the config it derives from is milliseconds. */
export const MS_PER_SECOND = 1_000;

/** How often the finished/failed status of the Job is polled. */
export const POLL_MS = 2_000;

/**
 * Consecutive failed reads before the run is abandoned to its lease. About half a minute when the
 * API server answers fast, up to about eight minutes when every attempt hangs out its request
 * timeout — enough to ride out an upgrade or a dropped connection, short enough that a half-dead
 * API server hands the job back to its lease instead of holding a worker slot for an hour. The
 * kubelet's deadline guarantees the JOB reaches a terminal state, but not that this driver can keep
 * READING it; an apiserver that answers 503 forever would otherwise renew a lease around a run
 * nobody can observe.
 */
export const POLL_MAX_CONSECUTIVE_FAILURES = 15;

/**
 * How long create() will wait for the fence's label sweep to actually empty the selector —
 * about five minutes at POLL_MS, the same patience the status poll has. A list that answers
 * nothing is what frees the checkout for the replacement; exceeding the bound is a throw, which
 * leaves the job to its lease — burning an attempt is the alternative to two writers on one
 * checkout.
 */
export const REPLACE_MAX_POLLS = 150;

/** The same patience as a wall-clock bound: the sweep ends by elapsed time, slow reads included. */
export const REPLACE_WAIT_MS = REPLACE_MAX_POLLS * POLL_MS;

/**
 * One API-server request, in milliseconds. The docker runner's child process answers the same
 * guarantee by exiting or not; a socket that never answers would otherwise wedge run() forever,
 * and the lease would be renewed around a run nobody can see.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * What a full pod log transfer is given: it streams for as long as the log is long, so unlike every
 * other answer it is not cut at REQUEST_TIMEOUT_MS — the caller's own `timeoutMs` (a deadline) is
 * its bound. A log read that cannot finish inside it is incomplete, never empty and complete.
 */
export const LOG_READ_MS = 120_000;

/** The time one call is given: a request's default, shortened by its own `timeoutMs`; a log's own alone. */
const callTimeoutMs = (log: boolean, own: number | undefined): number =>
    log ? (own ?? REQUEST_TIMEOUT_MS) : Math.min(REQUEST_TIMEOUT_MS, own ?? REQUEST_TIMEOUT_MS);

/** The tail of the runner's output the board is told about — bounded in lines and, below, in bytes. */
export const LOG_TAIL_LINES = 1_000;

/**
 * The k8s API server's status thresholds, named once for every read below: `< HTTP_ERROR_STATUS`
 * is success, `is2xx` is the 2xx range, and the rest name the
 * specific codes this driver branches on.
 */
export const HTTP_OK_STATUS = 200;
export const HTTP_ERROR_STATUS = 300;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_SERVER_ERROR_STATUS = 500;

export const is2xx = (status: number): boolean => status >= HTTP_OK_STATUS && status < HTTP_ERROR_STATUS;

/** How much of a failed response body rides an error message — a preview, not the whole payload. */
export const ERROR_PREVIEW_CHARS = 200;

/** How much of a failed response body rides the diagnosis log line — the cause needs more than a preview. */
export const DIAGNOSIS_BODY_CHARS = 500;

/**
 * Whether a 400 is the API server's own pre-handler malformed-request answer — Go's `net/http`
 * writes a bare `400 Bad Request` (optionally `: <explanation>`) before any kubernetes handler
 * runs, so it names the request bytes or the connection, never the API (issue #308: observed on
 * both GETs and POSTs, with nothing in the apiserver logs). A genuine API refusal is a JSON
 * `Status` object — `reason: BadRequest`/`Invalid` — and never matches. Deliberately narrow:
 * widening it to "any non-JSON 400" would retry permanent kubelet refusals (the log endpoint's
 * `container has not started`) for the poll's full patience; widen only with a logged body as
 * evidence.
 */
export const isMalformedRequest400 = (status: number, body: string): boolean =>
    status === HTTP_BAD_REQUEST && body.trim().startsWith('400 Bad Request');

/** The one spelling of "<status> with the API's own reason" every `answered` message composes. */
export const answerPreview = (status: number, body: string): string =>
    `answered ${status}: ${body.slice(0, ERROR_PREVIEW_CHARS)}`;

/** The PodMetrics read of `sampleRuntime`: a 404 there is "no sample yet", metrics-server or not. */
const POD_METRICS_PATH = /^\/apis\/metrics\.k8s\.io\/v1beta1\/namespaces\/[^/?]+\/pods\/[^/?]+$/;

/** The pod log read of `tailRunner`; the query (`tailLines`, ...) is not part of the identity. */
const POD_LOG_PATH = /^\/api\/v1\/namespaces\/[^/?]+\/pods\/[^/?]+\/log(\?.*)?$/;

/** The kubelet's answer to a log read of a container still being created, in its own words. */
const CONTAINER_CREATING_MESSAGE = /ContainerCreating/;

/** The Kubernetes `Status` object an API refusal carries; `null` for anything else. */
const readStatus = (body: string): { message: string; reason?: string } | null => {
    try {
        const status = JSON.parse(body) as { kind?: unknown; message?: unknown; reason?: unknown };
        if (status.kind !== 'Status' || typeof status.message !== 'string') return null;
        return typeof status.reason === 'string'
            ? { message: status.message, reason: status.reason }
            : { message: status.message };
    } catch {
        return null;
    }
};

/**
 * The one line a refused (≥300, so a 3xx too) answer logs, or null for a success and for the two
 * expected startup refusals: a 404 on the
 * PodMetrics read (no sample, or no metrics-server) and a 400 `Status` on the pod log read that
 * names the container as `ContainerCreating`. Matched on method, path, status AND content — any
 * other 404 or 400 is still a diagnosis. A `Status` is reduced to its message (and reason); a
 * body that is not one rides as a bounded preview. Headers are never logged.
 */
export function refusalDiagnosis(method: string, path: string, status: number, body: string): string | null {
    if (status < HTTP_ERROR_STATUS) return null;
    const parsed = readStatus(body);
    if (method === 'GET' && status === HTTP_NOT_FOUND && POD_METRICS_PATH.test(path)) return null;
    if (
        method === 'GET' &&
        status === HTTP_BAD_REQUEST &&
        POD_LOG_PATH.test(path) &&
        parsed &&
        CONTAINER_CREATING_MESSAGE.test(parsed.message)
    ) {
        return null;
    }
    const head = `${method} ${path} answered ${status}`;
    if (parsed) {
        const detail = parsed.reason ? `${parsed.message} (${parsed.reason})` : parsed.message;
        return `${head}: ${detail.slice(0, DIAGNOSIS_BODY_CHARS)}`;
    }
    return `${head} body=${body.slice(0, DIAGNOSIS_BODY_CHARS)}`;
}

/** The shell convention for a killed process — the docker manager's timeout shape, matched here. */
export const TIMEOUT_EXIT_CODE = 124;

export interface K8sClaim {
    metadata?: { uid?: string; creationTimestamp?: string | null; annotations?: Record<string, string> };
    data?: { holder?: string; claimSeq?: string };
}

/**
 * Bounded rounds for the acquire loop: POST 409 → read the holder → the holder vanished or was
 * an older attempt we released → POST again. Takeover is strictly forward-only (a claim whose
 * attempt is ahead makes us stand down, never wait), so more than a couple of rounds is an
 * apiserver flapping; the bound turns that into a thrown error and the job goes back to its
 * lease instead of two writers racing one checkout.
 */
export const CLAIM_ROUNDS = 15;

/**
 * One call against the API server. The body is the raw response text rather than a parsed object:
 * the log endpoint answers plain text, and parsing is the caller's problem — which keeps the
 * injected fake a router over (method, path) and nothing more.
 */
export interface K8sResponse {
    status: number;
    body: string;
    /** A pod log whose head the stream buffer dropped: `body` is its tail, never the whole log. */
    truncated?: true;
}

/**
 * The one reading of "did the API server refuse this?" — the message every k8s call site used to
 * spell out by hand, in one place. `null` is success; a string is the refusal, `what` naming the
 * operation ("creating the runner job") and the body preview carrying the apiserver's own reason.
 *
 * It answers a STRING rather than throwing because the channel is the caller's: the fence throws,
 * the publish answers `publishFailed(...)`, a helper answers `{ ok: false, reason: 'runner_error' }`
 * and a gate throws a CONTAINER_GONE-coded harness error. One message shape, five channels — the
 * previous 24 hand-rolled copies could drift on the shape, and the handful of sites that tolerate
 * a status (a gate secret's 409 means an earlier acquire of this same attempt already created it,
 * same name, same values; a fence delete's 404/409 means the object is already going) name it in
 * `tolerate` rather than each writing its own `&& status !== …` chain before the message.
 */
export const refusal = (res: K8sResponse, what: string, ...tolerate: number[]): string | null =>
    res.status < HTTP_ERROR_STATUS || tolerate.includes(res.status)
        ? null
        : `${what} ${answerPreview(res.status, res.body)}`;

/** `refusal` for the majority of call sites, whose channel is a thrown Error. */
export function expectOk(res: K8sResponse, what: string): void {
    const message = refusal(res, what);
    if (message) throw new Error(message);
}

/**
 * A POST's refusal, under the same transient-400 rule `readVerdict` applies to a GET (issue #308):
 * the API server's pre-handler plain-text `400 Bad Request` is connection damage, never this
 * Job's verdict — it THROWS, and the caller's catch arm leaves the job to its lease. A genuine
 * JSON `Status` refusal answers the message, as before. `null` is success.
 */
export function postRefusal(res: K8sResponse, what: string, ...tolerate: number[]): string | null {
    const message = refusal(res, what, ...tolerate);
    if (message && isMalformedRequest400(res.status, res.body)) throw new Error(message);
    return message;
}

export type K8sMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What one call may bring: `contentType`, `signal` and `timeoutMs`. A PATCH is a JSON merge patch
 * unless `contentType` names another patch type — the gate resize's strategic merge patch (issue
 * #773), which merges `initContainers` by name where a merge patch would replace the whole list.
 * An aborted `signal` ends the call at once, and `timeoutMs` shortens (never lengthens) the
 * transport's own deadline: the call rejects by then, whatever the connection is doing.
 */
export interface K8sRequestOptions {
    contentType?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

/** One API call. */
export type K8sRequest = (
    method: K8sMethod,
    path: string,
    body?: unknown,
    options?: K8sRequestOptions
) => Promise<K8sResponse>;

const abandoned = (): Error => new Error('the call was abandoned: its signal aborted');

/**
 * `deps` refusing every call once `signal` aborts and handing the signal to each request in flight:
 * the k8s twin of `untilStandDown`. Without a signal, `deps` itself.
 */
export function withSignal(deps: K8sDeps, signal?: AbortSignal): K8sDeps {
    if (!signal) return deps;
    return {
        ...deps,
        signal: deps.signal ? AbortSignal.any([deps.signal, signal]) : signal,
        request: async (method, path, body, options) => {
            if (signal.aborted) throw abandoned();
            return deps.request(method, path, body, {
                ...options,
                signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
            });
        },
    };
}

/**
 * `deps` whose every request ends by the absolute `deadline` (epoch ms) and is refused once it is
 * past: a multi-request round cannot outlive the bound its poll was given.
 */
export function boundedBy(deps: K8sDeps, deadline: number): K8sDeps {
    const bound = Math.min(deps.deadline ?? Infinity, deadline);
    return {
        ...deps,
        deadline: bound,
        request: async (method, path, body, options) => {
            const timeoutMs = Math.min(timeLeft(bound), options?.timeoutMs ?? Infinity);
            if (timeoutMs === 0) throw new Error('the call was refused: its wait is out of time');
            return deps.request(method, path, body, { ...options, timeoutMs });
        },
    };
}

/**
 * The wait a nested poll runs `ms` long in `deps`: no longer than the round it runs in has left
 * (`boundedBy`), pausing through `deps.sleep` and ending on the signal `withSignal` gave it. The one
 * place a poll takes the bounds of the wait around it, so a nested retry cannot outlive its caller.
 */
export function waitOf(deps: K8sDeps, ms: number): { ms: number; sleep: Sleep; signal?: AbortSignal } {
    return {
        ms: Math.min(ms, deps.deadline === undefined ? Infinity : timeLeft(deps.deadline)),
        sleep: deps.sleep,
        ...(deps.signal ? { signal: deps.signal } : {}),
    };
}

/** The bound of the round `deps` runs in, for a step that is not a request (a supervised step): its deadline and kill. */
export const boundOf = (deps: K8sDeps): Bound => ({ deadline: deps.deadline ?? Infinity, signal: deps.signal });

/**
 * Every k8s-executor function's transport bundle, in one parameter — the same `RunnerDeps`
 * technique `docker-runner.ts` uses, and for the same reason: `lint/complexity/useMaxParams`
 * caps a function at four, and almost every function here needs the transport, the sleep hook
 * and the namespace together.
 */
export interface K8sDeps {
    request: K8sRequest;
    sleep: Sleep;
    config: DriverConfig;
    /** Set by `boundedBy`: the absolute time (epoch ms) every request and nested wait of these deps ends by. */
    deadline?: number;
    /** Set by `withSignal`: the kill every request and nested wait of these deps ends on. */
    signal?: AbortSignal;
    /**
     * The board's lease lookup (`Board.leases`): what lets the fence take over a checkout claim
     * that carries no claim sequence (`takeOverStaleClaim`). Absent, such a claim is stood down on.
     */
    leases?: (ids: readonly string[]) => Promise<BoardLease[] | null>;
    /** The board's checkpoint read, for a continuing claim whose task volume is gone (`task-restore.ts`). */
    checkpoints?: Pick<Board, 'checkpoint'>;
    /**
     * The supervised-step channel (issue #771) every sync, probe, snapshot, publish and helper runs
     * through, and the endpoint a supervisor-only group (a terminal reclaim) is served on. Absent,
     * each such step is refused naming the missing channel — never run some other way.
     */
    steps?: StepSink;
    endpoint?: SupervisorEndpoint;
    /** The attempt groups this runner created, by lease token (`k8s-group.ts`); created on first use. */
    groups?: Map<string, TaskGroup>;
    /**
     * The runner Jobs whose end could not be confirmed (`k8s-teardown.ts`), by the checkout holder
     * whose claim they keep, then by Job name; created on first use.
     */
    unconfirmed?: Map<string, Map<string, TeardownIdentity>>;
    /**
     * The finished runner Job each attempt adopted (`k8s-adopt.ts`), by the adopting lease token:
     * the one earlier Job its sweeps keep while it continues that outcome to its verdict.
     */
    adopted?: Map<string, string>;
    /** The holders whose group another incarnation replaced (`k8s-teardown.ts`): their claim is not this runner's to give back. */
    superseded?: Set<string>;
    /** Each attempt's service sidecars' restart counts once last seen ready (`k8s-services.ts`), by lease token. */
    serviceBaselines?: Map<string, Map<string, number>>;
    /** What this runner did to each attempt (`k8s-kill.ts`); created on first use. */
    ledger?: KillLedger;
    /** Test-only: how often a group's end is looked for (`group-watch.ts`); production never sets it. */
    groupWatchMs?: number;
}

/** The ServiceAccount volume every pod gets, holding the token and the cluster CA. */
const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/**
 * The sliding buffer a pod log is kept within, in UTF-16 units. A unit never encodes to less than
 * one UTF-8 byte, so the kept tail holds at least the ARTIFACT_LIMIT bytes the verdict read keeps.
 */
const STREAM_BUFFER_OVERFLOW_MULTIPLE = 2;
const STREAM_BUFFER_LIMIT = STREAM_BUFFER_OVERFLOW_MULTIPLE * ARTIFACT_LIMIT;
const STREAM_BUFFER_TAIL = ARTIFACT_LIMIT;

/**
 * Reads one answer's body. Only a pod log (`sliding`) is kept within the stream buffer: buffering a
 * multi-megabyte log whole would be exactly the unbounded string the docker runner's cap exists to
 * avoid, and only its tail survives downstream. Every other answer is structured and read whole —
 * a cut JSON body could only parse wrong (issue #825). `prefix` is the body's start, kept apart:
 * once the tail has slid past it, the `400 Bad Request` line readVerdict and postRefusal classify
 * on (issue #308) would be gone from the diagnosis log and the body alike.
 */
function collectBody(
    res: IncomingMessage,
    sliding: boolean,
    done: (response: K8sResponse, prefix: string) => void,
    fail: (error: Error) => void
): void {
    let text = '';
    let prefix = '';
    let truncated = false;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
        if (prefix.length < DIAGNOSIS_BODY_CHARS) prefix = (prefix + chunk).slice(0, DIAGNOSIS_BODY_CHARS);
        text += chunk;
        if (sliding && text.length > STREAM_BUFFER_LIMIT) {
            text = text.slice(-STREAM_BUFFER_TAIL);
            truncated = true;
        }
    });
    // A body cut short is never an answer: a reset, an abort or a close before the end rejects.
    let ended = false;
    res.on('error', fail);
    res.on('aborted', () => fail(new Error('the API server aborted the response')));
    res.on('close', () => {
        if (!ended) fail(new Error('the API server closed the response before its end'));
    });
    res.on('end', () => {
        ended = true;
        const status = res.statusCode ?? 0;
        // A cut refusal carries the prefix ahead of the tail so its start survives classification;
        // a cut log is its tail alone, flagged — never a stitched body that reads as the whole log.
        const body = truncated && status >= HTTP_ERROR_STATUS ? prefix + text : text;
        done(truncated ? { status, body, truncated: true } : { status, body }, prefix);
    });
}

interface InClusterRequestDeps {
    env?: NodeJS.ProcessEnv;
    readFile?: typeof readFileSync;
    request?: typeof httpsRequest;
    serviceAccountDir?: string;
    /** Injected by the tests; the real transport owns one dedicated agent, never the global one. */
    agent?: Agent;
    log?: (message: string) => void;
}

/**
 * The real transport: the API server the pod's own environment points at. Built only for a driver
 * running IN a cluster; everything that can fail is made to fail at construction rather than on the
 * first claim — `KUBERNETES_SERVICE_HOST` missing, or a ServiceAccount volume not mounted, are
 * startup errors, not mid-run surprises.
 */
export function inClusterRequest(deps: InClusterRequestDeps = {}): K8sRequest {
    const env = deps.env ?? process.env;
    const readFile = deps.readFile ?? readFileSync;
    const request = deps.request ?? httpsRequest;
    const serviceAccountDir = deps.serviceAccountDir ?? SERVICE_ACCOUNT_DIR;
    const log = deps.log ?? ((message: string) => console.log(`[driver] ${message}`));
    const host = env.KUBERNETES_SERVICE_HOST;
    const port = env.KUBERNETES_SERVICE_PORT ?? '443';
    if (!host) {
        throw new Error(
            'KUBERNETES_SERVICE_HOST is not set: this driver is not running in a cluster. ' +
                'EXECUTOR=kubernetes needs an in-cluster driver — run it in the cluster it serves.'
        );
    }
    // Read once: the CA does not rotate, and reading it here is what makes a pod without its
    // projected ServiceAccount volume fail at startup instead of on every claim.
    const ca = readFile(`${serviceAccountDir}/ca.crt`, 'utf8');
    // One dedicated agent with keep-alive OFF (issue #308): Node's global agent keeps sockets
    // alive, and a request written onto a connection the apiserver has just idle-closed is
    // answered — before any kubernetes handler runs — with the plain-text `400 Bad Request` the
    // driver saw seven times in twelve hours. A fresh connection per request costs a TLS
    // handshake per poll tick and buys the elimination of the reuse race by construction.
    const agent = deps.agent ?? new Agent({ keepAlive: false });

    return (method, path, body, options) =>
        new Promise<K8sResponse>((resolve, reject) => {
            const { signal, contentType } = options ?? {};
            if (signal?.aborted) {
                reject(abandoned());
                return;
            }
            // The socket idles out at the deadline, and an absolute timer ends the call at it: a
            // response that trickles bytes, or stalls open, never resets the first and is cut by
            // the second.
            const sliding = POD_LOG_PATH.test(path);
            const timeoutMs = callTimeoutMs(sliding, options?.timeoutMs);
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const onAbort = () => fail(abandoned());
            // Exactly one settle: the first of an answer, a failure, the deadline and an abort.
            const settle = (outcome: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                outcome();
            };
            const fail = (error: Error) => {
                if (settled) return;
                settle(() => reject(error));
                req.destroy(error);
            };
            const req = request(
                {
                    host,
                    port: Number(port),
                    method,
                    path,
                    ca,
                    agent,
                    timeout: timeoutMs,
                    ...(signal ? { signal } : {}),
                    headers: {
                        // Read per call: a rotated ServiceAccount token must not be remembered.
                        authorization: `Bearer ${readFile(`${serviceAccountDir}/token`, 'utf8').trim()}`,
                        [CONTENT_TYPE_HEADER]:
                            contentType ?? (method === 'PATCH' ? MERGE_PATCH_CONTENT_TYPE : JSON_CONTENT_TYPE),
                    },
                },
                (res) =>
                    collectBody(
                        res,
                        sliding,
                        (response, prefix) => {
                            // The diagnosis line (issue #308): method, path, status and the API's own
                            // words — the body IS the diagnosis.
                            const diagnosis = refusalDiagnosis(method, path, response.status, prefix);
                            if (diagnosis !== null) log(diagnosis);
                            settle(() => resolve(response));
                        },
                        fail
                    )
            );
            const deadline = () => new Error(`the API server did not answer within ${timeoutMs}ms`);
            timer = setTimeout(() => fail(deadline()), timeoutMs);
            signal?.addEventListener('abort', onAbort, { once: true });
            // A half-open connection would otherwise hold the run forever — and the loop would
            // renew the lease around a runner nobody can observe or finish.
            req.on('timeout', () => fail(deadline()));
            req.on('error', fail);
            if (body !== undefined) req.write(JSON.stringify(body));
            req.end();
        });
}

export interface K8sJobStatus {
    succeeded?: number;
    failed?: number;
    conditions?: { type: string; status?: string; reason?: string }[];
}

export interface K8sPod {
    metadata?: { name?: string; deletionTimestamp?: string | null };
    /** The containers as specced: what names a sidecar's image when its status does not (#773). */
    spec?: { initContainers?: { name?: string; image?: string }[] };
    status?: {
        phase?: string;
        /** The pod-level ending — `Evicted` and its message — when no container recorded one. */
        reason?: string;
        message?: string;
        /** `DisruptionTarget` is the control plane's mark on a pod it is taking away (issue #560). */
        conditions?: { type?: string; status?: string; reason?: string; message?: string }[];
        containerStatuses?: K8sContainerStatus[];
        /** The init containers', sidecars included (#773 D10): one held on its image holds the whole pod. */
        initContainerStatuses?: K8sContainerStatus[];
    };
}

export interface K8sContainerStatus {
    /** The container's name — the runner pod holds several, so its verdict reads them by name. */
    name?: string;
    image?: string;
    state?: {
        terminated?: { exitCode?: number; reason?: string; message?: string; startedAt?: string | null };
        running?: { startedAt?: string | null };
        waiting?: { reason?: string; message?: string };
    };
    /** A restarted sidecar's (#773 D8): how often the kubelet restarted it, and how its previous container ended. */
    restartCount?: number;
    lastState?: { terminated?: { exitCode?: number; reason?: string; message?: string } };
}

export interface K8sPodList {
    items?: K8sPod[];
}

/**
 * The one pod a job-name-scoped list names, skipping any mid-deletion — a re-claim's replaced
 * attempt can still list its predecessor's pod while it terminates, carrying the same label.
 * The items-level form is what callers that already hold the parsed list use, so the
 * terminating-skip rule has exactly one home.
 */
export function livePodOfItems(items: K8sPod[]): K8sPod | undefined {
    return items.find((item) => !item.metadata?.deletionTimestamp);
}

/** One container's status: the named one in a multi-container pod, the first in an aux pod's only one. */
export function containerStatusOf(pod: K8sPod | undefined, container?: string) {
    const statuses = pod?.status?.containerStatuses;
    return container === undefined ? statuses?.[0] : statuses?.find((status) => status.name === container);
}

/**
 * Why a pod's container ended without success, in the kubelet's own words — `StartError: exec:
 * "node": executable file not found` — or null when it exited 0 or has no state to read. The k8s
 * twin of the docker runner's `dockerErrorDetail`: a container that never started prints no
 * verdict line, and its status is the only place the cause survives.
 */
export function containerFailure(pod: K8sPod | undefined, container?: string): string | null {
    const state = containerStatusOf(pod, container)?.state;
    const terminated = state?.terminated;
    if (terminated && terminated.exitCode !== 0) {
        const reason = terminated.reason ?? `exit ${terminated.exitCode ?? 'unknown'}`;
        return terminated.message ? `${reason}: ${terminated.message}` : reason;
    }
    const waiting = state?.waiting;
    if (waiting?.reason) return waiting.message ? `${waiting.reason}: ${waiting.message}` : waiting.reason;
    return null;
}

/** An entry a grammar refused: `refused` is the path of the field, from the entry, that is outside it. */
export interface Refused {
    refused: string;
}

export const isRefused = (value: unknown): value is Refused =>
    isRecord(value) && typeof value.refused === 'string' && Object.keys(value).length === 1;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One GET's answer as a typed read (#869): the value `shape` makes of the body, `absent` on a 404,
 * or `inconclusive` — a non-2xx answer, a body that is not JSON, a `Status` object (the apiserver's
 * refusal wearing a 2xx) or a body that is not the shape asked for. Never `{}` or `null` invented.
 */
export function readAnswer<T>(
    response: K8sResponse,
    what: string,
    shape: (value: unknown) => T | null | Refused
): Read<T> {
    if (response.status === HTTP_NOT_FOUND) return { kind: 'absent' };
    if (!is2xx(response.status)) {
        return {
            kind: 'inconclusive',
            reason: refusal(response, what) ?? `${what} answered ${response.status}`,
        };
    }
    let body: unknown;
    try {
        body = JSON.parse(response.body);
    } catch {
        return { kind: 'inconclusive', reason: `${what} answered a body that is not JSON` };
    }
    if (isRecord(body) && body.kind === 'Status') {
        return { kind: 'inconclusive', reason: `${what} answered a Status object` };
    }
    const value = shape(body);
    if (isRefused(value)) {
        return { kind: 'inconclusive', reason: `${what} answered an unexpected shape: ${value.refused}` };
    }
    return value === null
        ? { kind: 'inconclusive', reason: `${what} answered an unexpected shape` }
        : { kind: 'value', value };
}

/*
 * The runner vitals under kubernetes. `docker stats` has no direct twin here; the metrics API
 * (`metrics.k8s.io`, served by the metrics-server a cluster may not run) is the closest one, and
 * its absence is not an error: the interface blesses null as "no fresh sample", so a cluster
 * without a metrics-server renders no vitals rather than a wrong number — the same answer any
 * failed docker read gets.
 */

/** CPU quantities as the metrics API prints them: nanos, micros, millis, or whole cores. */
const CPU_QUANTITY = /^([0-9]*\.?[0-9]+)(n|u|m)?$/;

/** Sub-milli CPU quantity suffixes, to millicores. */
const NANOS_PER_MILLI = 1e6;
const MICROS_PER_MILLI = 1e3;
const MILLICORES_PER_CORE = 1_000;

/** Millicores — the unit `cpuPercent` is a tenth of (1000m = one core = 100%). */
const cpuMillicores = (value: string): number | null => {
    const match = CPU_QUANTITY.exec(value.trim());
    if (!match) return null;
    const n = Number.parseFloat(match[1]!);
    if (!Number.isFinite(n)) return null;
    if (match[2] === 'n') return n / NANOS_PER_MILLI;
    if (match[2] === 'u') return n / MICROS_PER_MILLI;
    if (match[2] === 'm') return n;
    return n * MILLICORES_PER_CORE;
};

/** The binary and decimal SI prefixes metrics-server's memory quantities carry, to MiB. */
const BYTES_PER_MIB = 1_048_576;
const KIB_PER_MIB = 1_024;
const KILO = 1e3;
const MEGA = 1e6;
const GIGA = 1e9;
const TERA = 1e12;
const PETA = 1e15;
const EXA = 1e18;

/** Memory quantities to MiB: the binary suffixes metrics-server emits, plus plain bytes. */
const MEM_TO_MIB: Record<string, number> = {
    '': 1 / BYTES_PER_MIB,
    ki: 1 / KIB_PER_MIB,
    mi: 1,
    gi: KIB_PER_MIB,
    ti: KIB_PER_MIB * KIB_PER_MIB,
    pi: KIB_PER_MIB * KIB_PER_MIB * KIB_PER_MIB,
    ei: KIB_PER_MIB * KIB_PER_MIB * KIB_PER_MIB * KIB_PER_MIB,
    k: KILO / BYTES_PER_MIB,
    m: MEGA / BYTES_PER_MIB,
    g: GIGA / BYTES_PER_MIB,
    t: TERA / BYTES_PER_MIB,
    p: PETA / BYTES_PER_MIB,
    e: EXA / BYTES_PER_MIB,
};

const memMbOfQuantity = (value: string): number | null => {
    const match = /^([0-9]*\.?[0-9]+)\s*([A-Za-z]*)$/.exec(value.trim());
    if (!match) return null;
    const factor = MEM_TO_MIB[match[2]!.toLowerCase()];
    if (factor === undefined) return null;
    return Number.parseFloat(match[1]!) * factor;
};

/**
 * Pulls the vitals out of one PodMetrics object — the first container is the runner, the only
 * container the pod has. Pure and exported for the pinning, like `parseDockerStats`: null for
 * anything it cannot read, because a missed sample costs freshness, never the run.
 * `memPercent` is null by construction — the runner pod declares no memory limit, so there is
 * no denominator to divide by, and a percentage against the node's whole memory would not be
 * the number the docker dashboard renders either.
 */
export function parsePodMetrics(body: string): Omit<RuntimeSample, 'sampledAt'> | null {
    const metrics = parseJsonObject(body) as { containers?: { usage?: { cpu?: unknown; memory?: unknown } }[] } | null;
    if (metrics === null) return null;
    const usage = metrics.containers?.[0]?.usage;
    const millicores = typeof usage?.cpu === 'string' ? cpuMillicores(usage.cpu) : null;
    const memUsedMb = typeof usage?.memory === 'string' ? memMbOfQuantity(usage.memory) : null;
    if (millicores === null || memUsedMb === null) return null;
    return { cpuPercent: millicores / 10, memUsedMb, memPercent: null };
}
