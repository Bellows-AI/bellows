import { useState } from 'react';
import { startAuthorization, type StartAuthorizationInput } from './connections.js';

/**
 * Starts a provider's authorization that returns to `returnTo` (a path on this app). `start` resolves to the
 * refusal message, or null once the browser is on its way to the consent screen; `saving` stays set on success
 * because the page is gone, and resets on a refusal.
 */
export function useAuthorizationStart(provider: string, returnTo: string) {
    const [saving, setSaving] = useState(false);

    const start = async (input: StartAuthorizationInput): Promise<string | null> => {
        setSaving(true);
        const started = await startAuthorization(provider, { ...input, returnTo });
        if (started.ok) {
            window.location.assign(started.authorizeUrl);
            return null;
        }
        setSaving(false);
        return started.error;
    };

    return { saving, start };
}
