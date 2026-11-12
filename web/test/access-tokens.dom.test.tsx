import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AccessTokenView } from '../src/api/useAccessTokens.js';
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
