/**
 * What the driver and the containers of a run's pod (docker: its container group) agree on about the
 * task supervisor (`scripts/supervisor.cjs`): where each mailbox is mounted, who mounts it, the
 * names of the files that cross it, and the supervisor's exit statuses. The scripts and the agent
 * images spell the same literals — they cannot import this module — and `driver/test/supervisor.test.ts`
 * pins the two to each other.
 *
 * The control between the supervisor and another container is a directory only those two mount.
 * Nothing the agent container can reach holds the supervisor's credential or its private state.
 */

/** The mailbox root every container of the run mounts its own directories under. */
export const CTL_ROOT = '/factory';

/** One mailbox: its container path, and which containers mount it and how. */
export interface Mailbox {
    /** The volume name (pod) and the volume-name suffix (docker). */
    name: string;
    path: string;
    supervisor: 'rw';
    agent: 'ro' | 'rw' | null;
    exporter: 'rw' | null;
    gate: 'rw' | null;
    reviewer: 'rw' | null;
}

/** `in`: supervisor to agent. The agent reads it and cannot write it, so it cannot forge a Stop or an answer. */
const IN: Mailbox = {
    name: 'ctl-in',
    path: `${CTL_ROOT}/in`,
    supervisor: 'rw',
    agent: 'ro',
    exporter: null,
    gate: null,
    reviewer: null,
};
/** `out`: agent to supervisor — its questions and its heartbeat; the one directory the agent writes. */
const OUT: Mailbox = {
    name: 'ctl-out',
    path: `${CTL_ROOT}/out`,
    supervisor: 'rw',
    agent: 'rw',
    exporter: null,
    gate: null,
    reviewer: null,
};
/** `export`: supervisor to exporter. The agent mounts nothing of it. */
const EXPORT: Mailbox = {
    name: 'ctl-export',
    path: `${CTL_ROOT}/export`,
    supervisor: 'rw',
    agent: null,
    exporter: 'rw',
    gate: null,
    reviewer: null,
};
/** The supervisor's own state: no other container mounts it. */
const OWN: Mailbox = {
    name: 'ctl-supervisor',
    path: `${CTL_ROOT}/supervisor`,
    supervisor: 'rw',
    agent: null,
    exporter: null,
    gate: null,
    reviewer: null,
};
/** `gate`: supervisor to gate container — the gate requests and their answers (`GATE_FILES`). The agent mounts nothing of it. */
const GATE: Mailbox = {
    name: 'ctl-gate',
    path: `${CTL_ROOT}/gate`,
    supervisor: 'rw',
    agent: null,
    exporter: null,
    gate: 'rw',
    reviewer: null,
};

/** `review`: supervisor to reviewer container (issue #774) — the review requests and their answers (`REVIEW_FILES`). Nothing else mounts it. */
const REVIEW: Mailbox = {
    name: 'ctl-review',
    path: `${CTL_ROOT}/review`,
    supervisor: 'rw',
    agent: null,
    exporter: null,
    gate: null,
    reviewer: 'rw',
};

export const MAILBOXES = { in: IN, out: OUT, export: EXPORT, supervisor: OWN, gate: GATE, review: REVIEW } as const;

/**
 * The gate mailbox's layout (`GATE_FILES` of supervisor.cjs, the names `scripts/gate-loop.sh` spells):
 * the supervisor stages a request (`command`, `cwd`, `env`) and renames it into `requests/<step id>`;
 * the gate loop claims it by renaming it to `running/<id>`, and answers by writing `output` and,
 * atomically, `exit`, then renaming it to `done/<id>`. `cancel` inside a running request is the
 * supervisor's order to kill it; `alive` is the loop's heartbeat.
 */
export const GATE_FILES = {
    staging: 'staging',
    requests: 'requests',
    running: 'running',
    done: 'done',
    alive: 'alive',
    command: 'command',
    cwd: 'cwd',
    env: 'env',
    output: 'output',
    exit: 'exit',
    cancel: 'cancel',
} as const;
/** The review mailbox's layout is the gate mailbox's (`scripts/review-loop.sh` spells the same names). */
export const REVIEW_FILES = GATE_FILES;
/** How long a cancelled or timed-out gate may take to answer before the supervisor answers for it. */
export const GATE_CANCEL_GRACE_MS = 10_000;
/** A gate loop whose heartbeat is older than this is lost: its request never ran, or its answer is gone. */
export const GATE_LOST_MS = 30_000;

