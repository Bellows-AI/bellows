import type { BoardJob } from './board.js';
import { UUID } from './claim.js';
import { BOARD_LABEL, ROLE_LABEL } from './labels.js';
import { AGENT_CONTAINER, type Mailbox, MAILBOXES, SUPERVISOR_BINDING } from './supervisor-contract.js';
import { agentMailboxEnv } from './supervisor-plan.js';

/**
 * The docker spelling of the supervisor's mailboxes (`supervisor-contract.ts`): one named volume per
 * mailbox, attempt-scoped by name, mounted by exactly the containers the contract names. A leaf
 * module — `docker.ts` (the agent's argv) and `docker-group.ts` (the supervisor's and the
 * exporter's) both build on it, and neither can import the other.
 */

export const idsOf = (job: BoardJob): string => {
    if (!UUID.test(job.id) || !UUID.test(job.leaseToken)) {
        throw new Error(`refusing to name a container group for job ${job.id}: ids that are not uuids`);
    }
    return `${job.id}-${job.leaseToken}`;
};

/** The group's task supervisor container: the holder of the group's network namespace (issue #773). */
export const supervisorName = (job: BoardJob): string => `factory-supervisor-${idsOf(job)}`;

/**
 * How every container of the group but its supervisor joins the network (issue #773): the
 * supervisor's own namespace, as a pod's containers share one — its RUNNER_NETWORK, and its hosts
 * file, which names the driver and every declared service on loopback.
 */
export const groupNetworkArgs = (job: BoardJob): string[] => ['--network', `container:${supervisorName(job)}`];

/** The marker volume one reason the driver ended the attempt for is recorded on (`termination.ts`), attempt-scoped by name. */
export const killMarkName = (job: BoardJob, reason: string): string => `factory-kill-${reason}-${idsOf(job)}`;

/** The supervisor-only binding volume (#829), attempt-scoped by name like the mailboxes. */
export const bindingVolumeName = (job: BoardJob): string => `factory-${SUPERVISOR_BINDING.volume}-${idsOf(job)}`;

/** One mailbox's volume, attempt-scoped by name like every container: a sibling attempt's can never be this one's. */
export const ctlVolumeName = (job: BoardJob, box: Mailbox): string => `factory-${box.name}-${idsOf(job)}`;

/** One mailbox as a `--mount`, read-only where the contract says the container may only read it. */
export const mailboxMountArgs = (job: BoardJob, box: Mailbox, access: 'ro' | 'rw'): string[] => [
    '--mount',
    `type=volume,src=${ctlVolumeName(job, box)},target=${box.path}${access === 'ro' ? ',readonly' : ''}`,
];

/** What the AGENT's `docker create` adds: its two mailboxes and the paths that name them — nothing more of the group. */
export const agentMailboxArgs = (job: BoardJob): string[] => [
    ...mailboxMountArgs(job, MAILBOXES.in, 'ro'),
    ...mailboxMountArgs(job, MAILBOXES.out, 'rw'),
    ...agentMailboxEnv().flatMap(([name, value]) => ['-e', `${name}=${value}`]),
];

/** The role label the agent container carries beside the job and lease pair. */
/** The board the group object is made for (`boardIdentity`): what the docker reaper scopes its scan and removals by. */
export const boardLabelArgs = (board: string): string[] => ['--label', `${BOARD_LABEL}=${board}`];
export const agentRoleArgs = (): string[] => ['--label', `${ROLE_LABEL}=${AGENT_CONTAINER}`];
