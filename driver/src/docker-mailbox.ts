import type { BoardJob } from './board.js';
import { UUID } from './claim.js';
import { ROLE_LABEL } from './labels.js';
import { AGENT_CONTAINER, type Mailbox, MAILBOXES } from './supervisor-contract.js';
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

/** The marker volume one reason the driver ended the attempt for is recorded on (`termination.ts`), attempt-scoped by name. */
export const killMarkName = (job: BoardJob, reason: string): string => `factory-kill-${reason}-${idsOf(job)}`;

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
export const agentRoleArgs = (): string[] => ['--label', `${ROLE_LABEL}=${AGENT_CONTAINER}`];
