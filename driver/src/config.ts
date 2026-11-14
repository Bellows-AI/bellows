/**
 * The driver's configuration, read from the environment only.
 *
 * No shared config with the server: that process carries a GitHub App private key and describes a
 * dashboard. This one runs somewhere else — on the host, or in a container holding the docker
 * socket — and the two have nothing in common at all: the board tells this process which
 * workspace a job belongs to, so it does not even need to know the organization.
 */
import { CLAUDE_CODE, type ExecutorType, OPENCODE } from './executors.js';
import { loadRunnerClasses, type RunnerClasses } from './runner-classes.js';
import {
    orphanConfigFault,
    SUPERVISOR_ORPHAN_MAX_MS,
    SUPERVISOR_ORPHAN_MIN_MS,
    SUPERVISOR_REBIND_GRACE_MS,
    SUPERVISOR_STEP_WAIT_MS,
} from './supervisor-contract.js';

export interface DriverConfig {
    /** Where the board is. The driver is a client of it, never of the database. */
    boardUrl: string;
    /**
     * The shared board secret the board authenticates this process by, or '' against an open board.
     *
     * Environment only — there is no config file here, and a credential that decides whether a
     * process may run shell commands does not belong on a command line. It is the same value the
     * dashboard validates against (one .env entry / one chart Secret key), and it is the
     * deployment's driver credential: a claim is offered every organization's board, and the org
     * a call operates on comes from the row its URL names.
     */
    boardToken: string;
    /** Names this driver on every claim, so a stuck job can be traced back to a process. */
    worker: string;
    /*
     * `orgId` used to live here, and its only job was building the runner's WORKDIR as
     * `<workspaceMount>/<orgId>`. The board sends `workspacePath` on the claim now — it owns the
     * layout, because it is what created the directory — so this process builds nothing and no
     * longer has to be told which organization it is working for. The board's own claim already says
     * that, and said it more reliably.
     */
    /** Deployment image for each task-selected executor type. CLI choice comes from the claim. */
    executorImages: Readonly<Record<ExecutorType, string>>;
    /**
     * The task volume a new thread gets: kubernetes only, since docker volumes take
     * no class, mode or size. `storageClass` null is the cluster default.
     */
    taskVolume: { storageClass: string | null; accessMode: string; size: string };
    /**
     * How long a thread's task volume outlives its last finalize: `taskVolumeTtlMs` when
     * everything the thread left is whole, `taskVolumeBoundMs` (the longer) when a checkpoint is
     * truncated or an artifact is still pending. The reaper alone deletes it.
     */
    taskVolumeTtlMs: number;
    taskVolumeBoundMs: number;
    /**
     * How many sweep rounds the reaper tries to upload a not-whole thread's unacknowledged transcript
     * bytes before it deletes the volume anyway and logs the loss.
     */
    taskVolumeExportAttempts: number;
    /** Where a task's checkout is cloned from: `<cloneBase>/<owner>/<name>.git`. */
    cloneBase: string;
    /**
     * Where a runner's telemetry is pointed, as `OTEL_EXPORTER_OTLP_ENDPOINT`. Defaults to
     * `http://collector:4318` when `RUNNER_OTEL_ENDPOINT` is not set, so the endpoint is always
     * provided to the runner container.
     *
     * The docker runner forwards the env var and the kubernetes runner names it in the pod spec.
     * Both executors are pointed at the collector this way, regardless of whether the compose
     * network is available. The image's baked default also resolves on the compose network, but a
     * kubernetes runner has no network to join and would silently drop telemetry without this.
     */
    otelEndpoint: string;
    /**
     * Where the runner's branch reporter posts its `session -> (repo, branch)` samples: the
     * board's own base URL, because `/api/sessions/branch` is a board route and the runner's
     * OTLP metrics carry a session id and nothing else — attribution needs this side channel.
     * Defaults to JOB_BOARD_URL (validated identically): on compose and in the chart the runner
     * can already reach the board, so zero configuration is the common case. RUNNER_STATS_URL
     * overrides it for a split topology the default cannot name — and where it cannot reach the
     * board, the reporter's reports silently no-op, exactly as its other failures do.
     */
    statsUrl: string;
    /** Joins the runner to a docker network, which is what lets its telemetry reach the collector. */
    network: string | null;
    concurrency: number;
    pollMs: number;
    leaseSeconds: number;
    /** The wall-clock cap on a run. */
    jobTimeoutMs: number;
    /**
     * Appends --dangerously-skip-permissions. Off by default and deliberately a separate switch: a
     * headless agent cannot answer a permission prompt, so without it most useful jobs stall until
     * the timeout — and with it the agent edits and runs whatever it likes inside the container.
     * Making that a decision someone types is the whole point.
     */
    skipPermissions: boolean;
    /**
     * Names of environment variables forwarded to the runner. Names only: the values are passed as
     * `-e NAME`, which makes docker read them from this process's environment rather than putting a
     * credential in a command line every `ps` on the host can read.
     */
    passEnv: readonly string[];
    /**
     * What spawns the runner: the host's docker daemon (default, the original path), or the
     * Kubernetes API server the driver's own pod talks to — see k8s-transport.ts. An explicit enum, fatal on
     * an unknown value, because a typo must not read as "docker is fine" and quietly spawn nothing.
     */
    executor: 'docker' | 'kubernetes';
    /**
     * The namespace the kubernetes executor creates runner Jobs in. Meaningless under docker. The
     * chart sets it through the downward API, so the driver follows whichever namespace it lands in.
     */
    k8sNamespace: string;
    /**
     * The Helm release this driver was installed by, when the chart set one. Labels every runner
     * Job `app.kubernetes.io/instance`, so a shared namespace's bulk cleanups scope to one
     * release's runners. Null (bare `npm run driver` against a cluster) labels nothing extra.
     */
    k8sRelease: string | null;
    /**
     * The name of a Secret holding the runner credentials under the kubernetes executor — one key
     * per RUNNER_ENV name. The k8s form of `-e NAME`: the names travel, the values live in a Secret
     * the cluster already holds, and nothing readable lands in the pod spec. Null forwards nothing.
     */
    credentialsSecret: string | null;
    /**
     * The runner image's pull policy, under the kubernetes executor. Kubernetes defaults to
     * `Always` for an untagged or :latest image, which would reach past the node's local images to
     * a registry that has never heard of `claude-executor` — where the docker runner would simply
     * have used what the daemon holds. `IfNotPresent` is that behavior, stated.
     */
    imagePullPolicy: string;
    /**
     * The Secrets every pod this driver specs pulls its image with, under the kubernetes executor
     * (RUNNER_IMAGE_PULL_SECRETS, comma-separated names). A private registry is the normal case in
     * a cluster, and a runner pod cannot borrow the driver's pull secret — each pod names its own.
     * Docker has no twin: the daemon's own login is what a `docker run` pulls with.
     */
    imagePullSecrets: string[];
    /**
     * Opts every pod this driver specs (runner, aux Jobs, declared services) out of voluntary
     * disruption under the kubernetes executor (RUNNER_DO_NOT_DISRUPT): both
     * `karpenter.sh/do-not-disrupt` and `cluster-autoscaler.kubernetes.io/safe-to-evict`, so
     * Karpenter consolidation and cluster-autoscaler scale-down leave a run alone. The guarantee
     * stops there: a Spot interruption reclaims the node regardless — Karpenter explicitly
     * excludes interruption from do-not-disrupt, and it does not drain on rebalance
     * recommendations — and an external drain (kubectl drain, a managed-nodegroup upgrade)
     * proceeds all the same. Off by default, and the cost is stated where the decision is made:
     * an undisruptable pod pins its node for as long as its run lasts — up to jobTimeoutMs, two
     * hours by default — so an operator running only on-demand nodes may legitimately leave it
     * off.
     */
    runnerDoNotDisrupt: boolean;
    /**
     * Where the ad-hoc gate server binds. Loopback by default — this endpoint runs shell
     * commands, and the bind address is the access control, exactly as it is for the dashboard.
     */
    gateListenHost: string;
    /**
     * The port of the driver's own scrape listener (`GET /metrics`, on `gateListenHost`, behind the
     * board token); null serves none. Refused without a token on a non-loopback host — runners can
     * reach the driver pod on any port and hold no board token.
     */
    metricsPort: number | null;
    /**
     * The URL the runner is told to reach the gate server by, when loopback will not do — the
     * driver in a container, the runner on the host network, or any split like that. Null builds
     * `http://host.docker.internal:<port>` from the bound port, which the runner reaches through
     * the `--add-host` dockerArgs adds for gated jobs. A URL with no port of its own has the
     * bound port appended (`gateAdvertiseUrlFor`), because the bind is ephemeral; one that
     * carries a port stays verbatim. Never defaulted to something reachable: a wrong guess is a
     * gate that hangs, which reads as a broken test rather than as configuration.
     */
    gateAdvertiseUrl: string | null;
    /**
     * A file the driver touches on a fixed interval (DRIVER_HEARTBEAT_FILE), so a liveness probe
     * can tell a live process from one whose event loop is wedged — the driver serves no HTTP of
     * its own to probe. Null writes nothing.
     */
    heartbeatFile: string | null;
    /**
     * The wall-clock cap on ONE gate run. The runner's own timeout covers the agent; a gate that
     * outlives it (a watch-mode test, a dev server) would otherwise stall the verdict forever.
     * A timed-out gate is a failed gate, exit 124 — the convention `timeout` itself uses.
     */
    gateTimeoutMs: number;
    /**
     * Honors `.bellows.yaml` in the author's checkouts: before a run, the driver reads the file
     * (through a throwaway container over the task volume — it has no host path), starts
     * each declared service as a sibling container on a per-job network, and joins the runner to
     * it, so `redis://cache:6379` resolves for the duration of one job. On by default;
     * `RUNNER_SERVICES=0` is the opt-out — see docs/jobs.md.
     */
    servicesEnabled: boolean;
    /**
     * Watches the run's prompt-cache health and kills the job when the provider stops serving
     * cache hits: N consecutive completed turns with no cached input, over a real context, each
     * turn itself slow. The observed failure mode is a model provider that silently drops its
     * cache mid-run — every turn then re-ingests the whole context at a fraction of the speed,
     * and the run grinds into the job timeout having done a fraction of the work. Killing early
     * names the cause while the timeout would have reported only a corpse. Off by default, so
     * that arming a kill switch over provider quality is something somebody typed.
     */
    cacheWatch: boolean;
    /**
     * How often the cache watch polls the session database. Each poll is one throwaway container
     * over the task volume, so the period keeps the same order as the poll interval —
     * frequent enough to catch a collapse minutes into the turns that reveal it, rare enough
     * that the daemon never notices.
     */
    cacheWatchPollMs: number;
    /**
     * How often the orphan reaper sweeps (DRIVER_REAP_INTERVAL_MS): the periodic watcher that
     * reaps service objects whose owning job can no longer use them — a terminal job's fleet, a
     * board-unknown job's, a superseded attempt's. Every delete is decided by the board's answer
     * and scoped to a dead attempt's labels, so the default-on cadence costs one list and one
     * lease lookup per period. `0` disables the reaper.
     */
    reapIntervalMs: number;
    /**
     * How long an object must have existed before the reaper may act on it
     * (DRIVER_REAP_GRACE_MS) — the defer that keeps a fleet created a moment before its
     * attempt's verdict from being raced by the attempt's own teardown. Age only ever DEFERS an
     * action the board state already decided; it never decides one.
     */
    reapGraceMs: number;
    /**
     * How long a draining driver lets its in-flight runs finish before it hands them over
     * (DRIVER_HANDOVER_MS): each attempt still running is then reported to the board as
     * an interruption — refunded, claimable at once — and its runner is left alive for the next
     * claim, instead of the drain being SIGKILLed with the lease held. The default `0` hands over
     * inside the signal: a node reclaimed with two minutes' notice never outlives a longer wait.
     */
    handoverMs: number;
    /**
     * How long past its lease a released group waits for a newer holder to find and bind it
     * (DRIVER_REBIND_GRACE_MS); `takeoverBoundMs` is the lease plus this. The default suits a
     * driver replaced by a scheduler; the lanes shorten it so a waited-out takeover costs seconds.
     */
    rebindGraceMs: number;
    /**
     * The floor of a lost driver's group's orphan bound (DRIVER_ORPHAN_MIN_MS), above the long poll
     * (`stepWaitMs`) a live driver answers inside. The default is the production contract; a lane that
     * compresses the lease lowers it, and `loadDriverConfig` refuses a floor the lease cannot hold.
     */
    orphanMinMs: number;
    /** One `GET /step` long poll a supervisor makes (DRIVER_STEP_WAIT_MS); the orphan floor outlasts it. */
    stepWaitMs: number;
    /**
     * The runner classes (RUNNER_CLASSES, a JSON map by name) and the one a claim naming none runs
     * in (RUNNER_DEFAULT_CLASS). Each class carries its RuntimeClass, scheduling and resources
     * (`runner-classes.ts`); unset, one implicit class `default` with none of them — the BestEffort,
     * scheduler-placed pod. Resources are requests and limits, independent: limits stay off by
     * default, because a memory limit on an agent run turns a big build into an OOM kill mid-work.
     * Docker renders limits as `--cpus`/`--memory` and the memory request as `--memory-reservation`;
     * it has no cpu-request analogue, and refuses a class that sets anything but resources.
     */
    runnerClasses: RunnerClasses['runnerClasses'];
    defaultRunnerClass: string;
    /** The `dockerd` sidecar's image (RUNNER_DOCKER_IMAGE), digest-pinned; required once a class has `docker: true`. */
    runnerDockerImage: string | null;
    /** The daemons' registry mirrors (RUNNER_DOCKER_MIRRORS), each `https://`; empty pulls directly. */
    runnerDockerMirrors: string[];
}

