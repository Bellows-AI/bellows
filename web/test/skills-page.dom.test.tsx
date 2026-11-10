import { ADMIN_ROLE, MEMBER_ROLE, type Role } from '@factory-ai/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillDoor, StoredSkill } from '../src/api/skills.js';
import { RUNTIME_PRECEDENCE_NOTE } from '../src/pages/SettingsSkillsPage.js';
import { renderApp, stubFetch, type FetchCall, type FetchHandler } from './dom.js';
import { boardHandler, settingsBoard } from './settings-board.js';

/**
 * The Skills settings page mounted on its real route over a stubbed board: the My workspace and
 * Organization sections. The routes' answers are server/test-db's; the browser half is the later
 * e2e spec. A skill is the wire row, so a malformed one is the API client's concern, not this file's.
 */

type User = ReturnType<typeof userEvent.setup>;

const ORG = '/api/org/skills';
const WORKSPACE = '/api/workspace/skills';

let nextId = 0;
const uuid = () => `00000000-0000-4000-8000-${(++nextId).toString().padStart(12, '0')}`;

const skill = (door: SkillDoor, name: string, overrides: Partial<StoredSkill> = {}): StoredSkill => ({
    id: uuid(),
    name,
    scope: door,
    enabled: true,
    createdBy: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-06T10:00:00.000Z',
    current: {
        id: uuid(),
        sha256: `9f3c2a1${'0'.repeat(57)}`,
        size: 2100,
        description: `The ${name} skill`,
        createdAt: '2026-11-06T10:00:00.000Z',
        author: { id: uuid(), login: 'maria' },
    },
    ...overrides,
});

interface Store {
    org: StoredSkill[];
    workspace: StoredSkill[];
    /** A door whose list read answers 503. */
    failing: SkillDoor[];
    /** The status the next write answers instead of succeeding, with its body. */
    refuseWrites: { status: number; body: unknown } | null;
}

const store = (overrides: Partial<Store> = {}): Store => ({
    org: [],
    workspace: [],
    failing: [],
    refuseWrites: null,
    ...overrides,
});

const DOOR_PATH = /^\/api\/(org|workspace)\/skills(?:\/([^/]+))?(?:\/(enabled|scope|zip|versions))?$/;

/** The skills routes over `data`, stateful enough that a write is visible to the next read. */
const skillsRoutes =
    (data: Store): FetchHandler =>
    ({ method, url, body }) => {
        if (method === 'GET' && url === '/api/skills') return { skills: [] };
        const match = DOOR_PATH.exec(url);
        if (!match) return;
        const door = match[1] as SkillDoor;
        const id = match[2];
        const rest = match[3];
        const rows = data[door];
        if (id === undefined) {
            if (method !== 'GET') return;
            return data.failing.includes(door)
                ? { status: 503, body: { error: 'the store is down' } }
                : { skills: rows };
        }
        const index = rows.findIndex((row) => row.id === id);
        if (method === 'GET' && rest === undefined) {
            if (index < 0) return { status: 404, body: { error: 'No such skill', code: 'SKILL_NOT_FOUND' } };
            return {
                skill: rows[index],
                skillMd: `---\nname: ${rows[index]!.name}\n---\n# ${rows[index]!.name}\n`,
                files: [
                    { path: 'SKILL.md', size: 2100 },
                    { path: 'templates/notes.md', size: 640 },
                ],
            };
        }
        if (data.refuseWrites) return data.refuseWrites;
        if (index < 0) return { status: 404, body: { error: 'No such skill', code: 'SKILL_NOT_FOUND' } };
        const row = rows[index]!;
        if (method === 'PUT' && rest === 'enabled') {
            row.enabled = (body as { enabled: boolean }).enabled;
            return { skill: row };
        }
        if (method === 'DELETE') {
            rows.splice(index, 1);
            return { status: 204 };
        }
        if (method === 'POST' && rest === 'scope') {
            rows.splice(index, 1);
            const moved = { ...row, scope: 'org' as const };
            data.org.push(moved);
            return { skill: moved };
        }
    };

function mount(role: Role, data: Store): FetchCall[] {
    return stubFetch(boardHandler(settingsBoard({ role }), skillsRoutes(data)));
}

const panelOf = async (heading: RegExp) => {
    const title = await screen.findByRole('heading', { level: 2, name: heading });
    return within(title.closest('section')!);
};

const writes = (calls: FetchCall[]) => calls.filter(({ method }) => method !== 'GET');
const reads = (calls: FetchCall[], url: string) => calls.filter(({ method, url: u }) => method === 'GET' && u === url);

