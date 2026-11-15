import { canConnect, INTEGRATION_CATALOG, type IntegrationProvider } from '@factory-ai/core';
import type { ConnectionView } from '../api/connections.js';

/**
 * The sentences the Integrations pages say about a connection. The provider list is `@factory-ai/core`'s
 * `INTEGRATION_CATALOG`; a provider appears as Connected only when `GET /api/connections` returned a row for it.
 */

export type ConnectionState = 'connected' | 'needs-reconnect' | 'disconnected';

/** A disconnected row is disconnected whatever its grant says; an active one needs reconnecting when its grant does. */
export const connectionState = (connection: ConnectionView): ConnectionState => {
    if (connection.status === 'disconnected') return 'disconnected';
    return connection.needsReconnect ? 'needs-reconnect' : 'connected';
};

/** What a connection lets a task do, as a sentence. */
export const accessSentence = (label: string, access: ConnectionView['access']): string =>
    access === 'write' ? `Tasks can look ${label} up and add comments.` : `Tasks can look ${label} up.`;

/** A callback result: the sentence and the banner it is shown in (`banner-info` success, `banner-warn` declined, `banner-bad` failed). */
export interface IntegrationNotice {
    message: string;
    tone: 'info' | 'warn' | 'bad';
}

/** Each provider's own callback sentences; a result it has none for is worded from its label. */
const RESULT_NOTICES: Record<string, Record<string, IntegrationNotice>> = {
    jira: {
        connected: { message: 'Jira connected.', tone: 'info' },
        denied: { message: 'Atlassian consent was denied; nothing was connected.', tone: 'warn' },
        'identity-mismatch': {
            message:
                'That Atlassian account is not the account this connection was made with. Reconnect with the original account, or disconnect and connect again.',
            tone: 'bad',
        },
        'site-mismatch': {
            message: 'The Atlassian account cannot reach that site, so nothing was connected.',
            tone: 'bad',
        },
    },
};

/**
 * The notice for the `?integration=…&result=…` the callback redirected back with, or null when there is none to show:
 * only an oauth provider of the catalog has a callback.
 */
export const integrationNotice = (
    integration: string | null,
    result: string | null,
    catalog: readonly IntegrationProvider[] = INTEGRATION_CATALOG
): IntegrationNotice | null => {
    const provider = catalog.find((entry) => entry.id === integration);
    if (!provider || !canConnect(provider) || !result) return null;
    const own = RESULT_NOTICES[provider.id]?.[result];
    if (own) return own;
    return result === 'connected'
        ? { message: `${provider.label} connected.`, tone: 'info' }
        : { message: `${provider.label} connection failed (${result}).`, tone: 'bad' };
};
