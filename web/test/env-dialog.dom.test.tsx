import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EnvVarsDialog } from '../src/components/EnvVarsDialog.js';
import type { EnvVarsDialogProps } from '../src/components/EnvVarsDialog.js';
import type { EnvPayloadRow } from '../src/panels/env-draft.js';
import './dom.js';

/**
 * The variables editor modal (BEL-262a), mounted on its own: one shared draft across the list and
 * the `.env` text, no Apply step, nothing persisted until Save, a nested discard confirm on a
 * dirty close. The settings pages do not mount it yet (262b), so the harness is the caller.
 */

const STORED: EnvPayloadRow[] = [
    { name: 'LOG_LEVEL', value: 'debug', isSecret: false },
    { name: 'EMPTY', value: '', isSecret: false },
    { name: 'QUOTED', value: '"x"', isSecret: false },
    { name: 'TOKEN', value: null, isSecret: true },
];

function setup(overrides: Partial<EnvVarsDialogProps> = {}) {
    const onClose = vi.fn();
    const onSave = vi.fn(async (vars: EnvPayloadRow[]) => ({
        error: null,
        vars: vars.map((v) => ({ ...v, value: v.isSecret ? null : v.value, updatedAt: '2026-09-01T12:00:00.000Z' })),
    }));
    const props: EnvVarsDialogProps = {
        title: 'Core (organization) variables',
        scope: { scope: 'organization' },
        initialVars: STORED,
        onSave,
        onClose,
        ...overrides,
    };
    const user = userEvent.setup();
    const view = render(<EnvVarsDialog {...props} />);
    return { user, view, onClose, onSave, dialog: () => screen.getByRole('dialog', { name: props.title }) };
}

const textarea = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: /variables as \.env/i });
const toEnv = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: '.env' }));
const toList = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'List' }));

describe('the variables editor modal', () => {
    it('opens as a named dialog listing variables and secrets as rows, the secret masked and Set', () => {
        const { dialog } = setup();
        const view = within(dialog());
        expect((view.getByLabelText('Variable 1 name') as HTMLInputElement).value).toBe('LOG_LEVEL');
        expect((view.getByLabelText('Variable 3 value') as HTMLInputElement).value).toBe('"x"');
        expect((view.getByLabelText('Secret 1 name') as HTMLInputElement).value).toBe('TOKEN');
        expect(view.getByLabelText('Secret 1 new value').getAttribute('type')).toBe('password');
        expect(view.getByText('Set').isConnected).toBe(true);
    });

    it('serializes live into the text mode, keeps secrets out of it and counts them in one note', async () => {
        const { user } = setup();
        await user.type(screen.getByLabelText('Secret 1 new value'), 'hunter2');
        await toEnv(user);
        expect(textarea().value).toBe('LOG_LEVEL=debug\nEMPTY=\nQUOTED=""x""');
        expect(textarea().value).not.toContain('TOKEN');
        expect(textarea().value).not.toContain('hunter2');
        expect(document.body.innerHTML).not.toContain('hunter2');
        expect(screen.getByText('1 secret is edited in the list view.').isConnected).toBe(true);
    });

    it('parses the text back live with no Apply step, empty and quoted values intact, and Save sends one whole list', async () => {
        const { user, onSave, onClose } = setup();
        await toEnv(user);
        expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
        await user.clear(textarea());
        await user.click(textarea());
        await user.paste('A=1\nB=\nC="q"\nD="  spaced  "');
        await toList(user);
        expect((screen.getByLabelText('Variable 2 value') as HTMLInputElement).value).toBe('');
        expect((screen.getByLabelText('Variable 3 value') as HTMLInputElement).value).toBe('q');
        expect((screen.getByLabelText('Variable 4 value') as HTMLInputElement).value).toBe('  spaced  ');
        expect((screen.getByLabelText('Secret 1 name') as HTMLInputElement).value).toBe('TOKEN');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
        expect(onSave).toHaveBeenCalledWith([
            { name: 'A', value: '1', isSecret: false },
            { name: 'B', value: '', isSecret: false },
            { name: 'C', value: 'q', isSecret: false },
            { name: 'D', value: '  spaced  ', isSecret: false },
            { name: 'TOKEN', value: null, isSecret: true },
        ]);
    });

    it('stays clean and Save stays disabled through a list -> text -> list round trip', async () => {
        const { user, onSave } = setup();
        await toEnv(user);
        await toList(user);
        expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.queryByText('Unsaved changes')).toBeNull();
        expect(onSave).not.toHaveBeenCalled();
    });

    it('refuses to leave a malformed text: line-numbered errors, text kept, Save off, nothing sent', async () => {
        const { user, onSave } = setup();
        await toEnv(user);
        await user.type(textarea(), '\nnot a pair\nTOKEN=x');
        const errors = screen.getByRole('alert');
        expect(errors.textContent).toContain('line 4: expected KEY=value');
        expect(errors.textContent).toContain('line 5: "TOKEN" is already a secret');
        await toList(user);
        expect(textarea().isConnected).toBe(true);
        expect(textarea().value).toContain('not a pair');
        expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
        expect(onSave).not.toHaveBeenCalled();
    });

    it('never overwrites the list with an unparsable text: fixing the text and switching back restores it whole', async () => {
        const { user } = setup();
        await toEnv(user);
        await user.clear(textarea());
        expect(screen.queryByRole('alert')).toBeNull();
        await user.type(textarea(), 'ok');
        expect(screen.getByRole('alert').isConnected).toBe(true);
        await user.clear(textarea());
        await user.click(textarea());
        await user.paste('LOG_LEVEL=debug');
        await toList(user);
        expect((screen.getByLabelText('Variable 1 name') as HTMLInputElement).value).toBe('LOG_LEVEL');
        expect(screen.queryByLabelText('Variable 2 name')).toBeNull();
    });

    it('keeps the dialog open and the draft when the save is refused', async () => {
        const { user, onClose } = setup({ onSave: async () => ({ error: 'Server said no', vars: [] }) });
        await user.type(screen.getByLabelText('Variable 1 value'), 'x');
        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        expect((await screen.findByText('Server said no')).isConnected).toBe(true);
        expect((screen.getByLabelText('Variable 1 value') as HTMLInputElement).value).toBe('debugx');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('mirrors the dirty state to the caller', async () => {
        const onDirtyChange = vi.fn();
        const { user } = setup({ onDirtyChange });
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
        await user.type(screen.getByLabelText('Variable 1 value'), 'x');
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    });
});

describe('closing the variables editor modal', () => {
    it('closes at once from Escape, Cancel and the backdrop while clean', async () => {
        for (const close of [
            (u: ReturnType<typeof userEvent.setup>) => u.keyboard('{Escape}'),
            (u: ReturnType<typeof userEvent.setup>) => u.click(screen.getByRole('button', { name: 'Cancel' })),
            (u: ReturnType<typeof userEvent.setup>) =>
                u.click(document.querySelector('.dialog-position') as HTMLElement),
        ]) {
            const { user, onClose, view } = setup();
            await close(user);
            await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
            expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
            view.unmount();
        }
    });

    it('asks before discarding a dirty draft, from Escape, Cancel and the backdrop alike', async () => {
        for (const close of [
            (u: ReturnType<typeof userEvent.setup>) => u.keyboard('{Escape}'),
            (u: ReturnType<typeof userEvent.setup>) => u.click(screen.getByRole('button', { name: 'Cancel' })),
            (u: ReturnType<typeof userEvent.setup>) =>
                u.click(document.querySelector('.dialog-position') as HTMLElement),
        ]) {
            const { user, onClose, view } = setup();
            await user.type(screen.getByLabelText('Variable 1 value'), 'x');
            await close(user);
            expect((await screen.findByText('Discard unsaved changes?')).isConnected).toBe(true);
            expect(onClose).not.toHaveBeenCalled();
            view.unmount();
        }
    });

    it('Continue editing keeps the draft; Discard changes closes; Escape in the confirm only dismisses it', async () => {
        const { user, onClose } = setup();
        await user.type(screen.getByLabelText('Variable 1 value'), 'x');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByText('Discard unsaved changes?')).toBeNull());
        expect(onClose).not.toHaveBeenCalled();
        expect((screen.getByLabelText('Variable 1 value') as HTMLInputElement).value).toBe('debugx');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await user.click(await screen.findByRole('button', { name: 'Continue editing' }));
        expect(onClose).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('treats a malformed text as unsaved changes', async () => {
        const { user } = setup();
        await toEnv(user);
        await user.type(textarea(), '\nbroken');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect((await screen.findByText('Discard unsaved changes?')).isConnected).toBe(true);
    });

    it('returns focus to the opener when the modal closes', async () => {
        function Host() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>
                        Edit variables
                    </button>
                    {open ? (
                        <EnvVarsDialog
                            title="Vars"
                            scope={{ scope: 'organization' }}
                            initialVars={STORED}
                            onSave={async () => ({ error: null, vars: [] })}
                            onClose={() => setOpen(false)}
                        />
                    ) : null}
                </>
            );
        }
        const user = userEvent.setup();
        render(<Host />);
        const opener = screen.getByRole('button', { name: 'Edit variables' });
        await user.click(opener);
        await screen.findByRole('dialog', { name: 'Vars' });
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(document.activeElement).toBe(opener);
    });
});

