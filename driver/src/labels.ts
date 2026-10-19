/**
 * The labels every runner-owned object carries — docker containers, networks and volumes, and
 * kubernetes pods, jobs, services and secrets alike. Orphan sweeps and re-claims find a job's
 * leftovers by them, so both executors must spell them identically.
 */
export const JOB_LABEL = 'factory.job';
export const LEASE_LABEL = 'factory.lease';
export const SERVICE_LABEL = 'factory.service';
/**
 * The claim sequence and session a runner ran under (issue #792) — a kubernetes runner Job's
 * annotations, a docker runner container's labels — so the claim that supersedes a dead driver
 * can adopt the newest finished runner and report its session.
 */
export const CLAIM_SEQ_MARK = 'factory.claim-seq';
export const SESSION_MARK = 'factory.session';
/** The run's command, hashed (`commandMark`): a queued task's command edited since is not adopted. */
export const COMMAND_MARK = 'factory.command';
/**
 * Kubernetes only: the checkout claim's holder a reclaim group serves, on its Job and its pod
 * template. The group's own lease token is random per invocation, so its names are never reused;
 * this label is how a retry, an orphaned claim's reap and the reaper find what that holder left.
 */
export const HOLDER_LABEL = 'factory.holder';
/**
 * Kubernetes only: the annotation an orphaned-claim reap puts on the checkout claim before it lists
 * the holder's groups (issue #821), its value the reaping acquisition's token. A reclaim refuses to
 * start a group under a revoked claim.
 */
export const REVOKED_MARK = 'factory.revoked';
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
 * Docker only: a terminal reclaim's supervisor-only group (`dockerReclaimWorktree`), on its
 * containers and mailboxes. Its lease is a token of its own the board never heard of, so the
 * orphan reaper — which would read it as a dead attempt's — leaves every object carrying this alone.
 */
export const RECLAIM_LABEL = 'factory.reclaim';