/** The deployment image paired with one task-selected executor type. */
export function executorImage(config: DriverConfig, executorType: ExecutorType | null): string {
    if (executorType === null) throw new Error('the claimed task has no configured executor type');
    return config.executorImages[executorType];
}

/** One hour in milliseconds — the unit most of the bounds below are expressed in. */
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DAYS_PER_WEEK = 7;
const DAYS_PER_YEAR = 365;
/** Names the runner never takes from the driver's env: its GitHub token is the board's to mint and renew. */
const RUNNER_ENV_REFUSED = ['GITHUB_TOKEN', 'GH_TOKEN'];

/** RUNNER_ENV's names, refusing the ones a forwarded value would shadow the runner's own credential with. */
function runnerPassEnv(raw: string | undefined): string[] {
    const names = nameList(text(raw, 'RUNNER_ENV', DEFAULTS.passEnv));
    const refused = names.find((name) => RUNNER_ENV_REFUSED.includes(name));
    if (refused) throw new Error(`RUNNER_ENV must not name ${refused}: the runner's GitHub token comes from the board`);
    return names;
}

/** The upper bound on DRIVER_LEASE_SECONDS: one hour. */
const MAX_LEASE_SECONDS = 3600;
/** The lower bound on DRIVER_JOB_TIMEOUT_MS. */
const MIN_JOB_TIMEOUT_MS = 1_000;
/** The upper bound on DRIVER_CONCURRENCY. */
const MAX_CONCURRENCY = 32;
/** The lower bound on DRIVER_POLL_MS. */
const MIN_POLL_MS = 250;
/** The upper bound on DRIVER_POLL_MS. */
const MAX_POLL_MS = 300_000;
/** The default GATE_TIMEOUT_MS. */
const DEFAULT_GATE_TIMEOUT_MS = 600_000;
/** The lower bound on GATE_TIMEOUT_MS. */
const MIN_GATE_TIMEOUT_MS = 1_000;
/** The default RUNNER_CACHE_WATCH_POLL_MS. */
const DEFAULT_CACHE_WATCH_POLL_MS = 30_000;
/** The lower bound on RUNNER_CACHE_WATCH_POLL_MS. */
const MIN_CACHE_WATCH_POLL_MS = 250;
/** The upper bound on RUNNER_CACHE_WATCH_POLL_MS. */
const MAX_CACHE_WATCH_POLL_MS = 300_000;
/** The default DRIVER_REAP_INTERVAL_MS: one sweep every five minutes. */
const DEFAULT_REAP_INTERVAL_MS = 300_000;
/** The default DRIVER_REAP_GRACE_MS: ten minutes, comfortably longer than an attempt's own teardown. */
const DEFAULT_REAP_GRACE_MS = 600_000;
/** The default TASK_VOLUME_EXPORT_ATTEMPTS: three rounds, then the volume goes and the loss is logged. */
export const DEFAULT_TASK_VOLUME_EXPORT_ATTEMPTS = 3;
const MS_PER_MINUTE = 60_000;
const EXPORT_GIVE_UP_MIN_SPAN_MINUTES = 15;
/** The least time between a thread's first failed export and the delete that gives its transcript bytes up. */
export const EXPORT_GIVE_UP_MIN_SPAN_MS = EXPORT_GIVE_UP_MIN_SPAN_MINUTES * MS_PER_MINUTE;
/** The upper bound on TASK_VOLUME_EXPORT_ATTEMPTS. */
const MAX_TASK_VOLUME_EXPORT_ATTEMPTS = 100;
/** The default TASK_VOLUME_TTL_MS: a day of idleness after a whole thread's last finalize. */
const DEFAULT_TASK_VOLUME_TTL_MS = MS_PER_DAY;
/** The default TASK_VOLUME_BOUND_MS: a week, the bound on keeping a thread whose checkpoint is not whole. */
const DEFAULT_TASK_VOLUME_BOUND_MS = DAYS_PER_WEEK * MS_PER_DAY;
/** The longest TASK_VOLUME_TTL_MS / TASK_VOLUME_BOUND_MS the driver accepts: a year. */
const MAX_TASK_VOLUME_MS = DAYS_PER_YEAR * MS_PER_DAY;
/** The default DRIVER_HANDOVER_MS: at once, so the release lands well inside a spot node's two-minute notice. */
const DEFAULT_HANDOVER_MS = 0;