/**
 * The kubernetes restart of the declared services (issue #773): a generation file per service under
 * `path`, the supervisor's to write (`scripts/service-generation-bump.sh`, run as a `restart` step)
 * and every service sidecar's to read, and one acknowledgement directory per service, which its
 * sidecar mounts at `ackPath` and the supervisor reads under `ackRoot/<name>`. The sidecar's liveness
 * probe (`scripts/service-generation-probe.sh`) fails once the generation moves past the one its
 * writable layer recorded, so the kubelet restarts it; the restarted one acknowledges the new one.
 */
export const SERVICE_GENERATIONS = {
    volume: 'ctl-services',
    path: `${CTL_ROOT}/services`,
    ackRoot: `${CTL_ROOT}/service-acks`,
    ackPath: `${CTL_ROOT}/service-ack`,
} as const;
/** A service's acknowledgement volume: its own, so no sidecar can speak for another. */
export const serviceAckVolume = (name: string): string => `svc-ack-${name}`;
/** What the bump answers while a service has not acknowledged its current generation: nothing was bumped. */
export const SERVICE_NOT_ACKED_EXIT = 3;
/** The sidecar container a declared service runs as in the task pod: the reserved `svc-` prefix and its name. */
export const serviceContainerOf = (name: string): string => `svc-${name}`;

/** The file names that cross the mailboxes; `FILES` of supervisor.cjs. */
export const MAILBOX_FILES = {
    stop: 'stop',
    kill: 'kill',
    answers: 'answers',
    questions: 'questions',
    agentAlive: 'agent.alive',
    agentExit: 'agent.exit',
    supervisorAlive: 'supervisor.alive',
    drain: 'drain.json',
    exportStatus: 'status.json',
    state: 'state.json',
    go: 'go',
    steps: 'steps',
    report: 'report.json',
} as const;

/**
 * The agent's own directory inside `in` and `out`, which the supervisor creates owner-only (`AGENT_DIR`
 * of supervisor.cjs). The agent container mounts both mailboxes whole, and its tools run as their own
 * uid (issue #814): they can neither read what the agent is told nor forge what it says.
 */
export const AGENT_MAILBOX_DIR = 'agent';
/** The agent's side of `in` (`FACTORY_CTL_IN`) and of `out` (`FACTORY_CTL_OUT`). */
export const AGENT_IN = `${MAILBOXES.in.path}/${AGENT_MAILBOX_DIR}`;
export const AGENT_OUT = `${MAILBOXES.out.path}/${AGENT_MAILBOX_DIR}`;

/**
 * The marker the supervisor writes in the agent's read-only mailbox when the driver releases the
 * agent: the group exists from the attempt's first step (the sync), and the agent's entrypoint waits
 * on this file (`FACTORY_CTL_GO`) so it never starts before its tree does.
 */
export const GO_MARKER = `${AGENT_IN}/${MAILBOX_FILES.go}`;

/** How often the supervisor reads the driver's run-control endpoint, and so the pace a Stop reaches the agent at. */
export const RUN_CONTROL_POLL_MS = 5_000;
/** How long the exporter may take to drain and close its manifests once the agent is gone. */
export const SUPERVISOR_DRAIN_MS = 300_000;
/**
 * A minute for the supervisor to report once the drain is over: how long a supervisor that ends the
 * attempt itself redelivers its departure before it finalizes unacknowledged; `REPORT_MS` of supervisor.cjs.
 */
export const SUPERVISOR_REPORT_MS = 60_000;
/**
 * What the kubelet's (or docker's) backstop deadline allows on top of the run budget: the drain and
 * a minute to report. The supervisor ends the agent at the budget itself; the backstop only ends a
 * supervisor that stopped doing so.
 */
