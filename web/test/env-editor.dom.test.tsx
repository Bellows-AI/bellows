import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { EnvSaveResult } from '../src/api/useEnv.js';
import { UnsavedChangesProvider } from '../src/components/UnsavedChangesDialog.js';
import type { GuardApi, UnsavedDraft } from '../src/components/UnsavedChangesDialog.js';
import { EnvVarsSection } from '../src/panels/EnvVarsSection.js';
import type { EnvPayloadRow } from '../src/panels/env-draft.js';
import './dom.js';

/**
 * The inline variables editor, mounted on its own: Variables | Secrets tabs over one
 * draft, read-only rows that open one at a time, the raw `.env` text on the same draft with no
 * Apply step, nothing persisted until Save, a save bar only while there is something to save.
 * The settings pages' wiring (title, refetch, navigation guard) is `env.dom.test.tsx`.
 */

const STORED_AT = '2026-09-01T12:00:00.000Z';

const STORED = [
    { name: 'LOG_LEVEL', value: 'debug', isSecret: false, updatedAt: STORED_AT },
    { name: 'EMPTY', value: '', isSecret: false, updatedAt: STORED_AT },
    { name: 'QUOTED', value: '"x"', isSecret: false, updatedAt: STORED_AT },
    { name: 'TOKEN', value: null, isSecret: true, updatedAt: STORED_AT },
];

type User = ReturnType<typeof userEvent.setup>;

/** The settings area's guard stand-in: it keeps the latest draft each scope registered. */
function fakeGuard() {
    const drafts = new Map<string, UnsavedDraft>();
    const api: GuardApi = {
        registerDraft: (draft) => {
            drafts.set(draft.id, draft);
            return () => {
                if (drafts.get(draft.id) === draft) drafts.delete(draft.id);
            };
        },
        dirtyDraft: (id) => (drafts.get(id)?.dirty ? (drafts.get(id) ?? null) : null),
        confirmDiscard: async () => true,
    };
    return { api, draft: () => drafts.get('org') };
}

function setup(overrides: { vars?: typeof STORED; onSave?: (vars: EnvPayloadRow[]) => Promise<EnvSaveResult> } = {}) {
    const onSave = vi.fn(
        overrides.onSave ??
            (async (vars: EnvPayloadRow[]): Promise<EnvSaveResult> => ({
                error: null,
                vars: vars.map((v) => ({
                    ...v,
                    value: v.isSecret ? null : v.value,
                    updatedAt: new Date().toISOString(),
                })),
            }))
    );
    const guard = fakeGuard();
    const user = userEvent.setup();
    const view = render(
        <UnsavedChangesProvider api={guard.api}>
            <EnvVarsSection
                title="Organization variables"
                vars={overrides.vars ?? STORED}
                onSave={onSave}
                draftId="org"
                draftLabel="Organization variables"
            />
        </UnsavedChangesProvider>
    );
    return { user, view, onSave, guard };
}

const tab = (name: 'Variables' | 'Secrets') => screen.getByRole('tab', { name: new RegExp(`^${name}`) });
const rowNames = () => [...document.querySelectorAll('.env-rows .env-name-text')].map((el) => el.textContent);
const saveButton = () => screen.queryByRole('button', { name: /^Save changes$|^Saving changes…$/ });
const textarea = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Variables as .env text' });
const toRaw = (user: User) => user.click(screen.getByRole('button', { name: 'Raw editor' }));
const toList = (user: User) => user.click(screen.getByRole('button', { name: 'List view' }));
const edit = (user: User, name: string) => user.click(screen.getByRole('button', { name: `Edit ${name}` }));
const done = (user: User, name: string) => user.click(screen.getByRole('button', { name: `Done editing ${name}` }));
const valueInput = (label = 'Variable value') => screen.getByLabelText<HTMLInputElement>(label);

async function replaceRawText(user: User, text: string) {
    await user.click(textarea());
    textarea().setSelectionRange(0, textarea().value.length);
    await user.paste(text);
}

