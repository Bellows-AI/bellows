import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ORG_CONNECTION_SCOPE, USER_CONNECTION_SCOPE, type ConnectionView } from '../src/api/connections.js';
import { SCOPED_TOKEN_HINT } from '../src/components/JiraConnectionDialog.js';
import {
    ADD_CONNECTION_LABEL,
    DEFAULT_CONNECTION_CAPTION,
    JiraConnectionsPanel,
    NO_CONNECTIONS_NOTE,
} from '../src/panels/JiraConnectionsPanel.js';

const connection = (site: string, overrides: Partial<ConnectionView> = {}): ConnectionView => ({
    id: `00000000-0000-4000-8000-${site.length.toString().padStart(12, '0')}`,
    provider: 'jira',
    credential: 'legacy_api_token',
    ownership: 'legacy-org',
    principal: null,
    site,
    account: `bot@${site}`,
    access: 'read',
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
});

const render = (props: Partial<Parameters<typeof JiraConnectionsPanel>[0]> = {}) =>
    renderToStaticMarkup(
        <JiraConnectionsPanel
            scope={ORG_CONNECTION_SCOPE}
            hint="hint"
            connections={[connection('new.atlassian.net'), connection('older-site.atlassian.net')]}
            canManage
            saving={false}
            onCreate={async () => null}
            onDelete={() => {}}
            {...props}
        />
    );

describe('the Jira connections panel', () => {
    it('lists site, account, credential, access and created date', () => {
        const html = render();
        expect(html).toContain('new.atlassian.net');
        expect(html).toContain('bot@older-site.atlassian.net');
        expect(html).toContain('data-label="Account"');
        expect(html).toContain('data-label="Access"');
        expect(html).not.toContain('2026-09-01T00:00:00.000Z');
    });

    it('labels a legacy org row as a shared legacy API token, never as personal OAuth', () => {
        const html = render();
        expect(html).toContain('data-label="Credential"');
        expect(html.match(/Legacy API token/g)).toHaveLength(2);
        expect(html.match(/Shared \(legacy\)/g)).toHaveLength(2);
        expect(html).not.toMatch(/OAuth/);
    });

    it('labels a personal OAuth row as OAuth, and marks only a lone personal connection as the default', () => {
        const oauth = connection('oauth.atlassian.net', {
            ownership: 'personal',
            principal: 'self',
            credential: 'oauth_grant',
        });
        const lone = render({ scope: USER_CONNECTION_SCOPE, connections: [oauth] });
        expect(lone).toContain('OAuth');
        expect(lone).not.toContain('Shared (legacy)');
        expect(lone.match(new RegExp(DEFAULT_CONNECTION_CAPTION, 'g'))).toHaveLength(1);
        const two = render({ scope: USER_CONNECTION_SCOPE, connections: [oauth, connection('b.atlassian.net')] });
        expect(two).not.toContain(DEFAULT_CONNECTION_CAPTION);
        expect(render()).not.toContain(DEFAULT_CONNECTION_CAPTION);
    });

    it('gives an admin the add button in the panel head and a disconnect per row, with the form kept in the dialog', () => {
        const html = render();
        expect(html).toMatch(new RegExp(`class="panel-head">.*${ADD_CONNECTION_LABEL}</button>`));
        // The fields live in the closed dialog, never inline in the panel.
        expect(html).not.toContain('<input');
        expect(html.match(/>Disconnect<\/button>/g)).toHaveLength(2);
    });

    it('hides every control from a member, who still reads the list', () => {
        const html = render({ canManage: false });
        expect(html).toContain('new.atlassian.net');
        expect(html).not.toContain(ADD_CONNECTION_LABEL);
        expect(html).not.toContain('<input');
        expect(html).not.toContain('Disconnect');
    });

    it('says so when the list is empty, and never renders a token', () => {
        const html = render({ connections: [], scope: USER_CONNECTION_SCOPE });
        expect(html).toContain(NO_CONNECTIONS_NOTE);
        expect(html).not.toMatch(/apiToken|api_token/);
    });

    it('disables the add button and every disconnect while a write is in flight', () => {
        const html = render({ saving: true });
        expect(html.match(/<button[^>]*disabled/g)).toHaveLength(3);
    });
});

/** The add dialog portals: its fields and in-dialog refusal are web/test/jira-connections.dom.test.tsx's. */
describe('the Jira connection dialog copy', () => {
    it('asks for a scoped service-account token', () => {
        expect(SCOPED_TOKEN_HINT).toMatch(/scoped \(service-account\) token/);
    });
});
