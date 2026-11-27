import type { JobIntegrationRequirement } from '../api/useJobs.js';
import { changeRequestLabelOfForge } from '../task-outcome.js';

const REMOVED_SENTENCE = 'This task has not started: its starter was removed. An owner or admin can stop or remove it.';

/**
 * What a grant wait says. A `runtime` wait is a task that already ran and was handed back: paused, and it keeps its
 * session and checkout; a `create` wait never started.
 */
function waitSentence({ label, reason, source }: JobIntegrationRequirement): string {
    const need =
        reason === 'reconnect' ? `its ${label} connection needs to be reconnected` : `it needs a ${label} connection`;
    return source === 'runtime'
        ? `This task is paused: ${need}. It picks up where it left off once that is done.`
        : `This task has not started: ${need}.`;
}

/**
 * The forge start gate's wait on the task page (docs/connections.md): a queued continuation whose starter holds no
 * live grant for the repo's forge. It is the starter's to clear — by signing in again, the link the board built — and
 * nobody can decline it, so there is no picker and no way past it. Anyone else reads who it waits for; a task whose
 * starter was removed waits for an owner or admin to stop or remove it. `forge-access` is the other kind: the task ran and
 * its pull request waits because the starter's own GitHub account cannot write to the repository. Reconnecting does not
 * clear it and the board retries by itself, so it offers no link; it ends when the access is fixed or the task is stopped.
 * A `runtime` wait (a GitLab grant lost while the task ran) says it is paused: the re-link resumes its session and checkout.
 */
export function TaskForgeWait({
    requirement,
    owner,
    canAct,
}: {
    requirement: JobIntegrationRequirement;
    /** The starter's name, else null. */
    owner: string | null;
    canAct: boolean;
}) {
    const { label, reason, connectPath, target } = requirement;
    const noun = changeRequestLabelOfForge(target).name.toLowerCase();
    const removed = reason === 'starter-removed';
    if (reason === 'forge-access') {
        return (
            <section className="question" aria-label={`${label} connection needed`}>
                <p>
                    <span className="pill question-chip">{label}</span> The {noun} is waiting: the member who started
                    this task needs write access to the repository on {label}. It retries on its own.
                </p>
                {canAct ? null : (
                    <p className="question-status" aria-live="polite">
                        Waiting for {owner ?? 'the starter'} to get write access
                    </p>
                )}
            </section>
        );
    }
    return (
        <section className="question" aria-label={`${label} connection needed`}>
            <p>
                <span className="pill question-chip">{label}</span>{' '}
                {removed ? REMOVED_SENTENCE : waitSentence(requirement)}
            </p>
            {!removed && canAct && connectPath !== null ? (
                <div className="connect-actions">
                    <a href={connectPath}>
                        {reason === 'reconnect' ? 'Reconnect' : 'Connect'} {label}
                    </a>
                </div>
            ) : null}
            {!removed && !canAct ? (
                <p className="question-status" aria-live="polite">
                    Waiting for {owner ?? 'the starter'} to reconnect {label}
                </p>
            ) : null}
        </section>
    );
}
