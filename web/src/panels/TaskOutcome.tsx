import type { ReactNode } from 'react';
import type { Job } from '../api/useJobs.js';
import { Icon } from '../components/Icon.js';
import { KeyValues } from '../components/KeyValues.js';
import { changeRequestOf, isHttpUrl, issueUrl, threadIssue, threadPublish } from '../task-outcome.js';
import { CopyButton } from './TaskRun.js';
import { TaskSection } from './TaskSection.js';

/** The issue row's value: linked when the repository gives it a url, a plain `#n` otherwise, null with no issue. */
function issueValue(issue: number | null, issueLink: string | null): ReactNode {
    if (issue === null) return null;
    if (issueLink === null) return `#${issue}`;
    return (
        <a key="issue" href={issueLink} target="_blank" rel="noopener noreferrer">
            #{issue}
        </a>
    );
}

/**
 * The task's outcome: what it published — the branch as a chip with its copy button, the pull
 * request and the issue — and nothing else; the state, the clock and the execution facts are the
 * other tiles'. Null until something is published, so the tile never says "nothing yet".
 *
 * Everything here is what the board reports or a blank. There is deliberately no PR state: the
 * publish line the driver appends carries a branch and maybe a url, and no source records a PR's
 * state, so nothing claims one. The PR is linked only when its url is one the reader can safely
 * open (`isHttpUrl`) — nothing a run echoed becomes a handler href.
 */
export function TaskOutcome({ jobs }: { jobs: Job[] }) {
    const latest = jobs[jobs.length - 1] as Job;
    const publish = threadPublish(jobs);
    const issue = threadIssue(jobs);
    if (publish === null && issue === null) return null;
    const issueLink = issueUrl(latest.repo, issue);
    const prLink = publish !== null && publish.url !== null && isHttpUrl(publish.url) ? publish.url : null;
    const request = prLink !== null ? changeRequestOf(prLink) : null;
    const prNr = request?.number ?? null;
    // A row's link is a reference, not a command: the row's label already says what it is, so
    // the value names only WHICH one — the number. Keyed: the nodes reach the DOM through
    // `KeyValues`' own map.
    const rows: [string, ReactNode][] = [
        [
            request?.label.name ?? 'Pull request',
            prLink !== null ? (
                // A new window, not a navigation over the dashboard, and rel=noopener/noreferrer
                // so the opened PR cannot reach back into this tab.
                <a key="pr" href={prLink} target="_blank" rel="noopener noreferrer">
                    {prNr !== null ? `#${prNr}` : request?.label.name}
                </a>
            ) : null,
        ],
        ['Issue', issueValue(issue, issueLink)],
    ];
    const pairs = rows.filter(([, value]) => value !== null);
    return (
        <TaskSection
            title="Outcome"
            className="task-outcome"
            defaultOpen
            aside={prNr !== null ? `${request?.label.short} #${prNr}` : null}
        >
            {publish !== null ? (
                <p className="task-publish">
                    <code className="task-branch">
                        <Icon name="git-branch" size={14} />
                        {publish.branch}
                    </code>
                    <CopyButton text={publish.branch} label="Copy branch name" />
                </p>
            ) : null}
            {pairs.length > 0 ? <KeyValues pairs={pairs} /> : null}
        </TaskSection>
    );
}
