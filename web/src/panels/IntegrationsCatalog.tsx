/** A provider directory, separate from the member's credential-bearing connection rows.
 * Only Jira has a working authorization flow. Other cards intentionally have no action. */
const UPCOMING_INTEGRATIONS = [
    {
        name: 'Slack',
        mark: 'S',
        category: 'Notifications',
        description: 'Send private updates and task results to Slack.',
    },
    {
        name: 'Discord',
        mark: 'D',
        category: 'Notifications',
        description: 'Deliver task updates to your Discord account or channels.',
    },
    {
        name: 'MCP servers',
        mark: 'M',
        category: 'Agent tools',
        description: 'Give your agents access to tools and data through MCP.',
    },
] as const;

export function IntegrationsCatalog({
    jiraCount,
    saving,
    onConnectJira,
}: {
    jiraCount: number;
    saving: boolean;
    onConnectJira: () => void;
}) {
    return (
        <section className="integrations-catalog" aria-label="Available integrations">
            <div className="integrations-intro">
                <h2>Available integrations</h2>
                <p className="muted">Choose a service to connect. Each integration manages its own permissions.</p>
            </div>
            <div className="integrations-grid">
                <article className="integration-card">
                    <div className="integration-card-header">
                        <span className="integration-mark" aria-hidden="true">J</span>
                        <span className="pill">{jiraCount === 0 ? 'Available' : `${jiraCount} connected`}</span>
                    </div>
                    <div>
                        <h3>Jira</h3>
                        <p className="integration-kind">Issue tracking</p>
                    </div>
                    <p className="muted">Read issues, search projects, and add comments with your consent.</p>
                    <div className="integration-card-action">
                        <button
                            type="button"
                            className="primary jira-connection-add"
                            disabled={saving}
                            onClick={onConnectJira}
                        >
                            Connect Jira
                        </button>
                    </div>
                </article>
                {UPCOMING_INTEGRATIONS.map((integration) => (
                    <article className="integration-card" key={integration.name}>
                        <div className="integration-card-header">
                            <span className="integration-mark" aria-hidden="true">{integration.mark}</span>
                            <span className="pill">Planned</span>
                        </div>
                        <div>
                            <h3>{integration.name}</h3>
                            <p className="integration-kind">{integration.category}</p>
                        </div>
                        <p className="muted">{integration.description}</p>
                        <p className="integration-card-action integration-coming">Not available yet</p>
                    </article>
                ))}
            </div>
        </section>
    );
}
