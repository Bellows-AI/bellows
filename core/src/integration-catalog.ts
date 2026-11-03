/**
 * The integration providers the board knows by name: one list for the Integrations pages and the catalog read
 * (`GET /api/integrations/catalog`). Static: whether a provider can be connected is `availability` here plus
 * the deployment's configuration, never a guess from what is installed.
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

export const INTEGRATION_CATALOG: readonly IntegrationProvider[] = [
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
export const LISTED_PROVIDERS: readonly IntegrationProvider[] = INTEGRATION_CATALOG.filter(
    (provider) => provider.availability !== 'planned'
);

export const integrationProvider = (id: string): IntegrationProvider | undefined =>
    INTEGRATION_CATALOG.find((provider) => provider.id === id);

/** Only an `oauth` provider has a Connect. */
export const canConnect = (provider: IntegrationProvider): boolean => provider.availability === 'oauth';
