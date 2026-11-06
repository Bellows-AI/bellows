import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, installationRepo, settingsBoard } from './settings-board.js';

/**
 * The repositories page mounted through the real route table over a stubbed board tracking one
 * repository: the list, with no selection, save or checkout surface, and Configure's focus and
 * inline environment editor. The rows' markup is `repository-setup.render.test.tsx`'s.
 */

const REPO = 'Bellows-AI/bellows.ai';

describe('the repositories page', () => {
    it('lists the tracked repositories and opens an environment editor behind Configure', async () => {
        stubFetch(boardHandler(settingsBoard({ installationRepos: [installationRepo('Bellows-AI', 'bellows.ai')] })));
        const user = userEvent.setup();
        renderApp('/settings/repos');

        await screen.findByText(REPO);
        screen.getByLabelText('Search repositories');
        expect(screen.queryByRole('checkbox')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Save selection' })).toBeNull();
        expect(document.querySelector('.banner-warn')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Configure' }));
        const heading = await screen.findByRole('heading', { name: `Selected repository: ${REPO}` });
        await waitFor(() => expect(document.activeElement).toBe(heading));
        const detail = document.querySelector('.repo-detail') as HTMLElement;
        const editor = within(await within(detail).findByRole('region', { name: REPO }));
        expect(editor.getByText('No variables yet.')).toBeTruthy();
        expect(editor.queryByRole('button', { name: 'Save changes' })).toBeNull();
        expect(detail.textContent).not.toContain('Not checked out');
        expect(detail.textContent).not.toContain('Not available');
        expect(document.querySelectorAll('tr.repo-row-configured')).toHaveLength(1);
        expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
    });

    it('asks before Configure on another repository drops the open editor’s unsaved edits', async () => {
        stubFetch(
            boardHandler(
                settingsBoard({
                    installationRepos: [
                        installationRepo('Bellows-AI', 'bellows.ai'),
                        installationRepo('octo', 'hooks'),
                    ],
                })
            )
        );
        const user = userEvent.setup();
        renderApp('/settings/repos');
        await screen.findByText(REPO);

        await user.click(screen.getAllByRole('button', { name: 'Configure' })[0]!);
        const editor = within(await screen.findByRole('region', { name: /^(Bellows-AI\/bellows\.ai|octo\/hooks)$/ }));
        await user.click(editor.getByRole('button', { name: 'New variable' }));
        await user.type(editor.getByLabelText('Variable name'), 'E2E_UNSAVED{Enter}');

        await user.click(screen.getAllByRole('button', { name: 'Configure' })[1]!);
        // The edits live in the draft the settings area guards: switching must not lose them silently.
        expect(await screen.findByText('Discard unsaved changes?')).toBeTruthy();
    });
});