describe('the rows and tabs', () => {
    it('lists the variables as read-only text rows sorted by name, with the secret on its own tab', () => {
        setup();
        expect(rowNames()).toEqual(['EMPTY', 'LOG_LEVEL', 'QUOTED']);
        expect(document.querySelector('.env-rows input')).toBeNull();
        expect(screen.getByText('debug').isConnected).toBe(true);
        expect(screen.getByText('empty').isConnected).toBe(true);
        expect(screen.queryByText('TOKEN')).toBeNull();
        expect(screen.getAllByText(/^Updated /)).toHaveLength(3);
    });

    it('names the section by its title and marks the Variables tab selected', () => {
        setup();
        expect(screen.getByRole('region', { name: 'Organization variables' }).isConnected).toBe(true);
        expect(tab('Variables').getAttribute('aria-selected')).toBe('true');
        expect(tab('Secrets').getAttribute('aria-selected')).toBe('false');
        expect(screen.getByRole('tabpanel')).toBeTruthy();
    });

    it('counts each tab and follows an addition and a pending removal', async () => {
        const { user } = setup();
        const count = (name: 'Variables' | 'Secrets') => tab(name).querySelector('.env-tab-count')?.textContent;
        expect([count('Variables'), count('Secrets')]).toEqual(['3', '1']);
        await user.click(screen.getByRole('button', { name: 'New variable' }));
        expect(count('Variables')).toBe('4');
        await user.click(screen.getByRole('button', { name: 'Cancel editing variable' }));
        expect(count('Variables')).toBe('3');
        await user.click(screen.getByRole('button', { name: 'Remove EMPTY' }));
        expect(count('Variables')).toBe('2');
    });

    it('switches tabs on click and on the arrow keys, showing that tab’s rows and head', async () => {
        const { user } = setup();
        await user.click(tab('Secrets'));
        expect(tab('Secrets').getAttribute('aria-selected')).toBe('true');
        expect(rowNames()).toEqual(['TOKEN']);
        expect(screen.getByRole('heading', { level: 3, name: 'Secrets' }).isConnected).toBe(true);
        expect(screen.getByRole('button', { name: 'New secret' }).isConnected).toBe(true);
        expect(screen.queryByRole('button', { name: 'Raw editor' })).toBeNull();

        tab('Secrets').focus();
        await user.keyboard('{ArrowLeft}');
        expect(tab('Variables').getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(tab('Variables'));
        await user.keyboard('{ArrowRight}');
        expect(tab('Secrets').getAttribute('aria-selected')).toBe('true');
        expect(rowNames()).toEqual(['TOKEN']);
    });

    it('marks the unsaved tab with its own dot, and only that tab', async () => {
        const { user } = setup();
        const dot = (name: 'Variables' | 'Secrets') =>
            within(tab(name)).queryByRole('img', { name: 'Unsaved changes' });
        expect([dot('Variables'), dot('Secrets')]).toEqual([null, null]);

        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x');
        await done(user, 'LOG_LEVEL');
        expect(dot('Variables')).not.toBeNull();
        expect(dot('Secrets')).toBeNull();

        await user.click(tab('Secrets'));
        await edit(user, 'TOKEN');
        await user.type(valueInput('Secret new value'), 'next');
        await done(user, 'TOKEN');
        expect(dot('Secrets')).not.toBeNull();
        expect(dot('Variables')).not.toBeNull();
    });

    it('marks an edited row Changed and an added row New, not saved', async () => {
        const { user } = setup();
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x');
        await done(user, 'LOG_LEVEL');
        await user.click(screen.getByRole('button', { name: 'New variable' }));
        await user.type(screen.getByLabelText('Variable name'), 'ADDED');
        await user.keyboard('{Enter}');
        const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement;
        expect(within(row('LOG_LEVEL')).getByRole('img', { name: 'Changed, not saved' }).isConnected).toBe(true);
        expect(within(row('ADDED')).getByRole('img', { name: 'New, not saved' }).isConnected).toBe(true);
        expect(within(row('ADDED')).getByText('Not saved yet').isConnected).toBe(true);
        expect(within(row('EMPTY')).queryByRole('img')).toBeNull();
    });
});

describe('filtering', () => {
    it('narrows the rows by name, says so when nothing matches, and starts over on a tab switch', async () => {
        const { user } = setup();
        const filter = screen.getByRole('searchbox', { name: 'Filter variables by name' });
        await user.type(filter, 'log');
        expect(rowNames()).toEqual(['LOG_LEVEL']);

        await user.clear(filter);
        await user.type(filter, 'zzz');
        expect(screen.getByText('No variables match “zzz”.').isConnected).toBe(true);
        expect(document.querySelector('.env-rows')).toBeNull();

        await user.click(tab('Secrets'));
        expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Filter secrets by name' }).value).toBe('');
        expect(rowNames()).toEqual(['TOKEN']);
        await user.click(tab('Variables'));
        expect(rowNames()).toEqual(['EMPTY', 'LOG_LEVEL', 'QUOTED']);
    });

    it('says what an empty tab holds, apart from a filter that matches nothing', () => {
        setup({ vars: [] });
        expect(screen.getByText('No variables yet.').isConnected).toBe(true);
        act(() => tab('Secrets').click());
        expect(screen.getByText(/^No secrets yet\./).isConnected).toBe(true);
    });
});

describe('editing one row at a time', () => {
    it('opens a row with its value focused, and Cancel puts the row back as it was', async () => {
        const { user } = setup();
        await edit(user, 'LOG_LEVEL');
        expect(document.activeElement).toBe(valueInput());
        expect(screen.getByLabelText<HTMLInputElement>('Variable name').value).toBe('LOG_LEVEL');
        await user.type(valueInput(), 'ger');
        await user.click(screen.getByRole('button', { name: 'Cancel editing LOG_LEVEL' }));
        expect(screen.getByText('debug').isConnected).toBe(true);
        expect(screen.queryByLabelText('Variable value')).toBeNull();
        expect(screen.queryByText('Unsaved changes')).toBeNull();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit LOG_LEVEL' }));
    });

    it('writes edits to the draft live, and Done closes the row focusing its Edit button', async () => {
        const { user } = setup();
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x');
        expect(screen.getByText('Unsaved changes').isConnected).toBe(true);
        await done(user, 'LOG_LEVEL');
        expect(screen.getByText('debugx').isConnected).toBe(true);
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit LOG_LEVEL' }));
    });

    it('takes Enter as Done and Escape as Cancel from either input', async () => {
        const { user } = setup();
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x{Enter}');
        expect(screen.getByText('debugx').isConnected).toBe(true);
        expect(screen.queryByLabelText('Variable value')).toBeNull();

        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'y{Escape}');
        expect(screen.getByText('debugx').isConnected).toBe(true);
        expect(screen.queryByLabelText('Variable value')).toBeNull();

        await edit(user, 'LOG_LEVEL');
        screen.getByLabelText<HTMLInputElement>('Variable name').focus();
        await user.keyboard('{Escape}');
        expect(screen.queryByLabelText('Variable name')).toBeNull();
    });

    it('closes the open row when another is opened, so only one is ever editable', async () => {
        const { user } = setup();
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x');
        await edit(user, 'QUOTED');
        expect(screen.getAllByLabelText('Variable name')).toHaveLength(1);
        expect(screen.getByLabelText<HTMLInputElement>('Variable name').value).toBe('QUOTED');
        expect(screen.getByText('debugx').isConnected).toBe(true);
    });

    it('keeps a row open on Done while it is invalid, showing its errors and focusing the name', async () => {
        const { user, onSave } = setup();
        await edit(user, 'LOG_LEVEL');
        const name = screen.getByLabelText<HTMLInputElement>('Variable name');
        expect(document.querySelector('.env-errors')).toBeNull();
        await user.clear(name);
        expect(screen.getByText('Name is required.').isConnected).toBe(true);
        expect(name.getAttribute('aria-invalid')).toBe('true');

        valueInput().focus();
        await user.keyboard('{Enter}');
        expect(screen.getByLabelText('Variable name')).toBe(name);
        expect(document.activeElement).toBe(name);

        // Another row cannot be opened over it, and Save only sends it back to the open row.
        await edit(user, 'QUOTED');
        expect(screen.getByLabelText<HTMLInputElement>('Variable name').value).toBe('');
        await user.click(saveButton() as HTMLButtonElement);
        expect(onSave).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(screen.getByLabelText('Variable name'));
    });

    it('shows no scolding on a fresh row until it is touched or Done is attempted', async () => {
        const { user } = setup();
        await user.click(screen.getByRole('button', { name: 'New variable' }));
        expect(document.querySelector('.env-errors')).toBeNull();
        await done(user, 'variable');
        expect(screen.getByText('Name is required.').isConnected).toBe(true);
        expect(screen.getByLabelText('Variable name')).toBeTruthy();
    });

    it('drops a fresh blank row on Cancel and gives focus back to New', async () => {
        const { user } = setup();
        await user.click(screen.getByRole('button', { name: 'New variable' }));
        expect(document.querySelectorAll('.env-rows .env-row')).toHaveLength(4);
        await user.type(screen.getByLabelText('Variable name'), 'TYPED');
        await user.click(screen.getByRole('button', { name: 'Cancel editing TYPED' }));
        expect(rowNames()).toEqual(['EMPTY', 'LOG_LEVEL', 'QUOTED']);
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New variable' }));
        expect(saveButton()).toBeNull();
    });
});