// An explicit enum, like the server's AUTH_MODE: a value this process does not know is fatal,
// never a fallback to docker — the first symptom of a fallback would be a driver that claims
// jobs and runs nothing, forever.
const EXECUTORS = ['docker', 'kubernetes'] as const;

// An explicit enum, like EXECUTOR: the API server would reject a bad policy only at job-create
// time, which is attempt-burning — the failure this whole loader exists to move to startup.
const PULL_POLICIES = ['Always', 'IfNotPresent', 'Never'] as const;

const DEFAULTS = {
    boardUrl: 'http://127.0.0.1:8080',
    claudeExecutorImage: 'claude-executor',
    opencodeExecutorImage: 'opencode-executor',
    taskVolumeAccessMode: 'ReadWriteOncePod',
    taskVolumeSize: '20Gi',
    cloneBase: 'https://github.com',
    concurrency: 2,
    pollMs: 5_000,
    leaseSeconds: 300,
    jobTimeoutMs: 2 * MS_PER_HOUR,
    otelEndpoint: 'http://collector:4318',
    passEnv: 'CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY',
} as const;

function int(raw: string | undefined, label: string, fallback: number, bounds: { min: number; max: number }): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
        throw new Error(`${label} must be an integer ${bounds.min}..${bounds.max}, got "${raw}"`);
    }
    return value;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const MAX_PORT = 65_535;

