import type { ReactNode, RefObject } from 'react';
import type { InstallationRepo } from '../api/useRepos.js';
import { ConfigurationScope } from './ConfigurationScope.js';
import { commitDate } from '../format.js';
import { NOT_AVAILABLE, repoKey } from './repository-setup.js';

/**
 * The presentational halves of the repository page: the notices over the list, the searchable
 * tracked-repository table, and the selected repository's environment detail.
 *
 * Hooks-free and fetch-free by the PageHeader contract, so a static render is a complete render;
 * the sentences are pinned in repository-setup.render.test.tsx. The board tracks repositories, it
 * does not check them out, so nothing here states a selection, a clone or a size.
 */

/** An unreported fact, in words (never `0`, never a bare dash). */
function NotAvailable() {
    return <span className="repo-na">{NOT_AVAILABLE}</span>;
}

export interface RepositoryListNoticesProps {
    installation: { account: string | null; repositorySelection: 'all' | 'selected' | null } | null;
    cachedError: string | null;
    /** When the cached list was fetched — shown beside the cached warning, never faked. */
    fetchedAt?: string | null;
    /**
     * The list's transient posture — loading in flight, or a hard failure with no rows in hand.
     * Stated here because an absent list is not an empty one.
     */
    listNotice: string | null;
}

/** The installation line's sentence, or null when there is no installation to name yet. */
function installationNote(installation: RepositoryListNoticesProps['installation']): string | null {
    if (!installation) return null;
    const scope = installation.repositorySelection
        ? ` — access to ${installation.repositorySelection} repositories`
        : '';
    return `Installation: ${installation.account ?? 'GitHub App'}${scope}.`;
}

export function RepositoryListNotices({
    installation,
    cachedError,
    fetchedAt,
    listNotice,
}: RepositoryListNoticesProps) {
    const note = installationNote(installation);
    return (
        <>
            {listNotice ? <p className="status">{listNotice}</p> : null}
            {note ? <p className="muted">{note}</p> : null}
            {cachedError ? (
                <p className="status">
                    Showing a cached list{fetchedAt ? ` from ${commitDate(fetchedAt)}` : ''}: {cachedError}
                </p>
            ) : null}
        </>
    );
}

export interface RepositorySetupListProps {
    /** The full, recency-ordered tracked list. */
    repos: readonly InstallationRepo[];
    /** The searched subset, already filtered and ordered by the page. */
    shown: readonly InstallationRepo[];
    search: string;
    onSearch: (query: string) => void;
    configured: string | null;
    onConfigure: (key: string) => void;
    /** A successful response arrived: only then may "no match" be stated. */
    loaded: boolean;
}

/** One repository's row: identity, branch and Configure. */
function RepositoryRow({
    repo,
    configured,
    onConfigure,
}: { repo: InstallationRepo } & Pick<RepositorySetupListProps, 'configured' | 'onConfigure'>) {
    const key = repoKey(repo);
    return (
        <tr className={configured === key ? 'repo-row-configured' : undefined}>
            <td data-label="Repository">
                {key}
                {repo.private ? <span className="pill">private</span> : null}
            </td>
            <td data-label="Branch">{repo.defaultBranch ?? <NotAvailable />}</td>
            <td>
                <button type="button" aria-current={configured === key} onClick={() => onConfigure(key)}>
                    Configure
                </button>
            </td>
        </tr>
    );
}

/** The list's empty postures: no match for the query, or an installation that reports nothing. */
function RepositoryListEmpty({ loaded, repos, search }: { loaded: boolean; repos: number; search: string }) {
    if (!loaded) return null;
    if (repos) return <p className="status">No repositories match “{search}”</p>;
    return (
        <p className="status">
            This GitHub App is not installed on any repositories yet. Ask an administrator to update the installation on
            GitHub.
        </p>
    );
}

export function RepositorySetupList({
    repos,
    shown,
    search,
    onSearch,
    configured,
    onConfigure,
    loaded,
}: RepositorySetupListProps) {
    return (
        <section className="panel" aria-label="Tracked repositories">
            <div className="repo-search">
                <label htmlFor="repo-setup-search">Search repositories</label>
                <input
                    id="repo-setup-search"
                    className="field"
                    type="text"
                    placeholder="owner/name"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                />
                {search ? (
                    <button type="button" onClick={() => onSearch('')}>
                        Clear search
                    </button>
                ) : null}
            </div>
            {shown.length ? (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
                <section className="table-wrap" aria-label="Repositories" tabIndex={0}>
                    <table className="data repo-table">
                        <thead>
                            <tr>
                                <th scope="col">Repository</th>
                                <th scope="col">Branch</th>
                                <th scope="col">
                                    <span className="visually-hidden">Configure</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((repo) => (
                                <RepositoryRow
                                    key={repoKey(repo)}
                                    repo={repo}
                                    configured={configured}
                                    onConfigure={onConfigure}
                                />
                            ))}
                        </tbody>
                    </table>
                </section>
            ) : (
                <RepositoryListEmpty loaded={loaded} repos={repos.length} search={search} />
            )}
        </section>
    );
}

export interface RepositoryConfigDetailProps {
    /** The configured repository, or null — nothing renders before a choice. */
    repo: { owner: string; name: string } | null;
    /** Focus target for the configure handoff; the page moves focus, never the component. */
    headingRef?: RefObject<HTMLHeadingElement | null>;
    children?: ReactNode;
}

/**
 * The selected repository's environment detail, below the table. The scope truth — what it applies
 * to, who may edit it, the precedence order — is the shared ConfigurationScope (issue 180); the
 * mounted editor renders as children, so a save's echoed rows and its confirmation survive.
 */
export function RepositoryConfigDetail({ repo, headingRef, children }: RepositoryConfigDetailProps) {
    if (!repo) return null;
    return (
        <section className="panel repo-detail">
            <h2 ref={headingRef} tabIndex={-1}>
                Selected repository: {repoKey(repo)}
            </h2>
            <ConfigurationScope scope="repository" repository={repo} />
            {children}
        </section>
    );
}
