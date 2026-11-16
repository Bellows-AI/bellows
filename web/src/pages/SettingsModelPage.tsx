import { type ReactNode, useState } from 'react';
import { PageHeader } from '../components/PageHeader.js';
import { ModelSetup } from '../model-setup/ModelSetupForm.js';
import { useSettingsPage } from './SettingsLayout.js';

const actions = (primary: ReactNode) => <div className="setup-actions">{primary}</div>;

/**
 * Settings → Model: the onboarding step's `ModelSetup` under the settings tree — the provider key and the default agent
 * and model. A save refreshes the layout's environment poll (the key is a secret there) and announces itself.
 */
export function SettingsModelPage() {
    const { session, env } = useSettingsPage();
    const [saved, setSaved] = useState('');
    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Model"
                description="The provider key your tasks run on, and the default agent and model."
            />
            <ModelSetup
                session={session}
                labels={{ form: 'Save', banner: 'Save' }}
                saveExisting
                onSaved={() => {
                    env.refresh();
                    setSaved('Saved.');
                }}
                footer={actions}
            />
            <p className="muted" role="status">
                {saved}
            </p>
        </>
    );
}
