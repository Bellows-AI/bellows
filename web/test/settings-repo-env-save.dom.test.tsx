import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, installationRepo, settingsBoard } from './settings-board.js';

/**
 * The repositories page's environment scope on the wire: the stored scopes are matched by their
 * {forge, host, path} ref, and a save names the repository the same way.
 */

const STORED_AT = '2026-09-01T12:00:00.000Z';
const GITHUB_WEB = { forge: 'github', host: 'github.com', path: 'acme/web' };
const GITLAB_WEB = { forge: 'gitlab', host: 'gl.example', path: 'acme/web' };

function board() {
    const handle = boardHandler(settingsBoard({ installationRepos: [installationRepo('acme', 'web')] }));
    return stubFetch((call) => {
        if (call.method === 'GET' && call.url === '/api/env') {
            return {
                org: [],
                workspace: [],
                repos: [
                    {
                        repo: GITLAB_WEB,
                        vars: [{ name: 'ELSEWHERE', value: 'x', isSecret: false, updatedAt: STORED_AT }],
                    },
                    { repo: GITHUB_WEB, vars: [{ name: 'HERE', value: 'y', isSecret: false, updatedAt: STORED_AT }] },
                ],
            };
        }
        if (call.method === 'PUT' && call.url === '/api/env/repo') {
            const { vars } = call.body as { vars: { name: string; value: string; isSecret: boolean }[] };
            return { vars: vars.map((v) => ({ ...v, updatedAt: STORED_AT })) };
        }
        return handle(call);
    });
}

describe('the repositories page environment scope', () => {
    it('reads the scope stored for this repo’s ref and saves it by {forge, host, path}', async () => {
        const calls = board();
        const user = userEvent.setup();
        renderApp('/settings/repos');

        await user.click(await screen.findByRole('button', { name: 'Configure' }));
        const editor = within(await screen.findByRole('region', { name: 'acme/web' }));
        expect(await editor.findByText('HERE')).toBeTruthy();
        // The same path on another host is another repository: its variables are not this one's.
        expect(editor.queryByText('ELSEWHERE')).toBeNull();

        await user.click(editor.getByRole('button', { name: 'New variable' }));
        await user.type(editor.getByLabelText('Variable name'), 'NEW_ONE{Enter}');
        await user.click(editor.getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
        const put = calls.find((c) => c.method === 'PUT')!;
        expect(put.url).toBe('/api/env/repo');
        expect((put.body as { repo: unknown }).repo).toEqual(GITHUB_WEB);
    });
});
