import { PageHeader } from '../components/PageHeader.js';
import { JiraConnectionsSection } from '../panels/JiraConnectionsSection.js';
import { useSettingsPage } from './SettingsLayout.js';

/** The member's external services: provider discovery and their managed connections in one place. */
export function SettingsIntegrationsPage() {
    const { session } = useSettingsPage();
    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Integrations"
                description="Connect services your agents can use for context, notifications, and tools."
            />
            <JiraConnectionsSection session={session} />
        </>
    );
}
