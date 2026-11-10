import { ADMIN_ROLE, MAX_SKILL_BYTES, MAX_SKILL_FILE_BYTES, MAX_SKILL_FILES } from '@factory-ai/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { SkillDoor, StoredSkill } from '../src/api/skills.js';
import { renderApp, stubFetch, type FetchCall, type FetchHandler } from './dom.js';
import { boardHandler, settingsBoard } from './settings-board.js';

/**
 * The Skills page's inline editor over a stubbed board: write SKILL.md, upload a .zip, edit, upload a new
 * version, and the unsaved-changes guard. The routes' answers are server/test-db's; this file holds what the
 * browser sends and how a refusal reads.
 */

type User = ReturnType<typeof userEvent.setup>;

const WORKSPACE = '/api/workspace/skills';
const MIB = 1024 * 1024;

let nextId = 0;
const uuid = () => `00000000-0000-4000-8000-${(++nextId).toString().padStart(12, '0')}`;

const skill = (door: SkillDoor, name: string): StoredSkill => ({
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
        author: null,
    },
});

interface Store {
    rows: StoredSkill[];
    /** The answer the next write gets instead of success. */
    refuse: { status: number; body: unknown } | null;
}

const MD = (name: string) => `---\nname: ${name}\ndescription: Stored\n---\n# ${name}\n`;

const routes =
    (data: Store): FetchHandler =>
    ({ method, url }) => {
        if (url === '/api/org/skills') return { skills: [] };
        if (url === WORKSPACE && method === 'GET') return { skills: data.rows };
        const item = /^\/api\/workspace\/skills\/([^/?]+)(\/versions)?$/.exec(url);
        if (item && method === 'GET') {
            const row = data.rows.find((r) => r.id === item[1]);
            return row
                ? { skill: row, skillMd: MD(row.name), files: [{ path: 'SKILL.md', size: 90 }] }
                : { status: 404, body: { error: 'No such skill', code: 'SKILL_NOT_FOUND' } };
        }
        if (method === 'POST' && url.startsWith(WORKSPACE)) {
            if (data.refuse) return data.refuse;
            const row = data.rows.find((r) => item && r.id === item[1]) ?? skill('workspace', 'from-zip');
            return { skill: row };
        }
    };

function mount(data: Store): FetchCall[] {
    return stubFetch(boardHandler(settingsBoard({ role: ADMIN_ROLE }), routes(data)));
}

const store = (rows: StoredSkill[] = [], refuse: Store['refuse'] = null): Store => ({ rows, refuse });
const writes = (calls: FetchCall[]) => calls.filter(({ method }) => method !== 'GET');

const panelOf = async (heading: RegExp) => {
    const title = await screen.findByRole('heading', { level: 2, name: heading });
    return within(title.closest('section')!);
};

async function openNew(user: User) {
    const mine = await panelOf(/^My workspace/);
    await user.click(await mine.findByRole('button', { name: 'New skill' }));
    return within(await screen.findByRole('region', { name: 'New skill' }));
}

async function openEdit(user: User, name: string) {
    const mine = await panelOf(/^My workspace/);
    await user.click(
        within(await mine.findByRole('row', { name: new RegExp(name) })).getByRole('button', { name: 'Edit' })
    );
    return within(await screen.findByRole('region', { name: `Edit ${name}` }));
}

const zipFile = (name = 'bundle.zip') => new File([new Uint8Array([80, 75, 3, 4])], name, { type: 'application/zip' });

