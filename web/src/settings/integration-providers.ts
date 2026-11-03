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

const RESULT_NOTICE: Record<string, IntegrationNotice> = {
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
};

/** The notice for the `?integration=…&result=…` the callback redirected back with, or null when there is none to show. */
export const integrationNotice = (integration: string | null, result: string | null): IntegrationNotice | null => {
    if (integration !== 'jira' || !result) return null;
    return RESULT_NOTICE[result] ?? { message: `Jira connection failed (${result}).`, tone: 'bad' };
};
