import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, installationRepo, settingsBoard } from './settings-board.js';

/**
 * The repositories page mounted through the real route table over a stubbed board tracking one
 * repository: the list, with no selection, save or checkout surface, and Configure's focus and
 * environment editor. The rows' markup is `repository-setup.render.test.tsx`'s.
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
        within(detail).getByText(`Repository · ${REPO}`);
        expect(detail.textContent).not.toContain('Not checked out');
        expect(detail.textContent).not.toContain('Not available');
        expect(document.querySelectorAll('tr.repo-row-configured')).toHaveLength(1);
        expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
    });
});