describe('the keyboard path', () => {
    it('adds a row, lands in its name, closes it with Enter, and removes then restores it from the keyboard', async () => {
        const { user } = setup();
        const add = screen.getByRole('button', { name: 'New variable' });
        add.focus();
        await user.keyboard('{Enter}');
        expect(document.activeElement).toBe(screen.getByLabelText('Variable name'));
        await user.keyboard('NEW_ONE');
        await user.tab();
        await user.keyboard('v{Enter}');
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit NEW_ONE' }));

        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove NEW_ONE' }));
        await user.keyboard('{Enter}');
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Undo' }));
        expect(screen.getByText('Removed when you save').isConnected).toBe(true);

        await user.keyboard('{Enter}');
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit NEW_ONE' }));
        expect(screen.queryByText('Removed when you save')).toBeNull();
    });

    it('lets an untouched blank row vanish on Remove instead of staging a removal', async () => {
        const { user } = setup();
        await user.click(screen.getByRole('button', { name: 'New variable' }));
        await user.click(screen.getByRole('button', { name: 'Cancel editing variable' }));
        expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    });
});

describe('secrets', () => {
    it('shows a stored secret masked and Set, never a value, and edits it through a password input', async () => {
        const { user } = setup();
        await user.click(tab('Secrets'));
        const row = screen.getByText('TOKEN').closest('li') as HTMLElement;
        expect(within(row).getByText('Set').isConnected).toBe(true);
        expect(row.textContent).toContain('•••••••');

        await edit(user, 'TOKEN');
        const input = valueInput('Secret new value');
        expect(input.getAttribute('type')).toBe('password');
        expect(input.value).toBe('');
        expect(input.placeholder).toBe('Leave blank to keep the current secret');
        await user.type(input, 'hunter2');
        await done(user, 'TOKEN');
        expect(screen.getByText('Will replace when saved').isConnected).toBe(true);
        expect(document.body.innerHTML).not.toContain('hunter2');
        const changed = screen.getByText('TOKEN').closest('li') as HTMLElement;
        expect(within(changed).getByRole('img', { name: 'Changed, not saved' }).isConnected).toBe(true);
    });

    it('keeps a typed secret out of the .env text and counts the secrets in one note', async () => {
        const { user } = setup();
        await user.click(tab('Secrets'));
        await edit(user, 'TOKEN');
        await user.type(valueInput('Secret new value'), 'hunter2');
        await done(user, 'TOKEN');
        await user.click(tab('Variables'));
        await toRaw(user);
        expect(textarea().value).toBe('LOG_LEVEL=debug\nEMPTY=\nQUOTED=""x""');
        expect(textarea().value).not.toContain('TOKEN');
        expect(textarea().value).not.toContain('hunter2');
        expect(document.body.innerHTML).not.toContain('hunter2');
        expect(screen.getByText('1 secret is edited in the Secrets tab.').isConnected).toBe(true);
    });

    it('refuses a new secret with no value, then sends it once it has one', async () => {
        const { user, onSave } = setup();
        await user.click(tab('Secrets'));
        await user.click(screen.getByRole('button', { name: 'New secret' }));
        expect(valueInput('Secret new value').placeholder).toBe('Secret value');
        await user.type(screen.getByLabelText('Secret name'), 'NEW_S{Enter}');
        expect(screen.getByText('Enter a value or remove the row.').isConnected).toBe(true);
        await user.click(saveButton() as HTMLButtonElement);
        expect(onSave).not.toHaveBeenCalled();

        await user.type(valueInput('Secret new value'), 's3cret{Enter}');
        expect(screen.getByText('Will replace when saved').isConnected).toBe(true);
        await user.click(saveButton() as HTMLButtonElement);
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave.mock.calls[0]![0]).toContainEqual({ name: 'NEW_S', value: 's3cret', isSecret: true });
        expect(onSave.mock.calls[0]![0]).toContainEqual({ name: 'TOKEN', value: null, isSecret: true });
        await screen.findByText('Changes saved.');
        expect(document.body.innerHTML).not.toContain('s3cret');
    });
});