async function pick(user: User, panel: ReturnType<typeof within>, rowName: string, item: string) {
    await user.click(await panel.findByRole('button', { name: `Actions for ${rowName}` }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: item }));
}

describe('the Skills page', () => {
    afterEach(cleanup);

    it('lives at /settings/skills with one h1, the settings eyebrow and a nav entry before Executors', async () => {
        mount(ADMIN_ROLE, store());
        renderApp('/settings/skills');

        expect(await screen.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
        expect(links.indexOf('/settings/skills')).toBeGreaterThan(links.indexOf('/settings/repos'));
        expect(links.indexOf('/settings/skills')).toBeLessThan(links.indexOf('/settings/executors'));
    });

    it('About skills states the runtime limit verbatim, and the strip says which skill wins', async () => {
        mount(ADMIN_ROLE, store());
        renderApp('/settings/skills');

        const about = (await screen.findByText('About skills')).closest('details')!;
        expect(about.textContent).toContain(RUNTIME_PRECEDENCE_NOTE);
        expect(RUNTIME_PRECEDENCE_NOTE).toMatch(/repository skill/);
        expect(RUNTIME_PRECEDENCE_NOTE).toMatch(/claude-code/);
        expect(RUNTIME_PRECEDENCE_NOTE).toMatch(/opencode/);
        const strip = screen.getByLabelText('Which skill wins when two have the same name');
        expect(strip.textContent).toBe(
            'When two skills share a name, the one further right wins: Built-in›Organization›Repository›My workspace'
        );
    });

    it('lists My workspace then Organization, each with a count, exactly the mock columns (no Needs)', async () => {
        mount(ADMIN_ROLE, store({ org: [skill('org', 'db-migrations')], workspace: [skill('workspace', 'my-style')] }));
        renderApp('/settings/skills');

        const headings = (await screen.findAllByRole('heading', { level: 2 })).map((h) => h.textContent);
        expect(headings.indexOf('My workspace1')).toBeLessThan(headings.indexOf('Organization1'));
        for (const name of [/^My workspace/, /^Organization/]) {
            const panel = await panelOf(name);
            expect(panel.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
                'Name',
                'Description',
                'Version',
                'Enabled',
                'Actions',
            ]);
        }
    });

    it('the version cell is sha · date with no author; View shows "by <login>"', async () => {
        const user = userEvent.setup();
        mount(ADMIN_ROLE, store({ org: [skill('org', 'db-migrations')] }));
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        const row = await org.findByRole('row', { name: /db-migrations/ });
        expect(within(row).getByText('9f3c2a1 · 2026-11-06')).toBeTruthy();
        expect(row.textContent).not.toContain('maria');

        await pick(user, org, 'db-migrations', 'View SKILL.md and files');
        expect(await org.findByText(/Updated 2026-11-06 by maria/)).toBeTruthy();
        expect(org.getByText('Version 9f3c2a1')).toBeTruthy();
        expect(org.getByText('2 files')).toBeTruthy();
        expect(org.getByText('templates/notes.md')).toBeTruthy();
    });

    it('a member sees Organization read-only: disabled switch, View only, no Edit and no New', async () => {
        mount(MEMBER_ROLE, store({ org: [skill('org', 'db-migrations')], workspace: [skill('workspace', 'mine')] }));
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        const row = await org.findByRole('row', { name: /db-migrations/ });
        expect((within(row).getByRole('switch', { name: 'Enable db-migrations' }) as HTMLInputElement).disabled).toBe(
            true
        );
        expect(within(row).getByRole('button', { name: 'View' })).toBeTruthy();
        expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
        expect(org.queryByRole('button', { name: /New skill/ })).toBeNull();
        expect(org.queryByRole('button', { name: /Upload \.zip/ })).toBeNull();

        // The member's own workspace is theirs to write.
        const mine = await panelOf(/^My workspace/);
        expect(mine.getByRole('button', { name: /New skill/ })).toBeTruthy();
        expect(mine.getByRole('button', { name: 'Edit' })).toBeTruthy();
    });

    it('an unknown session counts as a member: the Organization writer actions never render', async () => {
        stubFetch((call) =>
            call.url === '/api/auth/me'
                ? { status: 503, body: { error: 'down' } }
                : skillsRoutes(store({ org: [skill('org', 'db-migrations')] }))(call)
        );
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        await org.findByRole('row', { name: /db-migrations/ });
        expect(org.queryByRole('button', { name: /New skill/ })).toBeNull();
        expect(org.queryByRole('button', { name: 'Edit' })).toBeNull();
    });

    it('an admin sees the writer actions, and Promote only on a workspace row', async () => {
        const user = userEvent.setup();
        mount(ADMIN_ROLE, store({ org: [skill('org', 'db-migrations')], workspace: [skill('workspace', 'mine')] }));
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        expect(await org.findByRole('button', { name: /Upload \.zip/ })).toBeTruthy();
        expect(org.getByRole('button', { name: /New skill/ })).toBeTruthy();
        expect(org.getByRole('button', { name: 'Edit' })).toBeTruthy();
        await user.click(org.getByRole('button', { name: 'Actions for db-migrations' }));
        const orgMenu = within(await screen.findByRole('menu'));
        expect(orgMenu.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
            'View SKILL.md and files',
            'Upload new version (.zip)',
            'Download .zip',
            'Delete',
        ]);
        await user.keyboard('{Escape}');

        const mine = await panelOf(/^My workspace/);
        await user.click(await mine.findByRole('button', { name: 'Actions for mine' }));
        expect(
            within(await screen.findByRole('menu'))
                .getAllByRole('menuitem')
                .map((i) => i.textContent)
        ).toEqual([
            'View SKILL.md and files',
            'Upload new version (.zip)',
            'Promote to organization',
            'Download .zip',
            'Delete',
        ]);
    });

    it('a member has no Promote in their workspace menu', async () => {
        const user = userEvent.setup();
        mount(MEMBER_ROLE, store({ workspace: [skill('workspace', 'mine')] }));
        renderApp('/settings/skills');

        const mine = await panelOf(/^My workspace/);
        await user.click(await mine.findByRole('button', { name: 'Actions for mine' }));
        const items = within(await screen.findByRole('menu'))
            .getAllByRole('menuitem')
            .map((i) => i.textContent);
        expect(items).not.toContain('Promote to organization');
    });

    it('a failed workspace read is an alert, never "No skills yet"; Organization still lists', async () => {
        mount(ADMIN_ROLE, store({ failing: ['workspace'], org: [skill('org', 'db-migrations')] }));
        renderApp('/settings/skills');

        const mine = await panelOf(/^My workspace/);
        const alert = await mine.findByRole('alert');
        expect(alert.textContent).toContain('the store is down');
        expect(mine.queryByText(/No skills yet/)).toBeNull();
        const org = await panelOf(/^Organization/);
        expect(await org.findByRole('row', { name: /db-migrations/ })).toBeTruthy();
    });

    it('a confirmed empty list says "No skills yet"', async () => {
        mount(ADMIN_ROLE, store());
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        expect(await org.findByText('No skills yet.')).toBeTruthy();
    });

    it('a shadowed org row shows the pill and the note; the personal row never does', async () => {
        mount(
            ADMIN_ROLE,
            store({
                org: [skill('org', 'release-notes'), skill('org', 'db-migrations')],
                workspace: [skill('workspace', 'release-notes')],
            })
        );
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        const shadowed = await org.findByRole('row', { name: /release-notes/ });
        expect(within(shadowed).getByText('Shadowed for you')).toBeTruthy();
        expect(within(shadowed).getByText('Not used in your tasks: your own “release-notes” wins.')).toBeTruthy();
        expect(
            within(await org.findByRole('row', { name: /db-migrations/ })).queryByText('Shadowed for you')
        ).toBeNull();
        const mine = await panelOf(/^My workspace/);
        expect(mine.queryByText('Shadowed for you')).toBeNull();
    });

    it('a switched-off personal skill that would shadow does not shadow, and a switched-off row says so', async () => {
        mount(
            ADMIN_ROLE,
            store({
                org: [skill('org', 'release-notes', { enabled: false })],
                workspace: [skill('workspace', 'release-notes', { enabled: false })],
            })
        );
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        const row = await org.findByRole('row', { name: /release-notes/ });
        expect(within(row).queryByText('Shadowed for you')).toBeNull();
        expect(within(row).getByText('Hidden from tasks · Switched off')).toBeTruthy();
    });

    it('Delete asks before any DELETE is sent, and a confirmed one re-reads the list', async () => {
        const user = userEvent.setup();
        const calls = mount(ADMIN_ROLE, store({ org: [skill('org', 'db-migrations')] }));
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        await org.findByRole('row', { name: /db-migrations/ });
        await pick(user, org, 'db-migrations', 'Delete');

        const dialog = await screen.findByRole('dialog', { name: 'Delete “db-migrations”?' });
        expect(dialog.textContent).toContain('Every member loses this skill on new tasks');
        expect(writes(calls)).toHaveLength(0);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(writes(calls)).toHaveLength(0);

        await pick(user, org, 'db-migrations', 'Delete');
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete skill' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(writes(calls)).toEqual([expect.objectContaining({ method: 'DELETE' })]);
        expect(await org.findByText('No skills yet.')).toBeTruthy();
        expect(reads(calls, ORG)).toHaveLength(2);
    });

    it('Promote confirms, moves the row to the organization and re-reads both lists', async () => {
        const user = userEvent.setup();
        const calls = mount(ADMIN_ROLE, store({ workspace: [skill('workspace', 'mine')] }));
        renderApp('/settings/skills');

        const mine = await panelOf(/^My workspace/);
        await mine.findByRole('row', { name: /mine/ });
        await pick(user, mine, 'mine', 'Promote to organization');
        const dialog = await screen.findByRole('dialog', { name: 'Promote “mine” to the organization?' });
        expect(writes(calls)).toHaveLength(0);
        await user.click(within(dialog).getByRole('button', { name: 'Promote' }));

        const org = await panelOf(/^Organization/);
        expect(await org.findByRole('row', { name: /mine/ })).toBeTruthy();
        expect(writes(calls)).toEqual([expect.objectContaining({ method: 'POST', body: { scope: 'org' } })]);
        expect(reads(calls, ORG)).toHaveLength(2);
        expect(reads(calls, WORKSPACE)).toHaveLength(2);
    });

    it('Promote of a name the organization already holds says so and sends nothing', async () => {
        const user = userEvent.setup();
        const calls = mount(
            ADMIN_ROLE,
            store({ org: [skill('org', 'release-notes')], workspace: [skill('workspace', 'release-notes')] })
        );
        renderApp('/settings/skills');

        const mine = await panelOf(/^My workspace/);
        await mine.findByRole('row', { name: /release-notes/ });
        await pick(user, mine, 'release-notes', 'Promote to organization');
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain('An organization skill already has this name');
        expect((within(dialog).getByRole('button', { name: 'Promote' }) as HTMLButtonElement).disabled).toBe(true);
        expect(writes(calls)).toHaveLength(0);
    });

    it('a Promote 409 from the board shows the same sentence in the dialog', async () => {
        const user = userEvent.setup();
        const data = store({ workspace: [skill('workspace', 'mine')] });
        data.refuseWrites = {
            status: 409,
            body: { error: 'An organization skill already has this name', code: 'NAME_TAKEN' },
        };
        mount(ADMIN_ROLE, data);
        renderApp('/settings/skills');

        const mine = await panelOf(/^My workspace/);
        await mine.findByRole('row', { name: /mine/ });
        await pick(user, mine, 'mine', 'Promote to organization');
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Promote' }));

        expect((await screen.findByRole('alert')).textContent).toContain('An organization skill already has this name');
        expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('a toggle sends the new state, then re-reads the list', async () => {
        const user = userEvent.setup();
        const data = store({ org: [skill('org', 'db-migrations')] });
        const calls = mount(ADMIN_ROLE, data);
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        await user.click(await org.findByRole('switch', { name: 'Enable db-migrations' }));

        await waitFor(() => expect(reads(calls, ORG)).toHaveLength(2));
        expect(writes(calls)).toEqual([expect.objectContaining({ method: 'PUT', body: { enabled: false } })]);
        const row = await org.findByRole('row', { name: /db-migrations/ });
        expect(within(row).getByText('Hidden from tasks · Switched off')).toBeTruthy();
        expect(await org.findByText('Disabled “db-migrations”.')).toBeTruthy();
    });

    it('a 404 on a write re-reads the list and says the skill is gone', async () => {
        const user = userEvent.setup();
        const data = store({ org: [skill('org', 'db-migrations')] });
        const calls = mount(ADMIN_ROLE, data);
        renderApp('/settings/skills');

        const org = await panelOf(/^Organization/);
        const toggle = await org.findByRole('switch', { name: 'Enable db-migrations' });
        data.org.length = 0; // deleted in another tab
        await user.click(toggle);

        expect(await org.findByText('“db-migrations” no longer exists.')).toBeTruthy();
        await waitFor(() => expect(reads(calls, ORG)).toHaveLength(2));
        expect(await org.findByText('No skills yet.')).toBeTruthy();
    });
});
