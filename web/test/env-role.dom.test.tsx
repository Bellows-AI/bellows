import { MEMBER_ROLE, type Role } from '@factory-ai/core';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ENV_ADMIN_NOTE } from '../src/panels/EnvVarsSection.js';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, installationRepo, settingsBoard } from './settings-board.js';

/**
 * The organization and repository environment scopes are an admin's to write (the server answers a member 403):
 * a member reads the stored rows with no New, Raw editor, Edit or Remove control and a sentence naming who manages
 * them; an admin keeps the editor. The workspace scope is every member's own and stays editable.
 */

const REPO = 'Bellows-AI/bellows.ai';
const AT = '2026-09-01T12:00:00.000Z';
const row = (name: string) => ({ name, value: 'on', isSecret: false, updatedAt: AT });

function stubEnv(role?: Role) {
    const board = settingsBoard({
        ...(role ? { role } : {}),
        installationRepos: [installationRepo('Bellows-AI', 'bellows.ai')],
    });
    return stubFetch(
        boardHandler(board, ({ method, url }) =>
            method === 'GET' && url === '/api/env'
                ? {
                      org: [row('ORG_FLAG')],
                      workspace: [row('MY_FLAG')],
                      repos: [{ owner: 'Bellows-AI', name: 'bellows.ai', vars: [row('REPO_FLAG')] }],
                  }
                : undefined
        )
    );
}

const writeControls = (editor: ReturnType<typeof within>) => [
    editor.queryByRole('button', { name: 'New variable' }),
    editor.queryByRole('button', { name: /Raw editor/ }),
    editor.queryByRole('button', { name: /^Edit / }),
    editor.queryByRole('button', { name: /^Remove / }),
];

async function orgEditor() {
    renderApp('/settings/organization');
    const editor = within(await screen.findByRole('region', { name: 'Organization variables' }));
    await editor.findByText('ORG_FLAG');
    return editor;
}

async function repoEditor() {
    const user = userEvent.setup();
    renderApp('/settings/repos');
    await user.click(await screen.findByRole('button', { name: 'Configure' }));
    const editor = within(await screen.findByRole('region', { name: REPO }));
    await editor.findByText('REPO_FLAG');
    return editor;
}

describe('the admin-only environment scopes', () => {
    it.each([
        ['organization', orgEditor],
        ['repository', repoEditor],
    ] as const)('a member reads the %s scope with no write control and the admin sentence', async (_s, open) => {
        stubEnv(MEMBER_ROLE);
        const editor = await open();
        expect(writeControls(editor)).toEqual([null, null, null, null]);
        expect(editor.getByText(ENV_ADMIN_NOTE)).toBeTruthy();
    });

    it.each([
        ['organization', orgEditor],
        ['repository', repoEditor],
    ] as const)('an admin edits the %s scope and sees no admin sentence', async (_s, open) => {
        stubEnv();
        const editor = await open();
        for (const control of writeControls(editor)) expect(control).not.toBeNull();
        expect(editor.queryByText(ENV_ADMIN_NOTE)).toBeNull();
    });

    it('a member keeps every control on their own workspace scope', async () => {
        stubEnv(MEMBER_ROLE);
        renderApp('/settings/workspace');
        const editor = within(await screen.findByRole('region', { name: 'Workspace variables' }));
        await editor.findByText('MY_FLAG');
        for (const control of writeControls(editor)) expect(control).not.toBeNull();
        expect(editor.queryByText(ENV_ADMIN_NOTE)).toBeNull();
    });
});