/** DRIVER_METRICS_PORT: unset serves no scrape; a port off loopback needs the board token to guard it. */
function metricsPortOf(env: NodeJS.ProcessEnv, host: string, token: string): number | null {
    const raw = (env.DRIVER_METRICS_PORT ?? '').trim();
    if (raw === '') return null;
    const port = int(raw, 'DRIVER_METRICS_PORT', 0, { min: 1, max: MAX_PORT });
    if (token === '' && !LOOPBACK_HOSTS.includes(host)) {
        throw new Error(
            `DRIVER_METRICS_PORT needs JOB_BOARD_TOKEN when GATE_LISTEN_HOST is "${host}": runners can reach the port and hold no token`
        );
    }
    return port;
}

function flag(raw: string | undefined, fallback = false): boolean {
    if (raw === undefined || raw === '') return fallback;
    return raw !== '0' && raw.toLowerCase() !== 'false';
}

function text(raw: string | undefined, label: string, fallback: string): string {
    const value = (raw ?? '').trim() || fallback;
    if (!value) throw new Error(`${label} must not be empty`);
    return value;
}

// The protocol is checked, not just the parse: `new URL('dashboard:8080')` succeeds with
// 'dashboard:' as the scheme, and the first symptom would be every claim failing against a
// value that reads perfectly well.
function assertHttpUrl(url: string, label: string): void {
    const scheme = (() => {
        try {
            return new URL(url).protocol;
        } catch {
            return null;
        }
    })();
    if (scheme !== 'http:' && scheme !== 'https:') {
        throw new Error(`${label} must be an http(s) URL, got "${url}"`);
    }
}

