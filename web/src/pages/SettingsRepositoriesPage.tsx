import { useEffect, useRef, useState } from 'react';
import { trackedRepos, type UseRepos } from '../api/useRepos.js';
import type { EnvVarView, UseEnv } from '../api/useEnv.js';
import { DraftReturnBanner } from '../components/DraftReturnBanner.js';
import { PageHeader } from '../components/PageHeader.js';
import { useUnsavedChanges } from '../components/UnsavedChangesDialog.js';
import {
    RepositoryConfigDetail,
    RepositoryHeaderMeta,
    RepositoryListNotices,
    type RepositoryListNoticesProps,
    RepositorySetupList,
} from '../components/RepositorySetup.js';
import { matchesSearch, orderByRecency } from '../components/repository-setup.js';
import { EnvVarsSection } from '../panels/EnvVarsSection.js';
import { useSettingsPage } from './SettingsLayout.js';
import { StateNote } from '../components/StateNote.js';

/** The list's transient postures, worded like the page has always worded them: a load in flight
 * says so, and a hard failure is named rather than rendered as an empty list. */
function listNoticeOf(repos: UseRepos): RepositoryListNoticesProps['listNotice'] {
    if (repos.data) return null;
    if (repos.loading) return { state: 'loading', text: 'Loading repositories…' };
    if (repos.error) return { state: 'error', text: `Could not reach GitHub: ${repos.error}` };
    return null;
}

/**
 * The configured repository's environment variables: a loading line while the org-wide env read is
 * still in flight, or the summary once it has landed. Split out of `SettingsRepositoriesPage` so
 * its own loading/data check does not add to the page's cognitive complexity.
 */
function ConfiguredRepoEnv({
    configured,
    owner,
    name,
    scope,
    env,
}: {
    configured: string;
    owner: string;
    name: string;
    scope: { vars: EnvVarView[] } | undefined;
    env: UseEnv;
}) {
    if (env.loading && !env.data) return <StateNote state="loading">Loading environment…</StateNote>;
    if (!env.data) return null;
    return (
        <EnvVarsSection
            key={configured}
            title={configured}
            monoTitle
            vars={scope?.vars ?? []}
            onSave={(vars) => env.saveRepo({ owner, name }, vars)}
            draftId={`repo:${configured}`}
            draftLabel={configured}
        />
    );
}

/**
 * The configured-repository detail: which repository is open and the focus handoff. Split out of
 * `SettingsRepositoriesPage` to keep its own state out of the page body. Switching away from a
 * repository whose inline editor holds a dirty draft asks first: the switch remounts the editor,
 * so it happens only after the reader chose Discard changes.
 */
function useConfiguredRepoDetail() {
    const [configured, setConfigured] = useState<string | null>(null);
    const headingRef = useRef<HTMLHeadingElement | null>(null);
    const guard = useUnsavedChanges();

    const configure = async (next: string) => {
        const draft = configured && next !== configured ? guard?.dirtyDraft(`repo:${configured}`) : null;
        if (draft && guard && !(await guard.confirmDiscard(draft))) return;
        setConfigured(next);
    };

    // The handoff: the detail opens below the full-width table, so Configure moves the reader
    // there and the focus follows at every width.
    useEffect(() => {
        if (!configured) return;
        headingRef.current?.focus();
    }, [configured]);

    return { configured, headingRef, configure };
}

/**
 * The Repositories section of the settings tree: the repositories this board tracks, and the
 * organization-wide environment of one of them. Configuration needs no per-member state — the
 * repository env scope is organization-wide and any member edits it; the server validates
 * installation visibility. The variables editor's dirty draft rides the area's unsaved-change
 * guard (issue 182), so leaving the page or switching repositories meets the one discard
 * confirmation.
 */
export function SettingsRepositoriesPage() {
    const { env, session, repos } = useSettingsPage();
    const [search, setSearch] = useState('');
    const { configured, headingRef, configure } = useConfiguredRepoDetail();
    const reported = repos.data?.repos ?? [];
    const shown = matchesSearch(orderByRecency(reported), search);
    const [owner, name] = configured?.split('/') ?? [];
    const scope = env.data?.repos.find((s) => s.owner === owner && s.name === name);

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Repositories"
                description="Tracked repositories and their environment."
                meta={
                    session || repos.data?.installation ? (
                        <RepositoryHeaderMeta
                            organization={session?.organization.name ?? null}
                            installation={repos.data?.installation ?? null}
                        />
                    ) : undefined
                }
            />
            <DraftReturnBanner />
            {env.error ? <StateNote state="error">{env.error}</StateNote> : null}
            <RepositoryListNotices
                cachedError={repos.data?.meta.error ?? null}
                fetchedAt={repos.data?.meta.fetchedAt ?? null}
                listNotice={listNoticeOf(repos)}
            />
            <RepositorySetupList
                repos={reported}
                shown={shown}
                search={search}
                onSearch={setSearch}
                configured={configured}
                onConfigure={configure}
                loaded={trackedRepos(repos).repos !== null}
            />
            <RepositoryConfigDetail repo={configured && owner && name ? { owner, name } : null} headingRef={headingRef}>
                {configured && owner && name ? (
                    <ConfiguredRepoEnv configured={configured} owner={owner} name={name} scope={scope} env={env} />
                ) : null}
            </RepositoryConfigDetail>
        </>
    );
}
