import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { EnvVarInput, EnvVarView } from '../src/api/useEnv.js';
import { renderApp, stubFetch } from './dom.js';

/**
 * The Core (organization) variables on /settings/organization, driven through the real route
 * table against an in-memory `/api/env` store: the compact summary, the dialog it opens, the
 * draft and its footer, pending removal, the `.env` text, the secret states, the tab guard and a
 * refused save. The dialog's own mechanics are pinned by `env-dialog.dom.test.tsx`; this file
 * pins what the PAGE wires: open, refresh after save, focus return, the navigation guard.
 */

const STORED_AT = '2026-09-01T12:00:00.000Z';

interface EnvBoard {
    org: EnvVarView[];
    /** When set, a PUT is answered with this status and refusal, and nothing is stored. */
    refuse: { status: number; error: string } | null;
}

function envBoard(org: EnvVarView[] = []) {
    const board: EnvBoard = { org, refuse: null };
    const calls = stubFetch(({ method, url, body }) => {
        if (method === 'GET' && url === '/api/env') return { org: board.org, workspace: [], repos: [] };
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

/** The Core summary once the read has landed; `ready` is a text the loaded summary carries. */
async function openCore(ready = 'No variables or secrets configured yet.') {
    const user = userEvent.setup();
    const view = renderApp('/settings/organization');
    const heading = await screen.findByRole('heading', { name: 'Core (organization)' });
    const summary = within(heading.closest('section.panel') as HTMLElement);
    await summary.findByText(ready);
    return { user, summary, view };
}

async function openDialog(user: ReturnType<typeof userEvent.setup>, summary: ReturnType<typeof within>) {
    await user.click(summary.getByRole('button', { name: 'Edit variables' }));
    return within(await screen.findByRole('dialog', { name: 'Core (organization)' }));
}

describe('the Core variables summary and dialog', () => {
    it('shows an empty state and no editing surface until Edit variables opens the dialog', async () => {
        envBoard();
        const { user, summary } = await openCore();
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(summary.queryByRole('tab')).toBeNull();
        expect(summary.queryByRole('button', { name: 'Save changes' })).toBeNull();

        const dialog = await openDialog(user, summary);
        expect(dialog.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
        expect(dialog.getByRole('button', { name: 'Add variable' })).toBeTruthy();
    });

    it('summarises stored rows by count and name, never by value', async () => {
        envBoard([
            { name: 'E2E_SUMMARY_VAR', value: 'plain-value-123', isSecret: false, updatedAt: STORED_AT },
            { name: 'E2E_SUMMARY_SECRET', value: null, isSecret: true, updatedAt: STORED_AT },
        ]);
        const { summary } = await openCore('E2E_SUMMARY_VAR');
        expect(summary.getByText('1 variable', { exact: false })).toBeTruthy();
        expect(summary.getByText('1 secret', { exact: false })).toBeTruthy();
        expect(summary.getByText('E2E_SUMMARY_SECRET')).toBeTruthy();
        expect(document.body.textContent).not.toContain('plain-value-123');
        expect(document.querySelector('input')).toBeNull();
    });

    it('closes clean without asking, and Cancel on a dirty draft asks before it discards', async () => {
        envBoard();
        const { user, summary } = await openCore();
        let dialog = await openDialog(user, summary);
        expect(dialog.queryByText('Unsaved changes')).toBeNull();

        await user.click(dialog.getByRole('button', { name: 'Add variable' }));
        await user.type(dialog.getByLabelText('Variable 1 name'), 'E2E_CANCEL_VAR');
        expect(dialog.getByText('Unsaved changes')).toBeTruthy();

        await user.click(dialog.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByText('Discard unsaved changes?')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Discard changes' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(summary.getByText('No variables or secrets configured yet.')).toBeTruthy();

        // Reopened, the draft starts from the stored rows again; clean closes without a question.
        dialog = await openDialog(user, summary);
        expect(dialog.queryByLabelText('Variable 1 name')).toBeNull();
        await user.click(dialog.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
    });

    it('saves from the dialog, refreshes the summary, confirms, and returns focus to Edit variables', async () => {
        const { puts } = envBoard();
        const { user, summary } = await openCore();
        const dialog = await openDialog(user, summary);
        await user.click(dialog.getByRole('button', { name: 'Add variable' }));
        await user.type(dialog.getByLabelText('Variable 1 name'), 'E2E_SAVED_VAR');
        await user.type(dialog.getByLabelText('Variable 1 value'), 'saved-value');
        await user.click(dialog.getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await summary.findByText('E2E_SAVED_VAR');
        expect(summary.getByText('1 variable', { exact: false })).toBeTruthy();
        expect(summary.getByRole('status').textContent).toBe('Changes saved.');
        expect(document.activeElement).toBe(summary.getByRole('button', { name: 'Edit variables' }));
        expect(puts().map((c) => c.body)).toEqual([
            { vars: [{ name: 'E2E_SAVED_VAR', value: 'saved-value', isSecret: false }] },
        ]);
    });

    it('stages a removal with Undo, and only the save deletes', async () => {
        const { puts } = envBoard([{ name: 'E2E_UNDO_VAR', value: 'kept', isSecret: false, updatedAt: STORED_AT }]);
        const { user, summary } = await openCore('E2E_UNDO_VAR');
        const dialog = await openDialog(user, summary);

        await user.click(dialog.getByRole('button', { name: 'Remove E2E_UNDO_VAR' }));
        expect(dialog.getByText('E2E_UNDO_VAR will be removed when you save.')).toBeTruthy();
        expect(puts()).toHaveLength(0);

        await user.click(dialog.getByRole('button', { name: 'Undo' }));
        expect(dialog.getByLabelText('Variable 1 name')).toHaveProperty('value', 'E2E_UNDO_VAR');

        await user.click(dialog.getByRole('button', { name: 'Remove E2E_UNDO_VAR' }));
        await user.click(dialog.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await summary.findByText('No variables or secrets configured yet.');
        expect(puts().map((c) => c.body)).toEqual([{ vars: [] }]);
    });

    it('saves valid .env text, and malformed text shows line errors and blocks Save', async () => {
        const { puts } = envBoard();
        const { user, summary } = await openCore();
        const dialog = await openDialog(user, summary);

        await user.click(dialog.getByRole('button', { name: '.env' }));
        const text = dialog.getByLabelText('Variables as .env text');
        await user.type(text, 'E2E_RAW_VAR=raw-value{Enter}THIS HAS SPACES=yes');
        expect(dialog.getByText(/line 2/)).toBeTruthy();
        expect(dialog.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);

        await user.clear(text);
        await user.type(text, 'E2E_RAW_VAR=raw-value');
        expect(dialog.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);
        await user.click(dialog.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await summary.findByText('E2E_RAW_VAR');
        expect(puts().map((c) => c.body)).toEqual([
            { vars: [{ name: 'E2E_RAW_VAR', value: 'raw-value', isSecret: false }] },
        ]);
    });

    it('saves a new secret, keeps it write-only, and offers no value back on reopen', async () => {
        const { puts } = envBoard();
        const { user, summary } = await openCore();
        let dialog = await openDialog(user, summary);

        await user.click(dialog.getByRole('button', { name: 'Add secret' }));
        await user.type(dialog.getByLabelText('Secret 1 name'), 'E2E_SECRET');
        // Not set: a new secret with nothing typed cannot save.
        expect(dialog.getByText('Not set')).toBeTruthy();
        expect(dialog.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);

        await user.type(dialog.getByLabelText('Secret 1 new value'), 's3cret');
        expect(dialog.getByText('Will replace when saved')).toBeTruthy();
        await user.click(dialog.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await summary.findByText('E2E_SECRET');
        expect(document.body.textContent).not.toContain('s3cret');
        expect(puts().map((c) => c.body)).toEqual([
            { vars: [{ name: 'E2E_SECRET', value: 's3cret', isSecret: true }] },
        ]);

        dialog = await openDialog(user, summary);
        expect(dialog.getByText('Set', { exact: true })).toBeTruthy();
        expect(dialog.getByLabelText('Secret 1 new value')).toHaveProperty('value', '');
    });

    it('arms the browser tab guard only while the dialog holds unsaved edits', async () => {
        envBoard();
        const { user, summary } = await openCore();
        const unload = () => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        };

        expect(unload()).toBe(false);
        const dialog = await openDialog(user, summary);
        // Open but clean: still nothing to protect.
        expect(unload()).toBe(false);

        await user.click(dialog.getByRole('button', { name: 'Add variable' }));
        await user.type(dialog.getByLabelText('Variable 1 name'), 'E2E_BEFOREUNLOAD');
        // Dirty: the browser's own guard is asked to hold the page.
        expect(unload()).toBe(true);

        await user.click(dialog.getByRole('button', { name: 'Cancel' }));
        await user.click(screen.getByRole('button', { name: 'Discard changes' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(unload()).toBe(false);
    });

    it('asks before in-app navigation while the dialog has unsaved edits', async () => {
        envBoard();
        const { user, summary } = await openCore();
        const dialog = await openDialog(user, summary);
        await user.click(dialog.getByRole('button', { name: 'Add variable' }));
        await user.type(dialog.getByLabelText('Variable 1 name'), 'E2E_NAV_GUARD');

        // Back/forward and programmatic navigation reach the route blocker even though a pointer
        // cannot click the page behind a modal; the link click here stands for that navigation.
        await user.click(document.querySelector('a[href="/tasks"]') as HTMLElement);
        expect((await screen.findAllByText('Discard unsaved changes?')).length).toBeGreaterThan(0);
        await user.click(screen.getByRole('button', { name: 'Continue editing' }));
        expect(screen.getByLabelText('Variable 1 name')).toHaveProperty('value', 'E2E_NAV_GUARD');
    });

    it('retains the draft through a failed save with an alert, then a retry succeeds and closes', async () => {
        const { board, puts } = envBoard([
            { name: 'E2E_FAIL_VAR', value: 'kept', isSecret: false, updatedAt: STORED_AT },
        ]);
        const { user, summary } = await openCore('E2E_FAIL_VAR');
        const dialog = await openDialog(user, summary);

        // The server stays authoritative: a refusal is answered with its error, and the draft survives it.
        board.refuse = { status: 400, error: 'BAD_VALUE: the value is refused' };
        const value = dialog.getByLabelText('Variable 1 value');
        await user.clear(value);
        await user.type(value, 'changed');
        await user.click(dialog.getByRole('button', { name: 'Save changes' }));
        expect((await dialog.findByRole('alert')).textContent).toContain('BAD_VALUE');
        expect(screen.getByRole('dialog')).toBeTruthy();
        expect(dialog.getByLabelText('Variable 1 value')).toHaveProperty('value', 'changed');
        expect(dialog.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);

        // A removal staged before the failure survives it.
        await user.click(dialog.getByRole('button', { name: 'Remove E2E_FAIL_VAR' }));
        await user.click(dialog.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect((await dialog.findByRole('alert')).textContent).toContain('BAD_VALUE');
        expect(dialog.getByText('E2E_FAIL_VAR will be removed when you save.')).toBeTruthy();

        board.refuse = null;
        await user.click(dialog.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await summary.findByText('No variables or secrets configured yet.');
        expect(board.org).toEqual([]);
    });

    it('has Save as the dialog’s one primary action', async () => {
        envBoard();
        const { user, summary } = await openCore();
        const dialog = await openDialog(user, summary);
        await user.click(dialog.getByRole('button', { name: 'Add variable' }));
        const panel = screen.getByRole('dialog');
        const primaries = panel.querySelectorAll('button.primary');
        expect(primaries).toHaveLength(1);
        expect(primaries[0]!.textContent).toBe('Save changes');
    });
});
