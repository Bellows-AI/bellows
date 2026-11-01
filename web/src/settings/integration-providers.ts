import type { ConnectionView } from '../api/connections.js';

/**
 * The integration providers the Integrations pages know by name, and the sentences they say about a connection.
 * Static: whether a provider can be connected is `availability`, never a guess from what is installed, and a
 * provider appears as Connected only when `GET /api/connections` returned a row for it.
 */

/** The closed list a provider is filed under. */
export const INTEGRATION_CATEGORIES = ['Issue tracking', 'Communication', 'Agent tools', 'CI / DevOps'] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];

/**
 * `oauth`: the member connects it here; `organization`: managed elsewhere (GitHub is the organization's App
 * installation); `planned`: nothing behind it yet.
 */
export type IntegrationAvailability = 'oauth' | 'organization' | 'planned';

export interface IntegrationProvider {
    id: string;
    label: string;
    category: IntegrationCategory;
    availability: IntegrationAvailability;
    description: string;
}

export const INTEGRATION_PROVIDERS: readonly IntegrationProvider[] = [
    {
        id: 'jira',
        label: 'Jira',
        category: 'Issue tracking',
        availability: 'oauth',
        description: 'Let tasks look up and comment on your Jira issues.',
    },
    {
        id: 'slack',
        label: 'Slack',
        category: 'Communication',
        availability: 'planned',
        description: 'Follow tasks from Slack.',
    },
    {
        id: 'discord',
        label: 'Discord',
        category: 'Communication',
        availability: 'planned',
        description: 'Follow tasks from Discord.',
    },
    {
        id: 'github',
        label: 'GitHub',
        category: 'CI / DevOps',
        availability: 'organization',
        description: "The organization's GitHub App installation.",
    },
    {
        id: 'gitlab',
        label: 'GitLab',
        category: 'CI / DevOps',
        availability: 'planned',
        description: 'Work on GitLab repositories.',
    },
    {
        id: 'mcp',
        label: 'MCP servers',
        category: 'Agent tools',
        availability: 'planned',
        description: 'Remote MCP tool servers your agents call.',
    },
];

/** The providers the Integrations pages show: a `planned` one stays hidden until something is behind it. */
export const LISTED_PROVIDERS: readonly IntegrationProvider[] = INTEGRATION_PROVIDERS.filter(
    (provider) => provider.availability !== 'planned'
);

export const integrationProvider = (id: string): IntegrationProvider | undefined =>
    INTEGRATION_PROVIDERS.find((provider) => provider.id === id);

/** Only an `oauth` provider has a Connect. */
export const canConnect = (provider: IntegrationProvider): boolean => provider.availability === 'oauth';

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
