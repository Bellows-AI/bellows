import { useEffect, useRef, useState } from 'react';
import { trackedRepos, type UseRepos } from '../api/useRepos.js';
import type { EnvVarView, UseEnv } from '../api/useEnv.js';
import { DraftReturnBanner } from '../components/DraftReturnBanner.js';
import { KeyValues } from '../components/KeyValues.js';
import { PageHeader } from '../components/PageHeader.js';
import { useUnsavedChanges } from '../components/UnsavedChangesDialog.js';
import type { GuardApi } from '../components/UnsavedChangesDialog.js';
import { RepositoryConfigDetail, RepositoryListNotices, RepositorySetupList } from '../components/RepositorySetup.js';
import { matchesSearch, orderByRecency } from '../components/repository-setup.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/** The list's transient postures, worded like the page has always worded them: a load in flight
 * says so, and a hard failure is named rather than rendered as an empty list. */
function listNoticeOf(repos: UseRepos): string | null {
    if (repos.data) return null;
    if (repos.loading) return 'Loading repositories…';
    if (repos.error) return `Could not reach GitHub: ${repos.error}`;
    return null;
}

/**
 * The configured repository's environment editor: a loading line while the org-wide env read is
 * still in flight, or the panel once it has landed. Split out of `SettingsRepositoriesPage` so
 * its own loading/data check does not add to the page's cognitive complexity.
 */
function ConfiguredRepoEnv({
    configured,
    owner,
    name,
    scope,
    env,
    onDirtyChange,
}: {
    configured: string;
    owner: string;
    name: string;
    scope: { vars: EnvVarView[] } | undefined;
    env: UseEnv;
    onDirtyChange: (dirty: boolean) => void;
}) {
    if (env.loading && !env.data) return <p className="status">Loading environment…</p>;
    if (!env.data) return null;
    return (
        <EnvVarsPanel
            key={configured}
            title={configured}
            hint=""
            initialVars={scope?.vars ?? []}
            onSave={(vars) => env.saveRepo({ owner, name }, vars)}
            draftId={`repo:${configured}`}
            draftLabel={configured}
            onDirtyChange={onDirtyChange}
        />
    );
}

/**
 * The configured-repository detail: which repository is open, its editor's dirty flag, the
 * focus handoff, and the guarded switch between repositories. Split out of
 * `SettingsRepositoriesPage` to keep its own state out of the page body.
 */
function useConfiguredRepoDetail(guard: GuardApi | null) {
    const [configured, setConfigured] = useState<string | null>(null);
    /** The configured editor's dirty flag, mirrored by the panel's onDirtyChange: the switch
     * question must be asked BEFORE the panel unmounts and its draft dies with it. */
    const [detailDirty, setDetailDirty] = useState(false);
    const headingRef = useRef<HTMLHeadingElement | null>(null);

    // The handoff: the detail opens below the full-width table, so Configure moves the reader
    // there and the focus follows at every width.
    useEffect(() => {
        if (!configured) return;
        headingRef.current?.focus();
    }, [configured]);

    /**
     * Configure is a guarded detail switch (issue 182): swapping the editor while its draft is
     * dirty runs the same discard confirmation the route blocker runs. Continue editing changes
     * nothing; Discard lets the switch through, and the key-bumped panel starts fresh, which IS
     * the reset — so the draft it hands the dialog discards nothing itself.
     */
    const configure = async (key: string) => {
        if (configured && configured !== key && detailDirty && guard) {
            const discardConfirmed = await guard.confirmDiscard({
                id: `repo:${configured}`,
                label: configured,
                dirty: true,
                discard: () => {},
            });
            if (!discardConfirmed) return;
        }
        setConfigured(key);
        setDetailDirty(false);
    };

    return { configured, detailDirty, setDetailDirty, headingRef, configure };
}

/**
 * The Repositories section of the settings tree: the repositories this board tracks, and the
 * organization-wide environment of one of them. Configuration needs no per-member state — the
 * repository env scope is organization-wide and any member edits it; the server validates
 * installation visibility. The editor's dirty draft rides the area's unsaved-change guard (issue
 * 182), so switching repositories or leaving the page meets the one discard confirmation.
 */
export function SettingsRepositoriesPage() {
    const { env, session, repos } = useSettingsPage();
    const [search, setSearch] = useState('');
    const guard = useUnsavedChanges();
    const { configured, setDetailDirty, headingRef, configure } = useConfiguredRepoDetail(guard);
    const reported = repos.data?.repos ?? [];
    const shown = matchesSearch(orderByRecency(reported), search);
    const [owner, name] = configured?.split('/') ?? [];
    const scope = env.data?.repos.find((s) => s.owner === owner && s.name === name);

    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Repositories"
                description="Repositories this board tracks. Configure repository-wide environment."
                meta={
                    session ? (
                        <div className="repo-scope">
                            <KeyValues pairs={[['Organization', session.organization.name]]} />
                        </div>
                    ) : undefined
                }
            />
            <DraftReturnBanner />
            {env.error ? <p className="status">{env.error}</p> : null}
            <RepositoryListNotices
                installation={repos.data?.installation ?? null}
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
                onConfigure={(key) => void configure(key)}
                loaded={trackedRepos(repos).repos !== null}
            />
            <RepositoryConfigDetail repo={configured && owner && name ? { owner, name } : null} headingRef={headingRef}>
                {configured && owner && name ? (
                    <ConfiguredRepoEnv
                        configured={configured}
                        owner={owner}
                        name={name}
                        scope={scope}
                        env={env}
                        onDirtyChange={setDetailDirty}
                    />
                ) : null}
            </RepositoryConfigDetail>
        </>
    );
}
