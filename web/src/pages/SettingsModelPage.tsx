import { PageHeader } from '../components/PageHeader.js';
import { ProviderConnectionsPanel } from '../panels/ProviderConnectionsPanel.js';
import { useSettingsPage } from './SettingsLayout.js';

/**
 * Settings → Model: the named provider connections executors share. Connecting a provider and choosing the default
 * executor on it is the setup step (Connect a provider); this page keeps the connections.
 */
export function SettingsModelPage() {
    const { session } = useSettingsPage();
    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Model"
                description="The named provider connections executors share: add one, replace its key, or remove it."
            />
            <ProviderConnectionsPanel session={session} />
        </>
    );
}