describe('the Skills inline editor', () => {
    afterEach(cleanup);

    it('an inline create sends {name, skillMd} and closes the editor', async () => {
        const user = userEvent.setup();
        const calls = mount(store());
        renderApp('/settings/skills');

        const editor = await openNew(user);
        expect((editor.getByRole('button', { name: 'Create skill' }) as HTMLButtonElement).disabled).toBe(true);
        await user.type(editor.getByLabelText('Name'), 'ship-it');
        await user.click(editor.getByRole('button', { name: 'Create skill' }));

        await waitFor(() => expect(writes(calls)).toHaveLength(1));
        const [post] = writes(calls);
        expect(post!.method).toBe('POST');
        expect(post!.url).toBe(WORKSPACE);
        const body = post!.body as { name: string; skillMd: string };
        expect(body.name).toBe('ship-it');
        expect(body.skillMd).toContain('name: ship-it');
        await waitFor(() => expect(screen.queryByRole('region', { name: 'New skill' })).toBeNull());
    });

    it('a 422 shows the server reason inline and keeps the draft', async () => {
        const user = userEvent.setup();
        const data = store([], {
            status: 422,
            body: { error: 'The skill bundle is invalid', code: 'SKILL_BUNDLE_INVALID', reason: 'name_mismatch' },
        });
        mount(data);
        renderApp('/settings/skills');

        const editor = await openNew(user);
        await user.type(editor.getByLabelText('Name'), 'ship-it');
        await user.click(editor.getByRole('button', { name: 'Create skill' }));

        const alert = await editor.findByRole('alert');
        expect(alert.textContent).toContain('The skill bundle is invalid');
        expect(alert.textContent).toContain('name_mismatch');
        expect((editor.getByLabelText('Name') as HTMLInputElement).value).toBe('ship-it');
        expect((editor.getByLabelText('SKILL.md') as HTMLTextAreaElement).value).toContain('name: ship-it');
    });

    it('a 409 NAME_TAKEN says the name is taken', async () => {
        const user = userEvent.setup();
        mount(store([], { status: 409, body: { error: 'A skill named "x" already exists', code: 'NAME_TAKEN' } }));
        renderApp('/settings/skills');

        const editor = await openNew(user);
        await user.type(editor.getByLabelText('Name'), 'ship-it');
        await user.click(editor.getByRole('button', { name: 'Create skill' }));

        expect((await editor.findByRole('alert')).textContent).toMatch(/already (exists|taken)|is taken/);
    });

    it('an edit pre-fills SKILL.md, locks the name, and sends baseVersionId', async () => {
        const user = userEvent.setup();
        const row = skill('workspace', 'mine');
        const calls = mount(store([row]));
        renderApp('/settings/skills');

        const editor = await openEdit(user, 'mine');
        const name = editor.getByLabelText('Name') as HTMLInputElement;
        expect(name.readOnly).toBe(true);
        const textarea = (await editor.findByDisplayValue(/# mine/)) as HTMLTextAreaElement;
        expect(editor.queryByRole('tab')).toBeNull();
        expect(editor.queryByRole('button', { name: 'Save new version' })).toBeNull();

        await user.type(textarea, 'more');
        expect(editor.getByText('Unsaved changes')).toBeTruthy();
        await user.click(editor.getByRole('button', { name: 'Save new version' }));

        await waitFor(() => expect(writes(calls)).toHaveLength(1));
        const [post] = writes(calls);
        expect(post!.url).toBe(`${WORKSPACE}/${row.id}/versions`);
        expect(post!.body).toEqual({ skillMd: `${MD('mine')}more`, baseVersionId: row.current.id });
    });

    it('a stale 409 tells the reader to reload', async () => {
        const user = userEvent.setup();
        const row = skill('workspace', 'mine');
        mount(
            store([row], {
                status: 409,
                body: { error: 'The skill changed', code: 'SKILL_VERSION_STALE' },
            })
        );
        renderApp('/settings/skills');

        const editor = await openEdit(user, 'mine');
        await user.type(await editor.findByDisplayValue(/# mine/), 'x');
        await user.click(editor.getByRole('button', { name: 'Save new version' }));

        expect((await editor.findByRole('alert')).textContent).toMatch(/changed since you opened it/i);
        expect(editor.getByRole('button', { name: 'Reload' })).toBeTruthy();
    });

    it('leaving while dirty asks first; Continue editing keeps the draft', async () => {
        const user = userEvent.setup();
        mount(store());
        renderApp('/settings/skills');

        const editor = await openNew(user);
        await user.type(editor.getByLabelText('Name'), 'ship-it');
        await user.click(document.querySelector('a[href="/tasks"]') as HTMLElement);

        expect((await screen.findAllByText('Discard unsaved changes?')).length).toBeGreaterThan(0);
        await user.click(screen.getByRole('button', { name: 'Continue editing' }));
        expect((editor.getByLabelText('Name') as HTMLInputElement).value).toBe('ship-it');
    });

    it('opening another row’s editor while dirty asks first', async () => {
        const user = userEvent.setup();
        const rows = [skill('workspace', 'one'), skill('workspace', 'two')];
        mount(store(rows));
        renderApp('/settings/skills');

        const editor = await openEdit(user, 'one');
        await user.type(await editor.findByDisplayValue(/# one/), 'x');
        const mine = await panelOf(/^My workspace/);
        await user.click(within(mine.getByRole('row', { name: /two/ })).getByRole('button', { name: 'Edit' }));

        expect((await screen.findAllByText('Discard unsaved changes?')).length).toBeGreaterThan(0);
        await user.click(screen.getByRole('button', { name: 'Continue editing' }));
        expect(screen.queryByRole('region', { name: 'Edit two' })).toBeNull();
        expect(screen.getByRole('region', { name: 'Edit one' })).toBeTruthy();
    });

    it('Cancel on a clean draft closes the editor without asking', async () => {
        const user = userEvent.setup();
        mount(store());
        renderApp('/settings/skills');

        const editor = await openNew(user);
        await user.click(editor.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('region', { name: 'New skill' })).toBeNull();
        expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
    });
});

describe('the Skills zip upload', () => {
    afterEach(cleanup);

    async function openZip(user: User) {
        const mine = await panelOf(/^My workspace/);
        await user.click(await mine.findByRole('button', { name: 'Upload .zip' }));
        return within(await screen.findByRole('region', { name: 'New skill' }));
    }

    it('the limits line is read from the core constants', async () => {
        const user = userEvent.setup();
        mount(store());
        renderApp('/settings/skills');

        const editor = await openZip(user);
        expect(
            editor.getByText(
                `SKILL.md at the root · up to ${MAX_SKILL_FILES} files · ${MAX_SKILL_BYTES / MIB} MiB total, ${MAX_SKILL_FILE_BYTES / MIB} MiB per file`
            )
        ).toBeTruthy();
    });

    it('posts application/zip with no ?name= and shows the name the server chose', async () => {
        const user = userEvent.setup();
        const calls = mount(store());
        renderApp('/settings/skills');

        const editor = await openZip(user);
        await user.upload(editor.getByLabelText('Choose a .zip file'), zipFile());

        await waitFor(() => expect(writes(calls)).toHaveLength(1));
        const [post] = writes(calls);
        expect(post!.url).toBe(WORKSPACE);
        expect(post!.headers['content-type']).toBe('application/zip');
        expect(await editor.findByText(/Added “from-zip”/)).toBeTruthy();
    });

    it('a bad_frontmatter refusal shows inline with the file name', async () => {
        const user = userEvent.setup();
        mount(
            store([], {
                status: 422,
                body: { error: 'The skill bundle is invalid', code: 'SKILL_BUNDLE_INVALID', reason: 'bad_frontmatter' },
            })
        );
        renderApp('/settings/skills');

        const editor = await openZip(user);
        await user.upload(editor.getByLabelText('Choose a .zip file'), zipFile('broken.zip'));

        const alert = await editor.findByRole('alert');
        expect(alert.textContent).toContain('bad_frontmatter');
        expect(editor.getByText('broken.zip')).toBeTruthy();
    });

    it('the write tab and the zip tab switch inside a new-skill editor', async () => {
        const user = userEvent.setup();
        mount(store());
        renderApp('/settings/skills');

        const editor = await openNew(user);
        await user.click(editor.getByRole('tab', { name: 'Upload .zip' }));
        expect(editor.getByLabelText('Choose a .zip file')).toBeTruthy();
        await user.click(editor.getByRole('tab', { name: 'Write SKILL.md' }));
        expect(editor.getByLabelText('SKILL.md')).toBeTruthy();
    });

    it('Upload new version (.zip) posts the file to the skill’s versions route', async () => {
        const user = userEvent.setup();
        const row = skill('workspace', 'mine');
        const calls = mount(store([row]));
        renderApp('/settings/skills');

        const mine = await panelOf(/^My workspace/);
        await user.click(await mine.findByRole('button', { name: 'Actions for mine' }));
        await user.click(
            within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Upload new version (.zip)' })
        );
        const editor = within(await screen.findByRole('region', { name: 'New version of mine' }));
        expect(editor.queryByRole('tab')).toBeNull();
        await user.upload(editor.getByLabelText('Choose a .zip file'), zipFile());

        await waitFor(() => expect(writes(calls)).toHaveLength(1));
        const [post] = writes(calls);
        expect(post!.url).toBe(`${WORKSPACE}/${row.id}/versions`);
        expect(post!.headers['content-type']).toBe('application/zip');
    });
});
