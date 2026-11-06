import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { EnvVarInput, EnvVarView } from '../src/api/useEnv.js';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, installationRepo, settingsBoard } from './settings-board.js';

/**
 * The organization variables on /settings/organization, driven through the real route table
 * against an in-memory `/api/env` store: the inline editor once the read has landed, the draft and
 * its save bar, pending removal, the `.env` text, the secret states, the navigation guard and a
 * refused save. The editor's own mechanics are pinned by `env-editor.dom.test.tsx`; this file pins
 * what the PAGE wires: the title, the save and its echo, the guard, and the last-saved baseline.
 */

const STORED_AT = '2026-09-01T12:00:00.000Z';

interface EnvBoard {
    org: EnvVarView[];
    /** When set, a PUT is answered with this status and refusal, and nothing is stored. */
    refuse: { status: number; error: string } | null;
    /** While true, a GET parks until released and answers with the rows as they were when it was asked. */
    holdGets: boolean;
    /** While true, a GET is answered 500. */
    failGets: boolean;
    parked: (() => void)[];
}

function envBoard(org: EnvVarView[] = []) {
    const board: EnvBoard = { org, refuse: null, holdGets: false, failGets: false, parked: [] };
    const calls = stubFetch(({ method, url, body }) => {
        if (method === 'GET' && url === '/api/env') {
            if (board.failGets) return { status: 500, body: { error: 'refresh failed' } };
            const snapshot = { org: board.org, workspace: [], repos: [] };
            if (!board.holdGets) return snapshot;
            return new Promise((resolve) => board.parked.push(() => resolve(snapshot)));
        }
        if (method === 'PUT' && url === '/api/env/org') {
            if (board.refuse) return { status: board.refuse.status, body: { error: board.refuse.error } };
            const { vars } = body as { vars: EnvVarInput[] };
            board.org = vars.map((v) => ({
                name: v.name,
                // The write-only contract: a secret's value never echoes; null keeps the stored one.
                value: v.isSecret ? null : v.value,
                isSecret: v.isSecret,
                updatedAt: STORED_AT,
            }));
            return { vars: board.org };
        }
    });
    return { board, calls, puts: () => calls.filter((c) => c.method === 'PUT') };
}

type User = ReturnType<typeof userEvent.setup>;

/** The organization editor once the read has landed. */
async function openCore() {
    const user = userEvent.setup();
    const view = renderApp('/settings/organization');
    const editor = within(await screen.findByRole('region', { name: 'Organization variables' }));
    return { user, editor, view };
}

const rowNames = (editor: ReturnType<typeof within>) =>
    editor.queryAllByRole('listitem').map((li: HTMLElement) => li.querySelector('.env-name-text')?.textContent);

async function addVariable(user: User, editor: ReturnType<typeof within>, name: string, value = '') {
    await user.click(editor.getByRole('button', { name: 'New variable' }));
    await user.type(editor.getByLabelText('Variable name'), name);
    if (value) await user.type(editor.getByLabelText('Variable value'), value);
    await user.keyboard('{Enter}');
}

