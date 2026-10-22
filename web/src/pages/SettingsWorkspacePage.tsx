import { ConfigurationScope } from '../components/ConfigurationScope.js';
import { DraftReturnBanner } from '../components/DraftReturnBanner.js';
import { PageHeader } from '../components/PageHeader.js';
import { EnvVarsPanel } from '../panels/EnvVarsPanel.js';
import { JiraConnectionsSection } from '../panels/JiraConnectionsSection.js';
import { USER_CONNECTION_SCOPE } from '../api/connections.js';
import type { UseEnv } from '../api/useEnv.js';
import { useSettingsPage } from './SettingsLayout.js';

/** The member's own environment editor: a loading line while the read is in flight, or the
 * panel once it has landed. Split out of `SettingsWorkspacePage` so its own loading/data check
 * does not add to the page's cognitive complexity. */
function WorkspaceEnvEditor({ env }: { env: UseEnv }) {
    if (env.loading && !env.data) return <p className="status">Loading environment…</p>;
    if (!env.data) return null;
    return (
        <EnvVarsPanel
            title="My workspace"
            hint="Your own defaults, on every task you queue."
            initialVars={env.data.workspace}
            onSave={env.saveWorkspace}
            draftId="workspace"
            draftLabel="My workspace"
        />
    );
}

/**
 * The Workspace section of the settings tree: the member's Jira connection and own environment
 * scope. The board keeps no filesystem workspace, so there is no checkout state to show.
 */
export function SettingsWorkspacePage() {
    const { env, session } = useSettingsPage();
    return (
        <>
            <PageHeader eyebrow="Settings" title="Workspace" />
            <DraftReturnBanner />

            <JiraConnectionsSection scope={USER_CONNECTION_SCOPE} session={session} />

            <ConfigurationScope scope="workspace" />

            {env.error ? <p className="status">{env.error}</p> : null}
            {/* Same data gate as the organization page: the editor mounts only when the scope's
                rows exist, never as an enabled empty draft over a failed read. */}
            <WorkspaceEnvEditor env={env} />
        </>
    );
}
