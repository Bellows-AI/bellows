import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DOCS_URL } from '../src/brand.js';
import { UserMenu } from '../src/components/UserMenu.js';
import { renderAt } from './dom.js';
import { memberSession } from './fixtures.js';

/** The open panel mounts client-side and portals, so it is asserted here under jsdom, not in the render suite. */
describe('UserMenu panel', () => {
    it('links to the user docs in a new tab', async () => {
        renderAt(<UserMenu session={memberSession()} />);
        await userEvent.click(screen.getByRole('button'));
        const link = await screen.findByRole('menuitem', { name: /Documentation/ });
        expect(link.getAttribute('href')).toBe(DOCS_URL);
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link.textContent).toContain('opens in a new tab');
    });
});
