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
            error={null}
            onStart={async () => null}
            onDisconnect={() => {}}
            {...props}
        />
    );

describe('the Jira connections panel', () => {
    it('shows site, account label, access and one overflow trigger per row, and no token field', () => {
        const html = render();
        expect(html).toContain('new.atlassian.net');
        expect(html).toContain('stub-account-a@example.com');
        expect(html).toContain('data-label="Account"');
        expect(html).toContain('data-label="Access"');
        expect(html).toContain('data-label="Actions"');
        expect(html).not.toContain('2026-09-01T00:00:00.000Z');
        // RowActions: Reconnect leads a write row; on a read row it moves into the menu, Disconnect is always there.
        expect(html.match(/>Reconnect<\/button>/g)).toHaveLength(1);
        expect(html).toContain('aria-label="Actions for new.atlassian.net for stub-account-a@example.com"');
        expect(html).toContain('aria-label="Actions for older-site.atlassian.net for stub-account-a@example.com"');
        expect(html).not.toContain('>Disconnect<');
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
        // Connect, then each row's inline action and overflow trigger.
        expect(html.match(/<button[^>]*disabled/g)).toHaveLength(5);
    });

    it('toned banners for the callback result: info for success, an alert for the rest', () => {
        const ok = render({ notice: { message: 'Jira connected.', tone: 'info' } });
        expect(ok).toContain('class="banner-info"');
        expect(ok).not.toContain('role="alert"');
        const denied = render({ notice: { message: 'Atlassian consent was denied.', tone: 'warn' } });
        expect(denied).toMatch(/<div class="banner-warn" role="alert">/);
        const bad = render({ notice: { message: 'Jira connection failed (x).', tone: 'bad' } });
        expect(bad).toMatch(/<div class="banner-bad" role="alert">/);
        expect(ok + denied + bad).not.toContain('class="status"');
    });

    it('announces a list or disconnect failure inside the panel', () => {
        const html = render({ error: 'Could not disconnect.' });
        expect(html).toMatch(/role="alert"[^>]*>[^<]*(<[^>]+>)*[^<]*Could not disconnect\./);
        expect(html.indexOf('Could not disconnect.')).toBeGreaterThan(html.indexOf('<h2>Jira connections</h2>'));
    });
});

describe('the callback result sentences', () => {
    it('names the mismatch, the denial and success, and is silent without a result', () => {
        expect(integrationNotice('jira', 'connected')).toEqual({ message: 'Jira connected.', tone: 'info' });
        expect(integrationNotice('jira', 'denied')?.message).toMatch(/consent was denied/);
        expect(integrationNotice('jira', 'denied')?.tone).toBe('warn');
        expect(integrationNotice('jira', 'identity-mismatch')?.message).toMatch(
            /not the account this connection was made with/
        );
        expect(integrationNotice('jira', 'identity-mismatch')?.tone).toBe('bad');
        expect(integrationNotice('jira', 'site-mismatch')?.message).toMatch(/site/);
        expect(integrationNotice('jira', 'site-mismatch')?.tone).toBe('bad');
        expect(integrationNotice('jira', 'exchange-failed')?.message).toContain('exchange-failed');
        expect(integrationNotice('jira', 'exchange-failed')?.tone).toBe('bad');
        expect(integrationNotice(null, null)).toBeNull();
        expect(integrationNotice('github', 'connected')).toBeNull();
    });
});
