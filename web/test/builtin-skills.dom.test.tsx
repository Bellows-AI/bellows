import { ADMIN_ROLE, MEMBER_ROLE, type Role } from '@factory-ai/core';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogSkill } from '../src/api/skills.js';
import { renderApp, stubFetch, type FetchCall, type FetchHandler } from './dom.js';
import { boardHandler, connection, settingsBoard } from './settings-board.js';

/**
 * The Built-in section of the Skills settings page, mounted on its real route over a stubbed board:
 * the catalog read, the admin-only org switch, the connections read behind the "Needs" note and the
 * View of a built-in's files. The routes' answers are server/test-db's.
 */

const CATALOG = '/api/skills';
const SWITCH = /^\/api\/org\/skills\/builtin\/([^/]+)\/enabled$/;
const VIEW = /^\/api\/skills\/builtin\/([^/]+)$/;

const entry = (name: string, overrides: Partial<CatalogSkill> = {}): CatalogSkill => ({
    name,
    description: `The ${name} skill`,
    source: 'builtin',
    requires: { tools: [], connections: [] },
    ...overrides,
});

const needsJira: CatalogSkill['requires'] = {
    tools: [],
    connections: [{ name: 'jira', env: ['JIRA_TOKEN'], selectedBy: 'connections' }],
};

interface Data {
    catalog: CatalogSkill[];
    catalogStatus: number;
    connectionsStatus: number;
    viewStatus: number;
}

const data = (overrides: Partial<Data> = {}): Data => ({
    catalog: [],
    catalogStatus: 200,
    connectionsStatus: 200,
    viewStatus: 200,
    ...overrides,
});

const builtinRoutes =
    (d: Data): FetchHandler =>
    ({ method, url, body }) => {
        if (method === 'GET' && url === CATALOG) {
            return d.catalogStatus === 200
                ? { skills: d.catalog }
                : { status: d.catalogStatus, body: { error: 'the catalog is down' } };
        }
        if (method === 'GET' && url === '/api/connections' && d.connectionsStatus !== 200) {
            return { status: d.connectionsStatus, body: { error: 'connections are down' } };
        }
        const view = VIEW.exec(url);
        if (method === 'GET' && view) {
            if (d.viewStatus !== 200) return { status: d.viewStatus, body: { error: 'the bundle is unreadable' } };
            const found = d.catalog.find((row) => row.name === view[1])!;
            return {
                name: found.name,
                description: found.description,
                requires: found.requires,
                skillMd: `---\nname: ${found.name}\n---\n# ${found.name} source\n`,
                files: [
                    { path: 'SKILL.md', size: 900 },
                    { path: 'scripts/run.sh', size: 2048 },
                ],
                version: '9.9.9',
            };
        }
        const toggle = SWITCH.exec(url);
        if (method === 'PUT' && toggle) {
            const enabled = (body as { enabled: boolean }).enabled;
            const found = d.catalog.find((row) => row.name === toggle[1])!;
            found.switchedOff = !enabled;
            return { name: found.name, enabled };
        }
    };

function mount(role: Role, d: Data, connections = [connection('acme.atlassian.net')]): FetchCall[] {
    return stubFetch(boardHandler(settingsBoard({ role, connections }), builtinRoutes(d)));
}

const panel = async () => {
    const title = await screen.findByRole('heading', { level: 2, name: /^Built-in/ });
    return within(title.closest('section')!);
};

afterEach(cleanup);