describe('the variables editor modal as a keyboard surface', () => {
    it('traps Tab inside the dialog', async () => {
        const { user, dialog } = setup();
        for (let step = 0; step < 40; step += 1) {
            await user.tab();
            expect(dialog().contains(document.activeElement)).toBe(true);
        }
    });

    it('adds a row from the keyboard, lands in its name, and removes it from the keyboard', async () => {
        const { user } = setup();
        const add = screen.getByRole('button', { name: 'Add variable' });
        add.focus();
        await user.keyboard('{Enter}');
        const name = screen.getByLabelText('Variable 4 name');
        expect(document.activeElement).toBe(name);
        await user.keyboard('NEW_ONE');
        await user.tab();
        await user.keyboard('v');
        await user.tab();
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove NEW_ONE' }));
        await user.keyboard('{Enter}');
        expect(screen.getByText('NEW_ONE will be removed when you save.').isConnected).toBe(true);
    });
});

describe('the variables editor modal with many variables', () => {
    const MANY: EnvPayloadRow[] = Array.from({ length: 200 }, (_, i) => ({
        name: `VAR_${String(i).padStart(3, '0')}`,
        value: `value ${i}`,
        isSecret: false,
    }));

    it('renders every row and keeps Save and Cancel in a footer outside the scrolling body', () => {
        const { dialog } = setup({ initialVars: MANY });
        const view = within(dialog());
        expect(view.getAllByLabelText(/^Variable \d+ name$/)).toHaveLength(200);
        const body = dialog().querySelector('.env-dialog-body') as HTMLElement;
        const footer = dialog().querySelector('.env-dialog-footer') as HTMLElement;
        expect(body).not.toBeNull();
        expect(footer).not.toBeNull();
        expect(body.contains(footer)).toBe(false);
        expect(body.contains(view.getByLabelText('Variable 200 name'))).toBe(true);
        expect(footer.contains(view.getByRole('button', { name: 'Save changes' }))).toBe(true);
        expect(footer.contains(view.getByRole('button', { name: 'Cancel' }))).toBe(true);
    });
});
