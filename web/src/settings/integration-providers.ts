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

/** Whose consent screen a provider's connect sends the member to, where it is not the provider's own name. */
const CONSENT_AUTHORITY: Readonly<Record<string, string>> = { jira: 'Atlassian' };

/** The name a connect or reconnect button and the write consent say the member is sent to. */
export const consentAuthority = (provider: Pick<IntegrationProvider, 'id' | 'label'>): string =>
    CONSENT_AUTHORITY[provider.id] ?? provider.label;

/** A callback result: the sentence and the banner it is shown in (`banner-info` success, `banner-warn` declined, `banner-bad` failed). */
export interface IntegrationNotice {
    message: string;
    tone: 'info' | 'warn' | 'bad';
}

/** Each callback result's sentence, worded from the provider's catalog name; any other result is a failure. */
const RESULT_NOTICE: Record<string, (label: string) => IntegrationNotice> = {
    connected: (label) => ({ message: `${label} connected.`, tone: 'info' }),
    denied: (label) => ({ message: `${label} consent was denied; nothing was connected.`, tone: 'warn' }),
    'identity-mismatch': (label) => ({
        message: `That ${label} account is not the account this connection was made with. Reconnect with the original account, or disconnect and connect again.`,
        tone: 'bad',
    }),
    'site-mismatch': (label) => ({
        message: `The ${label} account cannot reach that site, so nothing was connected.`,
        tone: 'bad',
    }),
};

/**
 * The notice for the `?integration=…&result=…` the callback redirected back with, or null when there is none to show:
 * only an `oauth` provider of the catalog has a callback.
 */
export const integrationNotice = (
    integration: string | null,
    result: string | null,
    catalog: readonly IntegrationProvider[] = INTEGRATION_CATALOG
): IntegrationNotice | null => {
    const provider = catalog.find((entry) => entry.id === integration);
    if (!provider || !canConnect(provider) || !result) return null;
    const notice = RESULT_NOTICE[result];
    return notice
        ? notice(provider.label)
        : { message: `${provider.label} connection failed (${result}).`, tone: 'bad' };
};
