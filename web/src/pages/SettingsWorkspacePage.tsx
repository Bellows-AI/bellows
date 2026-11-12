import { DraftReturnBanner } from '../components/DraftReturnBanner.js';
import { PageHeader } from '../components/PageHeader.js';
import { StateNote } from '../components/StateNote.js';
import { EnvVarsSection } from '../panels/EnvVarsSection.js';
import { NotificationSubscriptionsSection } from '../panels/NotificationSubscriptionsSection.js';
import type { UseEnv } from '../api/useEnv.js';
import { useSettingsPage } from './SettingsLayout.js';

/** The member's own environment variables: a loading line while the read is in flight, or the
 * summary once it has landed. Split out of `SettingsWorkspacePage` so its own loading/data check
 * does not add to the page's cognitive complexity. */
function WorkspaceEnvEditor({ env }: { env: UseEnv }) {
    if (env.loading && !env.data) return <StateNote state="loading">Loading environment…</StateNote>;
    if (!env.data) return null;
    return (
        <EnvVarsSection
            title="Workspace variables"
            vars={env.data.workspace}
            onSave={env.saveWorkspace}
            draftId="workspace"
            draftLabel="Workspace variables"
        />
    );
}

/**
 * The Workspace section of the settings tree: the member's own notification subscriptions and environment
 * scope. Their Jira connections live under Integrations. The board keeps no filesystem workspace, so there is no
 * checkout state to show.
 */
export function SettingsWorkspacePage() {
    const { env, session } = useSettingsPage();
    return (
        <>
            <PageHeader eyebrow="Settings" title="Workspace" />
            <DraftReturnBanner />

            <NotificationSubscriptionsSection session={session} scope="workspace" />

            {env.error ? <StateNote state="error">{env.error}</StateNote> : null}
            {/* Same data gate as the organization page: the editor mounts only when the scope's
                rows exist, never as an enabled empty draft over a failed read. */}
            <WorkspaceEnvEditor env={env} />
        </>
    );
}