describe('the save bar', () => {
    it('is absent while the draft is clean and appears with the first edit', async () => {
        const { user } = setup();
        expect(document.querySelector('.env-savebar')).toBeNull();
        expect(saveButton()).toBeNull();
        await edit(user, 'LOG_LEVEL');
        expect(document.querySelector('.env-savebar')).toBeNull();
        await user.type(valueInput(), 'x');
        const bar = within(document.querySelector('.env-savebar') as HTMLElement);
        expect(bar.getByText('Unsaved changes').isConnected).toBe(true);
        expect(bar.getByRole('button', { name: 'Discard' }).isConnected).toBe(true);
        expect(bar.getByRole('button', { name: 'Save changes' }).className).toContain('primary');
    });

    it('goes away again when an edit is typed back to the stored value', async () => {
        const { user } = setup();
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x');
        expect(saveButton()).not.toBeNull();
        await user.type(valueInput(), '{Backspace}');
        expect(saveButton()).toBeNull();
    });

    it('sends the whole list once, a removal as its omission, and confirms with Changes saved.', async () => {
        const { user, onSave } = setup();
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x{Enter}');
        await user.click(screen.getByRole('button', { name: 'Remove EMPTY' }));
        await user.click(screen.getByRole('button', { name: 'New variable' }));
        await user.type(screen.getByLabelText('Variable name'), 'ADDED');
        await user.tab();
        await user.type(valueInput(), 'new{Enter}');
        await user.click(saveButton() as HTMLButtonElement);

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave).toHaveBeenCalledWith([
            { name: 'LOG_LEVEL', value: 'debugx', isSecret: false },
            { name: 'QUOTED', value: '"x"', isSecret: false },
            { name: 'TOKEN', value: null, isSecret: true },
            { name: 'ADDED', value: 'new', isSecret: false },
        ]);
        expect((await screen.findByRole('status')).textContent).toBe('Changes saved.');
    });

    it('adopts the echo as the new baseline: bar gone, no marker, the added row stored, and the next edit clears the line', async () => {
        const { user } = setup();
        await user.click(screen.getByRole('button', { name: 'New variable' }));
        await user.type(screen.getByLabelText('Variable name'), 'ADDED{Enter}');
        await user.click(saveButton() as HTMLButtonElement);
        await screen.findByText('Changes saved.');

        expect(document.querySelector('.env-savebar')).toBeNull();
        expect(screen.queryByText('Unsaved changes')).toBeNull();
        expect(screen.queryByRole('img', { name: /not saved/ })).toBeNull();
        expect(screen.queryByText('Not saved yet')).toBeNull();
        expect(rowNames()).toEqual(['ADDED', 'EMPTY', 'LOG_LEVEL', 'QUOTED']);

        // The baseline moved with the save: reverting is an edit away from the new stored value.
        await edit(user, 'ADDED');
        await user.type(valueInput(), 'v');
        expect(screen.getByRole('status').textContent).toBe('');
        expect(saveButton()).not.toBeNull();
    });

    it('shows Saving changes… while in flight and locks the controls', async () => {
        let release: (result: EnvSaveResult) => void = () => undefined;
        const { user } = setup({ onSave: () => new Promise<EnvSaveResult>((resolve) => (release = resolve)) });
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x{Enter}');
        await user.click(saveButton() as HTMLButtonElement);
        const busy = await screen.findByRole('button', { name: 'Saving changes…' });
        expect((busy as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(true);
        expect((screen.getByRole('button', { name: 'New variable' }) as HTMLButtonElement).disabled).toBe(true);
        await act(async () => release({ error: null, vars: [] }));
        await waitFor(() => expect(saveButton()).toBeNull());
    });

    it('keeps the draft and shows the server’s error, focused, when the save is refused', async () => {
        const { user } = setup({ onSave: async () => ({ error: 'Server said no', vars: [] }) });
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x{Enter}');
        await user.click(saveButton() as HTMLButtonElement);
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toBe('Server said no');
        await waitFor(() => expect(document.activeElement).toBe(alert));
        expect(screen.getByText('debugx').isConnected).toBe(true);
        expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
        expect(screen.getByRole('status').textContent).toBe('');

        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'y');
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('resets everything on Discard at once, with no confirm, and leaves the raw mode', async () => {
        const { user } = setup();
        await toRaw(user);
        await replaceRawText(user, 'ONLY=1');
        expect(saveButton()).not.toBeNull();
        await user.click(screen.getByRole('button', { name: 'Discard' }));
        expect(screen.queryByRole('textbox', { name: 'Variables as .env text' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Raw editor' }).isConnected).toBe(true);
        expect(rowNames()).toEqual(['EMPTY', 'LOG_LEVEL', 'QUOTED']);
        expect(document.querySelector('.env-savebar')).toBeNull();
        expect(within(tab('Variables')).queryByRole('img')).toBeNull();
    });

    it('drops a staged removal and an open edit on Discard', async () => {
        const { user } = setup();
        await user.click(screen.getByRole('button', { name: 'Remove EMPTY' }));
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x');
        await user.click(screen.getByRole('button', { name: 'Discard' }));
        expect(screen.queryByLabelText('Variable value')).toBeNull();
        expect(screen.queryByText('Removed when you save')).toBeNull();
        expect(rowNames()).toEqual(['EMPTY', 'LOG_LEVEL', 'QUOTED']);
    });
});

describe('the raw .env text', () => {
    it('serializes the variables live, with no Apply step and the secrets left out', async () => {
        const { user } = setup();
        await toRaw(user);
        expect(textarea().value).toBe('LOG_LEVEL=debug\nEMPTY=\nQUOTED=""x""');
        expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
        expect(screen.queryByRole('searchbox')).toBeNull();
        expect(screen.queryByRole('button', { name: 'New variable' })).toBeNull();
        expect(screen.getByRole('button', { name: 'List view' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByText('1 secret is edited in the Secrets tab.').isConnected).toBe(true);
    });

    it('parses the text back live, empty and quoted values intact, and Save sends one whole list', async () => {
        const { user, onSave } = setup();
        await toRaw(user);
        await replaceRawText(user, 'A=1\nB=\nC="q"\nD="  spaced  "');
        expect(screen.queryByRole('alert')).toBeNull();
        await toList(user);
        expect(rowNames()).toEqual(['A', 'B', 'C', 'D']);
        await user.click(tab('Secrets'));
        expect(rowNames()).toEqual(['TOKEN']);
        await user.click(saveButton() as HTMLButtonElement);
        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
        expect(onSave).toHaveBeenCalledWith([
            { name: 'A', value: '1', isSecret: false },
            { name: 'B', value: '', isSecret: false },
            { name: 'C', value: 'q', isSecret: false },
            { name: 'D', value: '  spaced  ', isSecret: false },
            { name: 'TOKEN', value: null, isSecret: true },
        ]);
    });

    it('stays clean through a list -> text -> list round trip, and through retyping the same text', async () => {
        const { user, onSave } = setup();
        await toRaw(user);
        await toList(user);
        expect(saveButton()).toBeNull();
        await toRaw(user);
        await replaceRawText(user, 'LOG_LEVEL=debug\nEMPTY=\nQUOTED=""x""');
        expect(saveButton()).toBeNull();
        expect(screen.queryByText('Unsaved changes')).toBeNull();
        await toList(user);
        expect(screen.queryByRole('img', { name: /not saved/ })).toBeNull();
        expect(screen.getAllByText(/^Updated /)).toHaveLength(3);
        expect(onSave).not.toHaveBeenCalled();
    });

    it('refuses to leave a malformed text: line-numbered errors, rows kept, Save off, nothing sent', async () => {
        const { user, onSave } = setup();
        await toRaw(user);
        await user.type(textarea(), '\nnot a pair\nTOKEN=x');
        const errors = screen.getByRole('alert');
        expect(errors.textContent).toContain('line 4: expected KEY=value');
        expect(errors.textContent).toContain('line 5: "TOKEN" is already a secret');
        expect(textarea().getAttribute('aria-invalid')).toBe('true');

        await toList(user);
        expect(textarea().isConnected).toBe(true);
        expect(textarea().value).toContain('not a pair');
        await user.click(tab('Secrets'));
        expect(textarea().isConnected).toBe(true);
        expect(tab('Variables').getAttribute('aria-selected')).toBe('true');
        expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
        expect(onSave).not.toHaveBeenCalled();
    });

    it('never overwrites the rows with an unparsable text: fixing it and switching back restores them whole', async () => {
        const { user } = setup();
        await toRaw(user);
        await user.clear(textarea());
        expect(screen.queryByRole('alert')).toBeNull();
        await user.type(textarea(), 'ok');
        expect(screen.getByRole('alert').isConnected).toBe(true);
        await replaceRawText(user, 'LOG_LEVEL=debug');
        expect(screen.queryByRole('alert')).toBeNull();
        await toList(user);
        expect(rowNames()).toEqual(['LOG_LEVEL']);
    });

    it('leaves the raw mode on a tab switch while the text parses', async () => {
        const { user } = setup();
        await toRaw(user);
        await user.click(tab('Secrets'));
        expect(screen.queryByRole('textbox', { name: 'Variables as .env text' })).toBeNull();
        expect(rowNames()).toEqual(['TOKEN']);
    });
});

describe('the unsaved-change guard', () => {
    it('registers the scope clean, then dirty on an edit, and its discard resets the draft', async () => {
        const { user, guard } = setup();
        expect(guard.draft()).toMatchObject({ id: 'org', label: 'Organization variables', dirty: false });
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x');
        expect(guard.draft()?.dirty).toBe(true);

        act(() => guard.draft()?.discard());
        expect(guard.draft()?.dirty).toBe(false);
        expect(screen.queryByLabelText('Variable value')).toBeNull();
        expect(screen.getByText('debug').isConnected).toBe(true);
        expect(saveButton()).toBeNull();
    });

    it('sees a malformed raw text as unsaved changes even though the rows were never touched', async () => {
        const { user, guard } = setup();
        await toRaw(user);
        expect(guard.draft()?.dirty).toBe(false);
        await user.type(textarea(), '\nbroken');
        expect(guard.draft()?.dirty).toBe(true);
        act(() => guard.draft()?.discard());
        expect(guard.draft()?.dirty).toBe(false);
        expect(screen.queryByRole('textbox', { name: 'Variables as .env text' })).toBeNull();
    });

    it('goes clean again after a successful save', async () => {
        const { user, guard } = setup();
        await edit(user, 'LOG_LEVEL');
        await user.type(valueInput(), 'x{Enter}');
        expect(guard.draft()?.dirty).toBe(true);
        await user.click(saveButton() as HTMLButtonElement);
        await screen.findByText('Changes saved.');
        expect(guard.draft()?.dirty).toBe(false);
    });
});
