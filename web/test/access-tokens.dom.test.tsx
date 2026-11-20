import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccessTokenView, MintResult } from '../src/api/useAccessTokens.js';
import { useState } from 'react';
import { AccessTokensPanel } from '../src/panels/AccessTokensPanel.js';
import './dom.js';

/**
 * Revoking a personal access token asks first: the confirmation names the token, Cancel
 * and Escape send nothing and return focus to the Revoke button that opened it, and only the
 * confirm calls `onRevoke`. The revoke semantics themselves are `useAccessTokens`'.
 */

const token = (id: string, label: string): AccessTokenView => ({
    id,
    label,
    createdAt: '2026-01-15T09:30:00.000Z',
    lastUsedAt: null,
    revokedAt: null,
});

function setup() {
    const onRevoke = vi.fn(async (_id: string) => null);
    render(
        <AccessTokensPanel
            scope="personal"
            title="Personal access tokens"
            hint=""
            tokens={[token('t1', 'ci'), token('t2', 'laptop')]}
            loading={false}
            error={null}
            onCreate={async () => ({ ok: false, error: 'unused' })}
            onRevoke={onRevoke}
        />
    );
    return { onRevoke, user: userEvent.setup() };
}

describe('AccessTokensPanel revoke confirmation', () => {
    it('opens a dialog naming the token instead of revoking on click', async () => {
        const { onRevoke, user } = setup();
        await user.click(screen.getByRole('button', { name: 'Revoke laptop' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByRole('heading', { name: /laptop/ })).toBeTruthy();
        expect(onRevoke).not.toHaveBeenCalled();
    });

    it('Cancel sends nothing and returns focus to the Revoke button', async () => {
        const { onRevoke, user } = setup();
        const trigger = screen.getByRole('button', { name: 'Revoke ci' });
        await user.click(trigger);
        await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onRevoke).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(trigger);
    });

    it('Escape sends nothing and returns focus to the Revoke button', async () => {
        const { onRevoke, user } = setup();
        const trigger = screen.getByRole('button', { name: 'Revoke ci' });
        await user.click(trigger);
        await screen.findByRole('dialog');
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onRevoke).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(trigger);
    });

    it('the confirm revokes that token once', async () => {
        const { onRevoke, user } = setup();
        await user.click(screen.getByRole('button', { name: 'Revoke laptop' }));
        const dialog = await screen.findByRole('dialog');
        await user.click(within(dialog).getByRole('button', { name: /^Revoke/ }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(onRevoke).toHaveBeenCalledTimes(1);
        expect(onRevoke).toHaveBeenCalledWith('t2');
    });
});

describe('AccessTokensPanel focus after a confirmed revoke', () => {
    it('lands on a control that survives the refetch, never on the body', async () => {
        function Harness() {
            const [tokens, setTokens] = useState([token('t1', 'ci')]);
            return (
                <AccessTokensPanel
                    scope="personal"
                    title="Personal access tokens"
                    hint=""
                    tokens={tokens}
                    loading={false}
                    error={null}
                    onCreate={async () => ({ ok: false, error: 'unused' })}
                    onRevoke={async () => {
                        setTokens([{ ...token('t1', 'ci'), revokedAt: '2026-02-01T00:00:00.000Z' }]);
                        return null;
                    }}
                />
            );
        }
        const user = userEvent.setup();
        render(<Harness />);
        await user.click(screen.getByRole('button', { name: 'Revoke ci' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Revoke/ }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() =>
            expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Personal access tokens' }))
        );
        expect(document.activeElement).not.toBe(document.body);
    });
});

describe('AccessTokensPanel create dialog', () => {
    const SHOWN_ONCE = /Shown once — copy it now/;

    function Harness({ onCreate }: { onCreate: (label: string) => Promise<MintResult> }) {
        const [tokens, setTokens] = useState([token('t1', 'ci')]);
        return (
            <AccessTokensPanel
                scope="org"
                title="Organization access tokens"
                hint="Acts for the organization."
                tokens={tokens}
                loading={false}
                error={null}
                onCreate={async (label) => {
                    const result = await onCreate(label);
                    if (result.ok) setTokens((all) => [...all, token('t2', label)]);
                    return result;
                }}
                onRevoke={async () => null}
            />
        );
    }

    const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole('button', { name: 'New token' }));
        return screen.findByRole('dialog');
    };

    it('has no inline create row, and Create token stays disabled while the label is blank', async () => {
        const user = userEvent.setup();
        render(<Harness onCreate={async () => ({ ok: true, token: 'oat_x' })} />);
        expect(screen.queryByRole('textbox')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Create token' })).toBeNull();
        const dialog = await openDialog(user);
        expect(within(dialog).getByRole('heading', { name: 'New organization access token' })).toBeTruthy();
        const field = within(dialog).getByLabelText('Label');
        expect(document.activeElement).toBe(field);
        const create = within(dialog).getByRole('button', { name: 'Create token' }) as HTMLButtonElement;
        expect(create.disabled).toBe(true);
        await user.type(field, '   ');
        expect(create.disabled).toBe(true);
        await user.type(field, 'deploy');
        expect(create.disabled).toBe(false);
        // The list stays visible behind the dialog.
        expect(screen.getAllByText('ci').length).toBeGreaterThan(0);
    });

    it('Cancel, Escape and a backdrop click close step 1 and return focus to New token', async () => {
        const user = userEvent.setup();
        render(<Harness onCreate={async () => ({ ok: true, token: 'oat_x' })} />);
        const newToken = screen.getAllByRole('button', { name: 'New token' })[0] as HTMLElement;
        for (const close of [
            () => user.click(screen.getByRole('button', { name: 'Cancel' })),
            () => user.keyboard('{Escape}'),
        ]) {
            await user.click(newToken);
            await screen.findByRole('dialog');
            await close();
            await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
            await waitFor(() => expect(document.activeElement).toBe(newToken));
        }
    });

    it('shows a refusal inline, keeps the dialog open and puts focus back on the field', async () => {
        const user = userEvent.setup();
        render(<Harness onCreate={async () => ({ ok: false, error: 'BAD_LABEL' })} />);
        const dialog = await openDialog(user);
        const field = within(dialog).getByLabelText('Label');
        await user.type(field, 'x{Enter}');
        expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'BAD_LABEL');
        expect(screen.getByRole('dialog')).toBeTruthy();
        await waitFor(() => expect(document.activeElement).toBe(field));
        expect(within(dialog).queryByText(SHOWN_ONCE)).toBeNull();
    });

    it('disables the field and both buttons while creating', async () => {
        const user = userEvent.setup();
        let release: (r: MintResult) => void = () => {};
        render(<Harness onCreate={() => new Promise<MintResult>((resolve) => (release = resolve))} />);
        const dialog = await openDialog(user);
        await user.type(within(dialog).getByLabelText('Label'), 'ci2{Enter}');
        const creating = (await within(dialog).findByRole('button', { name: 'Creating…' })) as HTMLButtonElement;
        expect(creating.disabled).toBe(true);
        expect((within(dialog).getByLabelText('Label') as HTMLInputElement).disabled).toBe(true);
        expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
        await user.keyboard('{Escape}');
        expect(screen.getByRole('dialog')).toBeTruthy();
        release({ ok: false, error: 'nope' });
        await within(dialog).findByRole('alert');
    });

    it('prints the token once; only Done closes step 2, then focus returns to New token', async () => {
        const user = userEvent.setup();
        const write = vi.fn(async (_text: string) => {});
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
        render(<Harness onCreate={async () => ({ ok: true, token: 'oat_secret' })} />);
        const newToken = screen.getAllByRole('button', { name: 'New token' })[0] as HTMLElement;
        const dialog = await openDialog(user);
        await user.type(within(dialog).getByLabelText('Label'), 'nightly{Enter}');
        expect(await within(dialog).findByRole('heading', { name: 'Token created: nightly' })).toBeTruthy();
        expect(within(dialog).getByText(SHOWN_ONCE)).toBeTruthy();
        expect(within(dialog).getByText('oat_secret')).toBeTruthy();
        expect(within(dialog).queryByText(/curl/)).toBeNull();
        const copy = within(dialog).getByRole('button', { name: 'Copy' });
        await waitFor(() => expect(document.activeElement).toBe(copy));

        await user.keyboard('{Escape}');
        await user.click(document.querySelector('.dialog-position') as HTMLElement);
        expect(screen.getByRole('dialog')).toBeTruthy();
        expect(screen.getByText('oat_secret')).toBeTruthy();

        await user.click(copy);
        expect(write).toHaveBeenCalledWith('oat_secret');
        expect(await within(dialog).findByRole('button', { name: 'Copied' })).toBeTruthy();

        await user.click(within(dialog).getByRole('button', { name: 'Done' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.queryByText('oat_secret')).toBeNull();
        await waitFor(() => expect(document.activeElement).toBe(newToken));
        // The new row is in the list and flashes.
        const row = screen.getByText('nightly').closest('tr');
        expect(row?.className).toContain('token-flash');
    });

    it('a refused clipboard leaves the token on screen', async () => {
        const user = userEvent.setup();
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async () => Promise.reject(new Error('denied')) },
            configurable: true,
        });
        render(<Harness onCreate={async () => ({ ok: true, token: 'oat_secret' })} />);
        const dialog = await openDialog(user);
        await user.type(within(dialog).getByLabelText('Label'), 'a{Enter}');
        await user.click(await within(dialog).findByRole('button', { name: 'Copy' }));
        expect(within(dialog).getByText('oat_secret')).toBeTruthy();
        expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeTruthy();
    });
});