export const SUPERVISOR_WINDDOWN_MS = SUPERVISOR_DRAIN_MS + SUPERVISOR_REPORT_MS;
/** How long a Stop's kill order may take to wind the group down before the driver deletes it outright. */
export const KILL_WINDDOWN_MS = SUPERVISOR_WINDDOWN_MS;

/**
 * The supervised steps: the commands the driver has the supervisor run for an attempt — the
 * startup sync, the terminal reclaim, the tree probe, the review snapshot, the publish steps and
 * the allowlisted helpers — the declared gates and setup, the declared services' generation reads
 * and bumps (`restart`, kubernetes), and the two orders that govern the group itself. Each is a
 * request the supervisor pulls from the driver's control endpoint (`GET /step`, long-poll) and
 * answers (`POST /step/:id`); the agent container holds neither route. A step is a
 * request, never a container or Job of its own: it runs in the supervisor, in the executor image,
 * over the task volume the supervisor mounts — but a `gate`, which the supervisor hands to the gate
 * container through the gate mailbox, and serves beside the other steps rather than before them.
 */
export const STEP_KINDS = [
    'sync',
    'reclaim',
    'probe',
    'snapshot',
    'publish',
    'helper',
    'gate',
    'review',
    'restart',
    'go',
    'finish',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * One supervised step as the driver sends it. `id` is the logical effect (a publish's push is the
 * same `id` however often it is asked); `invocation` is one call of it. A redelivery of a call keeps
 * its invocation and is answered from the supervisor's ledger, never run twice; a new call — a
 * deliberate retry after the caller reconciled — is a new invocation and runs, unless the effect
 * already landed.
 */
export interface StepRequest {
    id: string;
    invocation: string;
    kind: StepKind;
    /** The executable and its arguments; empty for `go` and `finish`, the declared command alone for `gate`. */
    argv: string[];
    cwd?: string;
    /** The step's own environment: literals, and — only for a step that needs it — the claim env or publish token. */
    env: Record<string, string>;
    timeoutMs: number;
}

/** What the supervisor answers a step with. `replayed` marks an answer read back from its ledger. */
export interface StepResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    replayed?: boolean;
}

/**
 * The supervisor's report once the agent is over and the exporter drained, redelivered under its
 * `id` until the driver acknowledges it. `serving` says whether the group still serves steps until
 * `finish`; it only ever turns false — the supervisor ended the attempt itself and leaves — and the
 * driver then refuses every step still waiting on the group.
 */
export interface SupervisorReport {
    id: string;
    outcome: string | null;
    cause: string | null;
    agentExit: number | null;
    agentEnd: string;
    drained: boolean;
    serving: boolean;
}

/** The line the supervisor logs its final report on, last thing before it exits; `REPORT_PREFIX` of supervisor.cjs. */
export const SUPERVISOR_REPORT_PREFIX = 'FACTORY_SUPERVISOR_REPORT ';

/** The final report as the supervisor logged it: what a claim adopting its group reads back (issue #824). */
export type FinalReport = Pick<SupervisorReport, 'outcome' | 'cause' | 'agentExit' | 'agentEnd' | 'drained'>;

/** The last final report in a supervisor's log; null when it logged none, or none that parses. */
export function finalReportOf(log: string): FinalReport | null {
    const line = log
        .split('\n')
        .reverse()
        .find((l) => l.startsWith(SUPERVISOR_REPORT_PREFIX));
    if (!line) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(line.slice(SUPERVISOR_REPORT_PREFIX.length));
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { outcome, cause, agentExit, agentEnd, drained } = parsed as Record<string, unknown>;
    if (typeof agentEnd !== 'string' || typeof drained !== 'boolean') return null;
    return {
        outcome: typeof outcome === 'string' ? outcome : null,
        cause: typeof cause === 'string' ? cause : null,
        agentExit: typeof agentExit === 'number' ? agentExit : null,
        agentEnd,
        drained,
    };
}

/** The routes a supervisor reaches the driver's control endpoint by, beside `GET /control`. */
export const STEP_PATH = '/step';
export const REPORT_PATH = '/report';