describe('the organization variables editor', () => {
    it('mounts inline with an empty state, tabs and no save bar, and no dialog or summary', async () => {
        envBoard();
        const { editor } = await openCore();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(editor.getByRole('tab', { name: /^Variables/ }).getAttribute('aria-selected')).toBe('true');
        expect(editor.getByText('No variables yet.')).toBeTruthy();
        expect(editor.queryByRole('button', { name: 'Save changes' })).toBeNull();
        expect(editor.queryByRole('button', { name: 'Edit variables' })).toBeNull();
        expect(editor.getByRole('button', { name: 'New variable' })).toBeTruthy();
    });

    it('lists stored rows by name with their value, and keeps a secret’s value out of the page', async () => {
        envBoard([
            { name: 'E2E_SUMMARY_VAR', value: 'plain-value-123', isSecret: false, updatedAt: STORED_AT },
            { name: 'E2E_SUMMARY_SECRET', value: null, isSecret: true, updatedAt: STORED_AT },
        ]);
        const { user, editor } = await openCore();
        expect(await editor.findByText('E2E_SUMMARY_VAR')).toBeTruthy();
        expect(editor.getByText('plain-value-123')).toBeTruthy();
        expect(document.querySelector('.env-rows input')).toBeNull();

        await user.click(editor.getByRole('tab', { name: /^Secrets/ }));
        expect(editor.getByText('E2E_SUMMARY_SECRET')).toBeTruthy();
        expect(editor.getByText('Set')).toBeTruthy();
        expect(document.querySelector('input[type="password"]')).toBeNull();
    });

    it('saves a new variable, sends the whole list, confirms, and shows the stored row with no bar', async () => {
        const { puts } = envBoard();
        const { user, editor } = await openCore();
        await addVariable(user, editor, 'E2E_SAVED_VAR', 'saved-value');
        await user.click(editor.getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(editor.getByRole('status').textContent).toBe('Changes saved.'));
        expect(puts().map((c) => c.body)).toEqual([
            { vars: [{ name: 'E2E_SAVED_VAR', value: 'saved-value', isSecret: false }] },
        ]);
        expect(rowNames(editor)).toEqual(['E2E_SAVED_VAR']);
        expect(editor.getByText(/^Updated /)).toBeTruthy();
        expect(editor.queryByText('Not saved yet')).toBeNull();
        expect(editor.queryByRole('button', { name: 'Save changes' })).toBeNull();
    });

    it('stages a removal with Undo, and only the save deletes', async () => {
        const { puts } = envBoard([{ name: 'E2E_UNDO_VAR', value: 'kept', isSecret: false, updatedAt: STORED_AT }]);
        const { user, editor } = await openCore();
        await editor.findByText('E2E_UNDO_VAR');

        await user.click(editor.getByRole('button', { name: 'Remove E2E_UNDO_VAR' }));
        expect(editor.getByText('Removed when you save')).toBeTruthy();
        expect(puts()).toHaveLength(0);

        await user.click(editor.getByRole('button', { name: 'Undo' }));
        expect(editor.getByRole('button', { name: 'Edit E2E_UNDO_VAR' })).toBeTruthy();
        expect(editor.queryByRole('button', { name: 'Save changes' })).toBeNull();

        await user.click(editor.getByRole('button', { name: 'Remove E2E_UNDO_VAR' }));
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        await editor.findByText('No variables yet.');
        expect(puts().map((c) => c.body)).toEqual([{ vars: [] }]);
    });

    it('saves valid .env text, and malformed text shows line errors and blocks Save', async () => {
        const { puts } = envBoard();
        const { user, editor } = await openCore();

        await user.click(editor.getByRole('button', { name: 'Raw editor' }));
        const text = editor.getByLabelText('Variables as .env text');
        await user.type(text, 'E2E_RAW_VAR=raw-value{Enter}THIS HAS SPACES=yes');
        expect(editor.getByText(/line 2/)).toBeTruthy();
        expect(editor.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);

        await user.clear(text);
        await user.type(text, 'E2E_RAW_VAR=raw-value');
        expect(editor.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        await editor.findByText('Changes saved.');
        expect(puts().map((c) => c.body)).toEqual([
            { vars: [{ name: 'E2E_RAW_VAR', value: 'raw-value', isSecret: false }] },
        ]);
        // The save leaves nothing pending, and the stored variable reads back in the list.
        await user.click(editor.getByRole('button', { name: 'List view' }));
        expect(rowNames(editor)).toEqual(['E2E_RAW_VAR']);
    });

    it('saves a new secret, keeps it write-only, and offers no value back on edit', async () => {
        const { puts } = envBoard();
        const { user, editor } = await openCore();

        await user.click(editor.getByRole('tab', { name: /^Secrets/ }));
        await user.click(editor.getByRole('button', { name: 'New secret' }));
        await user.type(editor.getByLabelText('Secret name'), 'E2E_SECRET');
        // Not set: a new secret with nothing typed cannot be finished.
        await user.keyboard('{Enter}');
        expect(editor.getByText('Enter a value or remove the row.')).toBeTruthy();

        await user.type(editor.getByLabelText('Secret new value'), 's3cret{Enter}');
        expect(editor.getByText('Will replace when saved')).toBeTruthy();
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        await editor.findByText('Changes saved.');
        expect(document.body.textContent).not.toContain('s3cret');
        expect(puts().map((c) => c.body)).toEqual([
            { vars: [{ name: 'E2E_SECRET', value: 's3cret', isSecret: true }] },
        ]);

        expect(editor.getByText('Set', { exact: true })).toBeTruthy();
        await user.click(editor.getByRole('button', { name: 'Edit E2E_SECRET' }));
        expect(editor.getByLabelText('Secret new value')).toHaveProperty('value', '');
        expect(document.body.innerHTML).not.toContain('s3cret');
    });

    it('arms the browser tab guard only while the editor holds unsaved edits', async () => {
        envBoard();
        const { user, editor } = await openCore();
        const unload = () => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        };

        expect(unload()).toBe(false);
        await user.click(editor.getByRole('button', { name: 'New variable' }));
        // A blank addition already reads as dirty (an unfinished row is part of the draft) ...
        expect(unload()).toBe(true);
        await user.click(editor.getByRole('button', { name: 'Cancel editing variable' }));
        // ... and cancelling it returns the page to nothing to protect.
        expect(unload()).toBe(false);
        await user.click(editor.getByRole('button', { name: 'New variable' }));
        await user.type(editor.getByLabelText('Variable name'), 'E2E_BEFOREUNLOAD');
        // Dirty: the browser's own guard is asked to hold the page.
        expect(unload()).toBe(true);

        await user.click(editor.getByRole('button', { name: 'Discard' }));
        expect(unload()).toBe(false);
        expect(editor.getByText('No variables yet.')).toBeTruthy();
    });

    it('asks before in-app navigation while the editor has unsaved edits', async () => {
        envBoard();
        const { user, editor } = await openCore();
        await addVariable(user, editor, 'E2E_NAV_GUARD');

        await user.click(document.querySelector('a[href="/tasks"]') as HTMLElement);
        expect((await screen.findAllByText('Discard unsaved changes?')).length).toBeGreaterThan(0);
        expect(screen.getByText(/Your changes to Organization variables have not been saved\./)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Continue editing' }));
        expect(editor.getByText('E2E_NAV_GUARD')).toBeTruthy();
        expect(editor.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    });

    it('asks before in-app navigation on a malformed raw text too', async () => {
        envBoard();
        const { user, editor } = await openCore();
        await user.click(editor.getByRole('button', { name: 'Raw editor' }));
        await user.type(editor.getByLabelText('Variables as .env text'), 'not a pair');
        await user.click(document.querySelector('a[href="/tasks"]') as HTMLElement);
        expect((await screen.findAllByText('Discard unsaved changes?')).length).toBeGreaterThan(0);
    });

    it('retains the draft through a failed save with an alert, then a retry succeeds', async () => {
        const { board, puts } = envBoard([
            { name: 'E2E_FAIL_VAR', value: 'kept', isSecret: false, updatedAt: STORED_AT },
        ]);
        const { user, editor } = await openCore();
        await editor.findByText('E2E_FAIL_VAR');

        // The server stays authoritative: a refusal is answered with its error, and the draft survives it.
        board.refuse = { status: 400, error: 'BAD_VALUE: the value is refused' };
        await user.click(editor.getByRole('button', { name: 'Edit E2E_FAIL_VAR' }));
        await user.clear(editor.getByLabelText('Variable value'));
        await user.type(editor.getByLabelText('Variable value'), 'changed{Enter}');
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        expect((await editor.findByRole('alert')).textContent).toContain('BAD_VALUE');
        expect(editor.getByText('changed')).toBeTruthy();
        expect(editor.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);

        // A removal staged before the failure survives it.
        await user.click(editor.getByRole('button', { name: 'Remove E2E_FAIL_VAR' }));
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect((await editor.findByRole('alert')).textContent).toContain('BAD_VALUE');
        expect(editor.getByText('Removed when you save')).toBeTruthy();

        board.refuse = null;
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        await editor.findByText('Changes saved.');
        await editor.findByText('No variables yet.');
        expect(board.org).toEqual([]);
    });

    it('has Save as the editor’s one primary action beside New', async () => {
        envBoard();
        const { user, editor } = await openCore();
        await addVariable(user, editor, 'E2E_PRIMARY');
        const primaries = [...document.querySelectorAll('section.env-editor button.primary')].map((b) => b.textContent);
        expect(primaries.sort()).toEqual(['New variable', 'Save changes']);
    });

    // BEL-262 review: the editor's baseline is the last SAVED list, not whatever the refetch has
    // delivered, or the next whole-list PUT silently deletes the row that was just saved.
    async function saveA(user: User, editor: ReturnType<typeof within>, name: string) {
        await addVariable(user, editor, name);
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        await editor.findByText('Changes saved.');
    }

    it('keeps the saved row while the refresh is still held, and a second save sends both', async () => {
        const { board, puts } = envBoard();
        const { user, editor } = await openCore();
        board.holdGets = true;
        await saveA(user, editor, 'E2E_FIRST');

        await addVariable(user, editor, 'E2E_SECOND');
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect((puts()[1]!.body as { vars: { name: string }[] }).vars.map((v) => v.name)).toEqual([
            'E2E_FIRST',
            'E2E_SECOND',
        ]);
    });

    it('keeps the saved row when the refresh fails', async () => {
        const { board } = envBoard();
        const { user, editor } = await openCore();
        board.failGets = true;
        await saveA(user, editor, 'E2E_KEPT');
        expect(rowNames(editor)).toEqual(['E2E_KEPT']);
        expect(editor.queryByRole('button', { name: 'Save changes' })).toBeNull();
    });

    it('does not let a stale refresh that resolves after a later save overwrite it', async () => {
        const { board } = envBoard();
        const { user, editor } = await openCore();
        board.holdGets = true;
        await saveA(user, editor, 'E2E_ONE');
        await saveA(user, editor, 'E2E_TWO');
        // Release the stale answers: they carry the older snapshot, ignoring their abort.
        // Newest answer first, the stale one last, so an unguarded read would win.
        board.parked
            .splice(0)
            .reverse()
            .forEach((release) => {
                release();
            });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(rowNames(editor)).toEqual(['E2E_ONE', 'E2E_TWO']);
        expect(editor.getByRole('tab', { name: /^Variables/ }).querySelector('.env-tab-count')?.textContent).toBe('2');
    });
});

/**
 * The same last-saved baseline on the other two scopes (BEL-262 review): the workspace and the
 * repository sections keep the row they just saved while the refetch is held.
 */
describe('the workspace and repository editors keep the last saved list', () => {
    function scopedBoard(putUrl: string) {
        let stored: EnvVarView[] = [];
        let hold = false;
        const handler = boardHandler(
            settingsBoard({ installationRepos: [installationRepo('Bellows-AI', 'bellows.ai')] })
        );
        const calls = stubFetch((call) => {
            if (call.method === 'GET' && call.url === '/api/env') {
                const snapshot = {
                    org: [],
                    workspace: putUrl.endsWith('workspace') ? stored : [],
                    repos: putUrl.endsWith('repo') ? [{ owner: 'Bellows-AI', name: 'bellows.ai', vars: stored }] : [],
                };
                return hold ? new Promise(() => {}) : snapshot;
            }
            if (call.method === 'PUT' && call.url === putUrl) {
                const { vars } = call.body as { vars: EnvVarInput[] };
                stored = vars.map((v) => ({ ...v, value: v.isSecret ? null : v.value, updatedAt: STORED_AT }));
                return { vars: stored };
            }
            return handler(call);
        });
        return { calls, hold: () => (hold = true) };
    }

    async function saveThenSecond(
        editor: ReturnType<typeof within>,
        hold: () => void,
        calls: ReturnType<typeof stubFetch>
    ) {
        const user = userEvent.setup();
        await editor.findByText('No variables yet.');
        hold();
        await addVariable(user, editor, 'E2E_SAVED_FIRST');
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        await editor.findByText('Changes saved.');
        expect(rowNames(editor)).toEqual(['E2E_SAVED_FIRST']);

        await addVariable(user, editor, 'E2E_SAVED_SECOND');
        await user.click(editor.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2));
        const sent = calls.filter((c) => c.method === 'PUT')[1]!.body as { vars: { name: string }[] };
        expect(sent.vars.map((v) => v.name)).toEqual(['E2E_SAVED_FIRST', 'E2E_SAVED_SECOND']);
    }

    it('workspace', async () => {
        const { hold, calls } = scopedBoard('/api/env/workspace');
        renderApp('/settings/workspace');
        const editor = within(await screen.findByRole('region', { name: 'Workspace variables' }));
        await saveThenSecond(editor, hold, calls);
    });

    it('repository', async () => {
        const { hold, calls } = scopedBoard('/api/env/repo');
        const user = userEvent.setup();
        renderApp('/settings/repos');
        await user.click(await screen.findByRole('button', { name: 'Configure' }));
        const heading = await screen.findByRole('heading', { name: 'Bellows-AI/bellows.ai' });
        expect(heading.className).toContain('mono');
        const editor = within(await screen.findByRole('region', { name: 'Bellows-AI/bellows.ai' }));
        await saveThenSecond(editor, hold, calls);
    });
});
