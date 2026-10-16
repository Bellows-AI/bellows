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
}

/** `in`: supervisor to agent. The agent reads it and cannot write it, so it cannot forge a Stop or an answer. */
const IN: Mailbox = { name: 'ctl-in', path: `${CTL_ROOT}/in`, supervisor: 'rw', agent: 'ro', exporter: null };
/** `out`: agent to supervisor — its questions and its heartbeat; the one directory the agent writes. */
const OUT: Mailbox = { name: 'ctl-out', path: `${CTL_ROOT}/out`, supervisor: 'rw', agent: 'rw', exporter: null };
/** `export`: supervisor to exporter. The agent mounts nothing of it. */
const EXPORT: Mailbox = {
    name: 'ctl-export',
    path: `${CTL_ROOT}/export`,
    supervisor: 'rw',
    agent: null,
    exporter: 'rw',
};
/** The supervisor's own state: no other container mounts it. */
const OWN: Mailbox = {
    name: 'ctl-supervisor',
    path: `${CTL_ROOT}/supervisor`,
    supervisor: 'rw',
    agent: null,
    exporter: null,
};

export const MAILBOXES = { in: IN, out: OUT, export: EXPORT, supervisor: OWN } as const;

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
} as const;

/** The marker file the baked Stop hook and plugin read: the supervisor's `stop`, in the agent's read-only mailbox. */
export const STOP_MARKER = `${MAILBOXES.in.path}/${MAILBOX_FILES.stop}`;

/** How often the supervisor reads the driver's run-control endpoint, and so the pace a Stop reaches the agent at. */
export const RUN_CONTROL_POLL_MS = 5_000;
/** How long the exporter may take to drain and close its manifests once the agent is gone. */
export const SUPERVISOR_DRAIN_MS = 300_000;
/** A minute for the supervisor to report once the drain is over. */
const REPORT_GRACE_MS = 60_000;
/**
 * What the kubelet's (or docker's) backstop deadline allows on top of the run budget: the drain and
 * a minute to report. The supervisor ends the agent at the budget itself; the backstop only ends a
 * supervisor that stopped doing so.
 */
export const SUPERVISOR_WINDDOWN_MS = SUPERVISOR_DRAIN_MS + REPORT_GRACE_MS;
/** How long a Stop's kill order may take to wind the group down before the driver deletes it outright. */
export const KILL_WINDDOWN_MS = SUPERVISOR_WINDDOWN_MS;

/** The supervisor's exit statuses; `EXIT` of supervisor.cjs. 124 echoes `timeout(1)`, as the gates' deadline does. */
export const SUPERVISOR_EXIT = { finalized: 0, deadline: 124, failed: 70 } as const;

/** The supervisor's environment names. Only the supervisor container carries the control pair. */
export const SUPERVISOR_ENV = {
    controlUrl: 'SUPERVISOR_CONTROL_URL',
    controlToken: 'SUPERVISOR_CONTROL_TOKEN',
    controlMs: 'SUPERVISOR_CONTROL_MS',
    deadlineMs: 'SUPERVISOR_DEADLINE_MS',
    drainMs: 'SUPERVISOR_DRAIN_MS',
    exports: 'SUPERVISOR_EXPORTS',
} as const;

/** The two names that carry the supervisor's credential: the agent container never receives either. */
export const SUPERVISOR_CREDENTIAL_NAMES: readonly string[] = [SUPERVISOR_ENV.controlUrl, SUPERVISOR_ENV.controlToken];

/** The container names of a run's pod, and the docker group's name suffixes. */
export const SUPERVISOR_CONTAINER = 'supervisor';
export const AGENT_CONTAINER = 'agent';
export const EXPORTER_CONTAINER = 'exporter';
