import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { EnvVarInput, EnvVarView } from '../src/api/useEnv.js';
import { renderApp, stubFetch } from './dom.js';

/**
 * The Core (organization) env editor on /settings/organization, driven through the real route
 * table against an in-memory `/api/env` store: the draft, its footer, pending removal, the
 * advanced .env editor, the secret states, the tab guard and a refused save.
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

async function openCore() {
    const user = userEvent.setup();
    const view = renderApp('/settings/organization');
    const heading = await screen.findByRole('heading', { name: 'Core (organization)' });
    const core = within(heading.closest('section.panel') as HTMLElement);
    await core.findByText('No variables configured.');
    return { user, core, view };
}

const footerOf = (core: ReturnType<typeof within>) =>
    within(core.getByRole('button', { name: 'Save changes' }).closest('.settings-actions') as HTMLElement);

describe('the Core environment editor', () => {
    it('shows Unsaved changes while dirty, and Cancel returns the draft to the stored rows', async () => {
        envBoard();
        const { user, core } = await openCore();
        const footer = footerOf(core);
        expect(footer.queryByText('Unsaved changes')).toBeNull();
        expect(footer.getByRole('button', { name: 'Cancel' })).toHaveProperty('disabled', true);

        await user.click(core.getByRole('button', { name: 'Add variable' }));
        await user.type(core.getByLabelText('Variable 1 name'), 'E2E_CANCEL_VAR');
        expect(footer.getByText('Unsaved changes')).toBeTruthy();

        await user.click(footer.getByRole('button', { name: 'Cancel' }));
        expect(core.getByText('No variables configured.')).toBeTruthy();
        expect(footer.queryByText('Unsaved changes')).toBeNull();
        expect(footer.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);

        // Clean again: leaving asks nothing.
        await user.click(screen.getByRole('link', { name: 'Tasks' }));
        await waitFor(() => expect(screen.queryByRole('heading', { name: 'Core (organization)' })).toBeNull());
        expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
    });

    it('keeps the draft across tab switches without losing a keystroke', async () => {
        envBoard();
        const { user, core } = await openCore();

        await user.click(core.getByRole('button', { name: 'Add variable' }));
        await user.type(core.getByLabelText('Variable 1 name'), 'E2E_TAB_DRAFT');
        await user.click(core.getByRole('tab', { name: /^Secrets \(/ }));
        expect(core.getByText('No secrets configured.')).toBeTruthy();
        await user.click(core.getByRole('tab', { name: /^Variables \(/ }));
        expect(core.getByLabelText('Variable 1 name')).toHaveProperty('value', 'E2E_TAB_DRAFT');

        // An untouched blank addition may vanish without ceremony; the save button stays honest.
        await user.click(core.getByRole('button', { name: /^Remove/ }));
        expect(core.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    });

    it('stages a removal with Undo, and only the save deletes', async () => {
        const { puts } = envBoard([{ name: 'E2E_UNDO_VAR', value: 'kept', isSecret: false, updatedAt: STORED_AT }]);
        const user = userEvent.setup();
        renderApp('/settings/organization');
        const heading = await screen.findByRole('heading', { name: 'Core (organization)' });
        const core = within(heading.closest('section.panel') as HTMLElement);
        await waitFor(() => expect(core.getByLabelText('Variable 1 name')).toHaveProperty('value', 'E2E_UNDO_VAR'));

        await user.click(core.getByRole('button', { name: 'Remove E2E_UNDO_VAR' }));
        expect(core.getByText('E2E_UNDO_VAR will be removed when you save.')).toBeTruthy();
        expect(core.getByRole('tab', { name: /^Variables \(/ }).textContent).toBe('Variables (0)');
        expect(puts()).toHaveLength(0);

        await user.click(core.getByRole('button', { name: 'Undo' }));
        expect(core.getByLabelText('Variable 1 name')).toHaveProperty('value', 'E2E_UNDO_VAR');
        expect(core.getByRole('tab', { name: /^Variables \(/ }).textContent).toBe('Variables (1)');

        await user.click(core.getByRole('button', { name: 'Remove E2E_UNDO_VAR' }));
        await user.click(core.getByRole('button', { name: 'Save changes' }));
        await core.findByText('Changes saved.');
        expect(core.getByText('No variables configured.')).toBeTruthy();
        expect(puts().map((c) => c.body)).toEqual([{ vars: [] }]);
    });

    it('applies valid .env text from the advanced editor, and invalid text changes nothing', async () => {
        const { puts } = envBoard();
        const { user, core } = await openCore();

        // Opening alone never changes the draft; the warning says what Apply will do.
        await user.click(core.getByRole('button', { name: 'Edit variables as .env' }));
        const editor = core.getByLabelText('Variables in .env format');
        expect(core.getByText(/^This replaces the variable draft for this scope\./)).toBeTruthy();

        await user.type(editor, 'E2E_RAW_VAR=raw-value{Enter}THIS HAS SPACES=yes');
        await user.click(core.getByRole('button', { name: 'Apply .env draft' }));
        // Invalid text is refused with the line error; the table draft is untouched.
        expect(core.getByText(/not a legal environment variable name/)).toBeTruthy();
        expect(core.getByLabelText('Variables in .env format')).toBeTruthy();
        expect(core.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);

        await user.clear(editor);
        await user.type(editor, 'E2E_RAW_VAR=raw-value');
        await user.click(core.getByRole('button', { name: 'Apply .env draft' }));
        expect(core.getByLabelText('Variable 1 name')).toHaveProperty('value', 'E2E_RAW_VAR');

        await user.click(core.getByRole('button', { name: 'Save changes' }));
        await core.findByText('Changes saved.');
        expect(puts().map((c) => c.body)).toEqual([
            { vars: [{ name: 'E2E_RAW_VAR', value: 'raw-value', isSecret: false }] },
        ]);
    });

    it('shows a secret as Set, and a typed replacement is the only path to a change', async () => {
        const { puts } = envBoard();
        const { user, core } = await openCore();

        await user.click(core.getByRole('tab', { name: /^Secrets \(/ }));
        await user.click(core.getByRole('button', { name: 'Add secret' }));
        await user.type(core.getByLabelText('Secret 1 name'), 'E2E_SECRET');
        // Not set: a new secret with nothing typed cannot save.
        expect(core.getByText('Not set')).toBeTruthy();
        expect(core.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);

        await user.type(core.getByLabelText('Secret 1 new value'), 's3cret');
        expect(core.getByText('Will replace when saved')).toBeTruthy();
        await user.click(core.getByRole('button', { name: 'Save changes' }));
        await core.findByText('Changes saved.');
        // The echo blanks the typed value: Set, and the input is empty again.
        expect(core.getByLabelText('Secret 1 new value')).toHaveProperty('value', '');
        expect(core.getByText('Set', { exact: true })).toBeTruthy();
        expect(puts().map((c) => c.body)).toEqual([
            { vars: [{ name: 'E2E_SECRET', value: 's3cret', isSecret: true }] },
        ]);
    });

    it('arms the browser tab guard only while dirty', async () => {
        envBoard();
        const { user, core } = await openCore();
        const unload = () => {
            const event = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(event);
            return event.defaultPrevented;
        };

        // Clean: an unload asks nobody anything.
        expect(unload()).toBe(false);

        await user.click(core.getByRole('button', { name: 'Add variable' }));
        await user.type(core.getByLabelText('Variable 1 name'), 'E2E_BEFOREUNLOAD');
        // Dirty: the browser's own guard is asked to hold the page.
        expect(unload()).toBe(true);

        await user.click(footerOf(core).getByRole('button', { name: 'Cancel' }));
        expect(unload()).toBe(false);
    });

    it('retains the draft and its pending removals through a failed save, then a retry succeeds', async () => {
        const { board, puts } = envBoard([
            { name: 'E2E_FAIL_VAR', value: 'kept', isSecret: false, updatedAt: STORED_AT },
        ]);
        const user = userEvent.setup();
        renderApp('/settings/organization');
        const heading = await screen.findByRole('heading', { name: 'Core (organization)' });
        const core = within(heading.closest('section.panel') as HTMLElement);
        await waitFor(() => expect(core.getByLabelText('Variable 1 value')).toHaveProperty('value', 'kept'));

        // The server stays authoritative: a refusal is answered with its error, and the draft survives it.
        board.refuse = { status: 400, error: 'BAD_VALUE: the value is refused' };
        const value = core.getByLabelText('Variable 1 value');
        await user.clear(value);
        await user.type(value, 'changed');
        await user.click(core.getByRole('button', { name: 'Save changes' }));
        // The error renders as an alert, the inputs keep their text, and save is offered again.
        expect((await core.findByRole('alert')).textContent).toContain('BAD_VALUE');
        expect(core.getByLabelText('Variable 1 name')).toHaveProperty('value', 'E2E_FAIL_VAR');
        expect(core.getByLabelText('Variable 1 value')).toHaveProperty('value', 'changed');
        expect(core.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', false);

        // A removal staged before the failure survives it: Undo is still there after the 400.
        await user.click(core.getByRole('button', { name: 'Remove E2E_FAIL_VAR' }));
        expect(core.getByText('E2E_FAIL_VAR will be removed when you save.')).toBeTruthy();
        await user.click(core.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(puts()).toHaveLength(2));
        expect((await core.findByRole('alert')).textContent).toContain('BAD_VALUE');
        expect(core.getByText('E2E_FAIL_VAR will be removed when you save.')).toBeTruthy();
        expect(core.getByRole('button', { name: 'Undo' })).toBeTruthy();

        board.refuse = null;
        await user.click(core.getByRole('button', { name: 'Save changes' }));
        await core.findByText('Changes saved.');
        expect(core.getByText('No variables configured.')).toBeTruthy();
        expect(board.org).toEqual([]);
    });
});
