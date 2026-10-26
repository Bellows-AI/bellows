/**
 * The labels every runner-owned object carries — docker containers, networks and volumes, and
 * kubernetes pods, jobs, services and secrets alike. Orphan sweeps and re-claims find a job's
 * leftovers by them, so both executors must spell them identically.
 */
export const JOB_LABEL = 'factory.job';
export const LEASE_LABEL = 'factory.lease';
export const SERVICE_LABEL = 'factory.service';
/**
 * Docker only: the board a group object was made for (`boardIdentity`), stable across restarts of the
 * same driver. The docker reaper scans and removes only objects carrying its own, so two boards on one
 * daemon never reap each other's groups; the kubernetes reaper is scoped by `K8S_RELEASE` instead.
 */
export const BOARD_LABEL = 'factory.board';
/**
 * The claim sequence and session a runner ran under (issue #792) — a kubernetes runner Job's
 * annotations, a docker runner container's labels — so the claim that supersedes a dead driver
 * can adopt the newest finished runner and report its session.
 */
export const CLAIM_SEQ_MARK = 'factory.claim-seq';
export const SESSION_MARK = 'factory.session';
/** The run's command, hashed (`commandMark`): a queued task's command edited since is not adopted. */
export const COMMAND_MARK = 'factory.command';
/** A claim sequence as a mark spells it: digits that survive `Number` (an empty one is 0, a long run Infinity). */
export const isSeq = (value: unknown): value is string =>
    typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
/** A `commandMark`: sixteen lowercase hex digits. */
export const isCommandMark = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
/**
 * Kubernetes only: the checkout claim's holder a group serves, on its Job and its pod template.
 * The reaper finds what a holder left by it.
 */
export const HOLDER_LABEL = 'factory.holder';
/**
 * Why the driver ended a run itself (`termination.ts`), one mark per reason, its detail the value:
 * on a kubernetes runner Job's annotations, a docker kill marker volume's labels.
 */
export const KILL_MARK_PREFIX = 'factory.kill.';
/**
 * Docker only: which container of a run's group this is — `agent`, `supervisor` or `exporter`
 * (`supervisor-contract.ts`). The group's containers share the job and lease labels; this one tells
 * a kill of the agent from the teardown of the whole group.
 */
export const ROLE_LABEL = 'factory.role';
/**
 * A volume export's workload (issue #938), a docker container or a kubernetes pod: the thread root whose task
 * volume it drains. It carries neither the job-and-lease pair nor the role label, so no group scan meets it.
 */
export const VOLUME_EXPORT_LABEL = 'factory.volume-export';