/**
 * How long past its own timeout the driver waits for a step's answer before it counts the answer
 * lost (`StepTimedOut`): the supervisor kills a step at its timeout, so only a lost answer or a
 * step still queued behind others outlasts this.
 */
export const STEP_ANSWER_GRACE_MS = 30_000;
/** The most stdout/stderr (each) a step result carries; the tail is kept. */
export const STEP_OUTPUT_LIMIT_BYTES = 1_048_576;
/**
 * How long a supervisor whose driver does not answer keeps serving before it finalizes, and how long
 * a draining exporter tolerates that driver: a driver that died leaves its group to end by itself,
 * inside its lease, so the next claim adopts what the agent finished instead of sweeping it. The
 * bound is a share of the lease (`orphanBoundMs`), floored above one `GET /step` long poll and its
 * timeout so a live driver always answers inside it.
 */
export const SUPERVISOR_ORPHAN_LEASE_SHARE = 4;
export const SUPERVISOR_ORPHAN_MIN_MS = 30_000;
export const SUPERVISOR_ORPHAN_MAX_MS = 90_000;
/**
 * What the kubelet's (or docker's) backstop allows on top of the run budget for the steps a task
 * group serves before and after its agent — the sync, the gates, the helpers, the publish. The
 * driver ends the group itself well before; this only bounds a group the driver forgot.
 */
export const SUPERVISOR_STEPS_MS = 7_200_000;

/**
 * The supervisor's exit statuses; `EXIT` of supervisor.cjs. 124 echoes `timeout(1)`, as the gates' deadline does.
 * 75 (`EX_TEMPFAIL`) is a group whose driver was lost before it released the agent: the Job must not
 * complete, or the next claim would adopt a run that never happened as a finished one.
 */
export const SUPERVISOR_EXIT = { finalized: 0, deadline: 124, failed: 70, lost: 75 } as const;
/** Why a group whose supervisor exited `SUPERVISOR_EXIT.lost` is an interruption, in both executors' words. */
export const DRIVER_LOST_LOSS = 'the task supervisor lost its driver before the agent was released';

/**
 * The supervisor's environment names. Only the supervisor container carries the control pair; the
 * transcript exporter's own token (`exportToken`) rides into the exporter alone.
 */
export const SUPERVISOR_ENV = {
    controlUrl: 'SUPERVISOR_CONTROL_URL',
    controlToken: 'SUPERVISOR_CONTROL_TOKEN',
    exportToken: 'SUPERVISOR_EXPORT_TOKEN',
    controlMs: 'SUPERVISOR_CONTROL_MS',
    deadlineMs: 'SUPERVISOR_DEADLINE_MS',
    drainMs: 'SUPERVISOR_DRAIN_MS',
    orphanMs: 'SUPERVISOR_ORPHAN_MS',
    exports: 'SUPERVISOR_EXPORTS',
    agentless: 'SUPERVISOR_AGENTLESS',
    gate: 'SUPERVISOR_GATE',
    reviewer: 'SUPERVISOR_REVIEWER',
} as const;

/** The names that carry the supervisor's and the exporter's credentials: the agent container never receives one. */
export const SUPERVISOR_CREDENTIAL_NAMES: readonly string[] = [
    SUPERVISOR_ENV.controlUrl,
    SUPERVISOR_ENV.controlToken,
    SUPERVISOR_ENV.exportToken,
];

/** The container names of a run's pod, and the docker group's name suffixes. */
export const SUPERVISOR_CONTAINER = 'supervisor';
export const AGENT_CONTAINER = 'agent';
export const EXPORTER_CONTAINER = 'exporter';
/** The declared gate image's container, beside the supervisor in a group whose checkout declares gates or setup. */
export const GATE_CONTAINER = 'gate';
/** The reviewer container, beside the supervisor in a group whose claim lists reviewer profiles (issue #774). */
export const REVIEWER_CONTAINER = 'reviewer';

/** The mailboxes a group holds: the review mailbox only where a reviewer container is (issue #774), on both executors. */
export const mailboxesOf = (reviewing: boolean): Mailbox[] =>
    Object.values(MAILBOXES).filter((box) => reviewing || box !== MAILBOXES.review);