function resolveExecutor(env: NodeJS.ProcessEnv): (typeof EXECUTORS)[number] {
    const executorRaw = (env.EXECUTOR ?? '').trim() || 'docker';
    if (!EXECUTORS.includes(executorRaw as (typeof EXECUTORS)[number])) {
        throw new Error(`EXECUTOR must be one of ${EXECUTORS.join(', ')}, got "${executorRaw}"`);
    }
    return executorRaw as (typeof EXECUTORS)[number];
}

function resolvePullPolicy(env: NodeJS.ProcessEnv): (typeof PULL_POLICIES)[number] {
    const pullPolicyRaw = (env.RUNNER_IMAGE_PULL_POLICY ?? '').trim() || 'IfNotPresent';
    if (!PULL_POLICIES.includes(pullPolicyRaw as (typeof PULL_POLICIES)[number])) {
        throw new Error(`RUNNER_IMAGE_PULL_POLICY must be one of ${PULL_POLICIES.join(', ')}, got "${pullPolicyRaw}"`);
    }
    return pullPolicyRaw as (typeof PULL_POLICIES)[number];
}

// The cache watch is opencode's, so Claude Code tasks ignore it even when the same driver also
// serves OpenCode work. The probe reads the opencode session database, whose message rows
// record per-turn input and cache tokens; a claude-code transcript answers nothing. It stays
// docker-only: each tick is one throwaway container on an already-warm daemon, while the
// kubernetes equivalent would be a Job per tick — pod admission every poll period is a tax
// no watch is worth paying the cluster.
function assertCacheWatchSupported(cacheWatch: boolean, executor: (typeof EXECUTORS)[number]): void {
    if (cacheWatch && executor === 'kubernetes') {
        throw new Error(
            'RUNNER_CACHE_WATCH is not supported under EXECUTOR=kubernetes: each watch tick is one ' +
                'throwaway container on the docker daemon, and a Job per tick would put the cluster ' +
                'under pod-admission load no watch is worth. Run the cache watch on EXECUTOR=docker.'
        );
    }
}