describe('the Built-in section', () => {
    it('lists the built-ins only, with a count and the read-only lock line', async () => {
        mount(ADMIN_ROLE, data({ catalog: [entry('factory-git'), entry('mine', { source: 'workspace' })] }));
        renderApp('/settings/skills');

        const builtin = await panel();
        expect(await builtin.findByRole('row', { name: /factory-git/ })).toBeTruthy();
        expect(builtin.queryByText('mine')).toBeNull();
        expect(builtin.getByText('Ships with Bellows · read-only')).toBeTruthy();
        expect(builtin.getByRole('heading', { level: 2 }).textContent).toBe('Built-in1');
    });

    it('a member sees disabled switches; an admin sees live ones', async () => {
        mount(MEMBER_ROLE, data({ catalog: [entry('factory-git')] }));
        renderApp('/settings/skills');
        const row = await (await panel()).findByRole('row', { name: /factory-git/ });
        expect((within(row).getByRole('switch', { name: 'Offer factory-git' }) as HTMLInputElement).disabled).toBe(
            true
        );
        cleanup();

        mount(ADMIN_ROLE, data({ catalog: [entry('factory-git')] }));
        renderApp('/settings/skills');
        const adminRow = await (await panel()).findByRole('row', { name: /factory-git/ });
        expect((within(adminRow).getByRole('switch', { name: 'Offer factory-git' }) as HTMLInputElement).disabled).toBe(
            false
        );
    });

    it('switching off asks first and sends no PUT until the confirm; the body is {enabled:false}', async () => {
        const calls = mount(ADMIN_ROLE, data({ catalog: [entry('factory-git')] }));
        const user = userEvent.setup();
        renderApp('/settings/skills');

        const row = await (await panel()).findByRole('row', { name: /factory-git/ });
        await user.click(within(row).getByRole('switch', { name: 'Offer factory-git' }));

        const dialog = await screen.findByRole('dialog', { name: 'Switch off “factory-git” for the organization?' });
        expect(calls.filter(({ method }) => method === 'PUT')).toHaveLength(0);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(calls.filter(({ method }) => method === 'PUT')).toHaveLength(0);

        await user.click(within(row).getByRole('switch', { name: 'Offer factory-git' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Switch off' }));

        const puts = calls.filter(({ method }) => method === 'PUT');
        expect(puts).toHaveLength(1);
        expect(puts[0]!.url).toBe('/api/org/skills/builtin/factory-git/enabled');
        expect(puts[0]!.body).toEqual({ enabled: false });
        expect(await screen.findByText('Hidden from tasks · Switched off')).toBeTruthy();
        expect(calls.filter(({ method, url }) => method === 'GET' && url === CATALOG).length).toBeGreaterThan(1);
    });

    it('switching on writes at once, with no dialog', async () => {
        const calls = mount(ADMIN_ROLE, data({ catalog: [entry('factory-git', { switchedOff: true })] }));
        const user = userEvent.setup();
        renderApp('/settings/skills');

        const row = await (await panel()).findByRole('row', { name: /factory-git/ });
        await user.click(within(row).getByRole('switch', { name: 'Offer factory-git' }));

        await screen.findByRole('row', { name: /factory-git/ });
        expect(screen.queryByRole('dialog')).toBeNull();
        const puts = calls.filter(({ method }) => method === 'PUT');
        expect(puts).toHaveLength(1);
        expect(puts[0]!.body).toEqual({ enabled: true });
        expect(screen.queryByText('Hidden from tasks · Switched off')).toBeNull();
    });

    it('View shows SKILL.md, the files and the release that ships it', async () => {
        mount(MEMBER_ROLE, data({ catalog: [entry('factory-git')] }));
        const user = userEvent.setup();
        renderApp('/settings/skills');

        const row = await (await panel()).findByRole('row', { name: /factory-git/ });
        await user.click(within(row).getByRole('button', { name: 'View' }));

        expect(await screen.findByText(/ships with Bellows v9\.9\.9/)).toBeTruthy();
        expect(screen.getByText(/# factory-git source/)).toBeTruthy();
        expect(screen.getByText('scripts/run.sh')).toBeTruthy();
    });

    it('a failed view read is an alert, never an empty view', async () => {
        mount(ADMIN_ROLE, data({ catalog: [entry('factory-git')], viewStatus: 503 }));
        const user = userEvent.setup();
        renderApp('/settings/skills');

        const row = await (await panel()).findByRole('row', { name: /factory-git/ });
        await user.click(within(row).getByRole('button', { name: 'View' }));

        expect((await screen.findByText(/the bundle is unreadable/)).getAttribute('role')).toBe('alert');
        expect(screen.queryByText(/ships with Bellows/)).toBeNull();
    });

    it('a failed /api/skills is an alert, not an empty table', async () => {
        mount(ADMIN_ROLE, data({ catalogStatus: 503 }));
        renderApp('/settings/skills');

        const builtin = await panel();
        expect((await builtin.findByText(/the catalog is down/)).getAttribute('role')).toBe('alert');
        expect(builtin.queryByRole('table')).toBeNull();
    });

    it('Jira not connected: the row says Needs Jira and the section links to Integrations', async () => {
        mount(ADMIN_ROLE, data({ catalog: [entry('factory-jira', { requires: needsJira })] }), []);
        renderApp('/settings/skills');

        const builtin = await panel();
        const row = await builtin.findByRole('row', { name: /factory-jira/ });
        expect(within(row).getByText('Hidden from tasks · Needs Jira')).toBeTruthy();
        expect(within(row).getByText('Jira not connected')).toBeTruthy();
        expect(builtin.getByRole('link', { name: /Set up in Integrations/ }).getAttribute('href')).toBe(
            '/settings/integrations'
        );
    });

    it('Jira connected: no note', async () => {
        mount(ADMIN_ROLE, data({ catalog: [entry('factory-jira', { requires: needsJira })] }));
        renderApp('/settings/skills');

        const row = await (await panel()).findByRole('row', { name: /factory-jira/ });
        expect(within(row).queryByText(/Hidden from tasks/)).toBeNull();
    });

    it('a failed /api/connections shows no Needs note and says so', async () => {
        mount(
            ADMIN_ROLE,
            data({ catalog: [entry('factory-jira', { requires: needsJira })], connectionsStatus: 503 }),
            []
        );
        renderApp('/settings/skills');

        const builtin = await panel();
        const row = await builtin.findByRole('row', { name: /factory-jira/ });
        expect(within(row).queryByText(/Hidden from tasks/)).toBeNull();
        expect(await builtin.findByText(/connection status could not be read/i)).toBeTruthy();
        expect(builtin.queryByRole('link', { name: /Set up in Integrations/ })).toBeNull();
    });
});
