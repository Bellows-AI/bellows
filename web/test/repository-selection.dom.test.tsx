import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, installationRepo, settingsBoard } from './settings-board.js';

/**
 * The repositories page mounted through the real route table over a stubbed board offering one
 * repository with nothing selected: the selection's counts, the dirty draft meeting the settings
 * area's discard confirmation on a real in-app navigation, and Configure's focus and unavailable
 * checkout facts. The cards' arithmetic is `repository-setup.render.test.tsx`'s.
 */

const REPO = 'Bellows-AI/bellows.ai';
const checkbox = () => screen.getByRole<HTMLInputElement>('checkbox', { name: `Enable ${REPO} in my workspace` });
const cardValue = (label: string) =>
    [...document.querySelectorAll('.repo-card')]
        .find((card) => card.textContent?.includes(label))
        ?.querySelector('.repo-card-value')?.textContent;
const dashboardLink = () =>
    within(screen.getByRole('navigation', { name: 'Primary' })).getByRole('link', { name: 'Dashboard' });

describe('the repositories page', () => {
    it('carries the selection surface, and its draft meets the guard', async () => {
        stubFetch(boardHandler(settingsBoard({ installationRepos: [installationRepo('Bellows-AI', 'bellows.ai')] })));
        const user = userEvent.setup();
        const { router } = renderApp('/settings/repos');

        // One row, offered, nothing enabled — and the counts state their zero once both answered.
        await screen.findByRole('button', { name: 'Save selection' });
        await waitFor(() => expect(cardValue('Selected')).toBe('0'));
        const selected = [...document.querySelectorAll('.repo-card')].find((card) =>
            card.textContent?.includes('Selected')
        );
        expect(selected?.textContent).toContain('of 20 allowed');
        expect(selected?.textContent).toContain('1 available');
        for (const label of ['Ready', 'Setting up', 'Failed']) expect(cardValue(label), label).toBe('0');
        expect(document.querySelector('.banner-warn')).toBeNull();
        screen.getByLabelText('Search repositories');
        screen.getByText('0 selected · Selection limited to 20 repositories.');

        // A toggle makes the whole-selection draft dirty, and leaving meets the ONE discard confirmation.
        await user.click(checkbox());
        screen.getByText('Selection changed — save to update your workspace');
        screen.getByText('1 selected · Selection limited to 20 repositories.');
        await user.click(dashboardLink());
        await screen.findByText('Discard unsaved changes?');
        screen.getByText('Your changes to the repository selection have not been saved.');

        // The safe answer unblocks nothing: we are still here, and the draft survived.
        await user.click(screen.getByRole('button', { name: 'Continue editing' }));
        await waitFor(() => expect(screen.queryByText('Discard unsaved changes?')).toBeNull());
        expect(router.state.location.pathname).toBe('/settings/repos');
        expect(checkbox().checked).toBe(true);

        // Discard reverts the draft to the server's answer and resumes the navigation.
        await user.click(dashboardLink());
        await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
        await waitFor(() => expect(router.state.location.pathname).toBe('/'));

        await router.navigate('/settings/repos');
        await screen.findByRole('button', { name: 'Save selection' });
        await waitFor(() => expect(checkbox().checked).toBe(false));

        // Configuration is independent of enablement: the editor mounts behind Configure with the
        // checkbox still off, and a clean area raises no dialog.
        await user.click(screen.getByRole('button', { name: 'Configure' }));
        const heading = await screen.findByRole('heading', { name: `Selected repository: ${REPO}` });
        await waitFor(() => expect(document.activeElement).toBe(heading));
        const detail = document.querySelector('.repo-detail') as HTMLElement;
        within(detail).getByText(`Repository · ${REPO}`);
        // Nothing is checked out, so the checkout facts say so in words — never a zero or a bare dash.
        expect(detail.textContent).toContain('Not checked out');
        expect(within(detail).getAllByText('Not available')).toHaveLength(4);
        expect(document.querySelectorAll('tr.repo-row-configured')).toHaveLength(1);
        expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
    });
});