/** A comma-separated list of names, trimmed, empties dropped. Unset is the empty list. */
function nameList(raw: string | undefined): string[] {
    return (raw ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
}

/** A trimmed value, or null when unset or blank. */
function optionalText(raw: string | undefined): string | null {
    return (raw ?? '').trim() || null;
}

/**
 * The orphan floor and the step long poll, checked against the lease: `orphanConfigFault` refuses a pair the lease
 * cannot hold, and the lease-wide check applies only where the production floor was lowered (the chart always sets the default).
 */
function loadOrphanBound(env: NodeJS.ProcessEnv, leaseSeconds: number): { orphanMinMs: number; stepWaitMs: number } {
    const orphanMinMs = int(env.DRIVER_ORPHAN_MIN_MS, 'DRIVER_ORPHAN_MIN_MS', SUPERVISOR_ORPHAN_MIN_MS, {
        min: 1_000,
        max: SUPERVISOR_ORPHAN_MAX_MS,
    });
    const stepWaitMs = int(env.DRIVER_STEP_WAIT_MS, 'DRIVER_STEP_WAIT_MS', SUPERVISOR_STEP_WAIT_MS, {
        min: 500,
        max: SUPERVISOR_ORPHAN_MAX_MS,
    });
    const fault = orphanConfigFault({ leaseSeconds, orphanMinMs, stepWaitMs }, orphanMinMs < SUPERVISOR_ORPHAN_MIN_MS);
    if (fault) throw new Error(fault);
    return { orphanMinMs, stepWaitMs };
}

export function loadDriverConfig(env: NodeJS.ProcessEnv): DriverConfig {
    const boardUrl = text(env.JOB_BOARD_URL, 'JOB_BOARD_URL', DEFAULTS.boardUrl).replace(/\/+$/, '');
    assertHttpUrl(boardUrl, 'JOB_BOARD_URL');

    // The branch reporter's endpoint, defaulted to the board itself — one URL, already checked
    // and already trailing-slash-stripped. An explicit RUNNER_STATS_URL is validated under its
    // own name (strip included, for the same reason: agents concatenate request paths onto this
    // string, and a double slash 404s into the reporter's silence), so a bad override is blamed
    // on the variable that caused it, not on the board URL it displaced.
    const statsUrl = ((env.RUNNER_STATS_URL ?? '').trim() || boardUrl).replace(/\/+$/, '');
    assertHttpUrl(statsUrl, 'RUNNER_STATS_URL');

    const leaseSeconds = int(env.DRIVER_LEASE_SECONDS, 'DRIVER_LEASE_SECONDS', DEFAULTS.leaseSeconds, {
        min: 10,
        max: MAX_LEASE_SECONDS,
    });
    const jobTimeoutMs = int(env.DRIVER_JOB_TIMEOUT_MS, 'DRIVER_JOB_TIMEOUT_MS', DEFAULTS.jobTimeoutMs, {
        min: MIN_JOB_TIMEOUT_MS,
        max: 24 * MS_PER_HOUR,
    });

    const executor = resolveExecutor(env);
    const runnerClasses = loadRunnerClasses(env, executor);

    // Auxiliary services run under both executors: containers in the supervisor's network
    // namespace there, sidecars of the task pod here. The RUNNER_SERVICES flag decides
    // whether they run at all, on either platform — ON by default: a checkout that declares no
    // `.bellows.yaml` services gets exactly the runner it always had (an empty readout names no
    // service), and `RUNNER_SERVICES=0` is the opt-out for an operator who wants the old
    // nothing-starts-unless-typed posture.

    const servicesEnabled = flag(env.RUNNER_SERVICES, true);
    const k8sNamespace = text(env.K8S_NAMESPACE, 'K8S_NAMESPACE', 'default');

    const pullPolicyRaw = resolvePullPolicy(env);

    const cacheWatch = flag(env.RUNNER_CACHE_WATCH);
    assertCacheWatchSupported(cacheWatch, executor);

    const network = (env.RUNNER_NETWORK ?? '').trim() || null;
    const boardToken = (env.JOB_BOARD_TOKEN ?? '').trim();
    const gateHost = text(env.GATE_LISTEN_HOST, 'GATE_LISTEN_HOST', '127.0.0.1');

    const { orphanMinMs, stepWaitMs } = loadOrphanBound(env, leaseSeconds);

    return {
        boardUrl,
        boardToken,
        worker: text(env.DRIVER_WORKER, 'DRIVER_WORKER', `driver-${process.pid}`),
        executorImages: {
            [CLAUDE_CODE]: text(env.CLAUDE_EXECUTOR_IMAGE, 'CLAUDE_EXECUTOR_IMAGE', DEFAULTS.claudeExecutorImage),
            [OPENCODE]: text(env.OPENCODE_EXECUTOR_IMAGE, 'OPENCODE_EXECUTOR_IMAGE', DEFAULTS.opencodeExecutorImage),
        },
        taskVolume: {
            storageClass: (env.TASK_VOLUME_STORAGE_CLASS ?? '').trim() || null,
            accessMode: text(env.TASK_VOLUME_ACCESS_MODE, 'TASK_VOLUME_ACCESS_MODE', DEFAULTS.taskVolumeAccessMode),
            size: text(env.TASK_VOLUME_SIZE, 'TASK_VOLUME_SIZE', DEFAULTS.taskVolumeSize),
        },
        cloneBase: text(env.REPO_CLONE_BASE, 'REPO_CLONE_BASE', DEFAULTS.cloneBase).replace(/\/+$/, ''),
        // Empty is unset, like every other optional value here: default to the collector on the
        // compose network, so the endpoint is always provided to the runner.
        otelEndpoint: (env.RUNNER_OTEL_ENDPOINT ?? '').trim() || DEFAULTS.otelEndpoint,
        statsUrl,
        network,
        concurrency: int(env.DRIVER_CONCURRENCY, 'DRIVER_CONCURRENCY', DEFAULTS.concurrency, {
            min: 1,
            max: MAX_CONCURRENCY,
        }),
        pollMs: int(env.DRIVER_POLL_MS, 'DRIVER_POLL_MS', DEFAULTS.pollMs, { min: MIN_POLL_MS, max: MAX_POLL_MS }),
        leaseSeconds,
        jobTimeoutMs,
        skipPermissions: flag(env.RUNNER_SKIP_PERMISSIONS),
        passEnv: runnerPassEnv(env.RUNNER_ENV),
        executor,
        k8sNamespace,
        // The Helm release this driver was installed by, when the chart set one. It labels every
        // runner Job `app.kubernetes.io/instance`, so an operator cleaning up one release
        // (`make stop`, `kubectl delete jobs -l ...instance=<name>`) cannot sweep another
        // release's runners sharing the namespace.
        k8sRelease: (env.K8S_RELEASE ?? '').trim() || null,
        credentialsSecret: (env.RUNNER_CREDENTIALS_SECRET ?? '').trim() || null,
        imagePullPolicy: pullPolicyRaw,
        imagePullSecrets: nameList(env.RUNNER_IMAGE_PULL_SECRETS),
        runnerDoNotDisrupt: flag(env.RUNNER_DO_NOT_DISRUPT),
        gateListenHost: gateHost,
        metricsPort: metricsPortOf(env, gateHost, boardToken),
        gateAdvertiseUrl: (env.GATE_ADVERTISE_URL ?? '').trim() || null,
        heartbeatFile: optionalText(env.DRIVER_HEARTBEAT_FILE),
        gateTimeoutMs: int(env.GATE_TIMEOUT_MS, 'GATE_TIMEOUT_MS', DEFAULT_GATE_TIMEOUT_MS, {
            min: MIN_GATE_TIMEOUT_MS,
            max: 24 * MS_PER_HOUR,
        }),
        servicesEnabled,
        cacheWatch,
        cacheWatchPollMs: int(
            env.RUNNER_CACHE_WATCH_POLL_MS,
            'RUNNER_CACHE_WATCH_POLL_MS',
            DEFAULT_CACHE_WATCH_POLL_MS,
            { min: MIN_CACHE_WATCH_POLL_MS, max: MAX_CACHE_WATCH_POLL_MS }
        ),
        taskVolumeTtlMs: int(env.TASK_VOLUME_TTL_MS, 'TASK_VOLUME_TTL_MS', DEFAULT_TASK_VOLUME_TTL_MS, {
            min: 0,
            max: MAX_TASK_VOLUME_MS,
        }),
        taskVolumeBoundMs: int(env.TASK_VOLUME_BOUND_MS, 'TASK_VOLUME_BOUND_MS', DEFAULT_TASK_VOLUME_BOUND_MS, {
            min: 0,
            max: MAX_TASK_VOLUME_MS,
        }),
        taskVolumeExportAttempts: int(
            env.TASK_VOLUME_EXPORT_ATTEMPTS,
            'TASK_VOLUME_EXPORT_ATTEMPTS',
            DEFAULT_TASK_VOLUME_EXPORT_ATTEMPTS,
            { min: 1, max: MAX_TASK_VOLUME_EXPORT_ATTEMPTS }
        ),
        reapIntervalMs: int(env.DRIVER_REAP_INTERVAL_MS, 'DRIVER_REAP_INTERVAL_MS', DEFAULT_REAP_INTERVAL_MS, {
            min: 0,
            max: 24 * MS_PER_HOUR,
        }),
        reapGraceMs: int(env.DRIVER_REAP_GRACE_MS, 'DRIVER_REAP_GRACE_MS', DEFAULT_REAP_GRACE_MS, {
            min: 0,
            max: 24 * MS_PER_HOUR,
        }),
        handoverMs: int(env.DRIVER_HANDOVER_MS, 'DRIVER_HANDOVER_MS', DEFAULT_HANDOVER_MS, {
            min: 0,
            max: 24 * MS_PER_HOUR,
        }),
        rebindGraceMs: int(env.DRIVER_REBIND_GRACE_MS, 'DRIVER_REBIND_GRACE_MS', SUPERVISOR_REBIND_GRACE_MS, {
            min: 1_000,
            max: 24 * MS_PER_HOUR,
        }),
        orphanMinMs,
        stepWaitMs,
        // Validated here, stored verbatim: the pod specs render the quantities as-is, and the
        // docker flags take them translated (quantities.ts). A
        // request above its limit is refused by the apiserver only per attempt, so each pair is
        // checked here instead (see assertRequestWithinLimit).
        ...runnerClasses,
    };
}

/**
 * The URL handed to a runner as `BELLOWS_GATE_URL`. Null keeps the host-gateway default. A
 * configured URL with no port has the bound one appended — the listener binds an ephemeral port
 * (`listen(0)`), so no fixed URL could name it in advance; a URL that already carries a port is
 * the operator's word and stays verbatim. Trailing slashes are stripped, because agents build
 * request paths by string concatenation and `…:44685//run` must not happen. An unparseable URL
 * is passed through untouched: the run reaches the same dead string it would have before, and
 * the failure stays at the fetch rather than gaining a second, config-shaped explanation.
 */
export function gateAdvertiseUrlFor(advertiseUrl: string | null, port: number): string {
    if (!advertiseUrl) return `http://host.docker.internal:${port}`;
    try {
        const url = new URL(advertiseUrl);
        if (url.port) return advertiseUrl;
        url.port = String(port);
        return url.toString().replace(/\/+$/, '');
    } catch {
        return advertiseUrl;
    }
}
