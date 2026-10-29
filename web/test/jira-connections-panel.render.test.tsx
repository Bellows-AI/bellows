import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConnectionView } from '../src/api/connections.js';
import {
    ALLOW_COMMENTS_LABEL,
    CONNECT_JIRA_LABEL,
    integrationNotice,
    JiraConnectionsPanel,
    NO_CONNECTIONS_NOTE,
} from '../src/panels/JiraConnectionsPanel.js';

const connection = (site: string, overrides: Partial<ConnectionView> = {}): ConnectionView => ({
    id: `00000000-0000-4000-8000-${site.length.toString().padStart(12, '0')}`,
    provider: 'jira',
    site,
    account: 'stub-account-a@example.com',
    access: 'read',
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
});

const render = (props: Partial<Parameters<typeof JiraConnectionsPanel>[0]> = {}) =>
    renderToStaticMarkup(
        <JiraConnectionsPanel
            connections={[connection('new.atlassian.net'), connection('older-site.atlassian.net', { access: 'write' })]}
            saving={false}
            notice={null}
            onStart={async () => null}
            onDisconnect={() => {}}
            {...props}
        />
    );

describe('the Jira connections panel', () => {
    it('shows site, account label, access, Reconnect and Disconnect per row, and no token field', () => {
        const html = render();
        expect(html).toContain('new.atlassian.net');
        expect(html).toContain('stub-account-a@example.com');
        expect(html).toContain('data-label="Account"');
        expect(html).toContain('data-label="Access"');
        expect(html).not.toContain('2026-09-01T00:00:00.000Z');
        expect(html.match(/>Reconnect<\/button>/g)).toHaveLength(2);
        expect(html.match(/>Disconnect<\/button>/g)).toHaveLength(2);
        expect(html).not.toContain('<input');
        expect(html).not.toMatch(/apiToken|api_token|API token|Legacy/);
    });

    it('offers "Allow adding comments" on a read row only, and the Connect button in the head', () => {
        const html = render();
        expect(html.match(new RegExp(`>${ALLOW_COMMENTS_LABEL}</button>`, 'g'))).toHaveLength(1);
        expect(html).toMatch(new RegExp(`class="panel-head">.*${CONNECT_JIRA_LABEL}</button>`));
    });

    it('says so when the list is empty', () => {
        const html = render({ connections: [] });
        expect(html).toContain(NO_CONNECTIONS_NOTE);
        expect(html).toContain(CONNECT_JIRA_LABEL);
    });

    it('disables every control while a write is in flight', () => {
        const html = render({ saving: true });
        // Connect, then Reconnect, Disconnect for both rows and Allow adding comments for the read one.
        expect(html.match(/<button[^>]*disabled/g)).toHaveLength(6);
    });

    it('renders the callback result sentence as a status line', () => {
        expect(render({ notice: 'Jira connected.' })).toContain('Jira connected.');
    });
});

describe('the callback result sentences', () => {
    it('names the mismatch, the denial and success, and is silent without a result', () => {
        expect(integrationNotice('jira', 'connected')).toBe('Jira connected.');
        expect(integrationNotice('jira', 'denied')).toMatch(/consent was denied/);
        expect(integrationNotice('jira', 'identity-mismatch')).toMatch(/not the account this connection was made with/);
        expect(integrationNotice('jira', 'site-mismatch')).toMatch(/site/);
        expect(integrationNotice('jira', 'exchange-failed')).toContain('exchange-failed');
        expect(integrationNotice(null, null)).toBeNull();
        expect(integrationNotice('github', 'connected')).toBeNull();
    });
});
