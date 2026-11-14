import { MEMBER_ROLE, type Role } from '@factory-ai/core';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp, stubFetch } from './dom.js';
import { boardHandler, settingsBoard } from './settings-board.js';

/**
 * Organization access tokens are an admin's to mint, list and revoke (the server answers a member 403): a member's
 * account page has the personal token form only, the sentence naming who mints org tokens, and never reads the org
 * list; an admin has both forms.
 */

const MEMBER_SENTENCE = 'Organization tokens are minted by an administrator.';

function stubTokens(role?: Role) {
    return stubFetch(
        boardHandler(settingsBoard(role ? { role } : {}), ({ method, url }) =>
            method === 'GET' && (url === '/api/tokens' || url === '/api/tokens/org') ? { tokens: [] } : undefined
        )
    );
}

describe('organization access tokens by role', () => {
    it('a member has no org mint form, the sentence, and no org token read', async () => {
        const calls = stubTokens(MEMBER_ROLE);
        renderApp('/account');
        await screen.findByText(MEMBER_SENTENCE);
        await screen.findByRole('heading', { name: 'Personal access tokens' });
        expect(screen.getAllByRole('button', { name: 'Create token' })).toHaveLength(1);
        expect(calls.filter((c) => c.url === '/api/tokens/org')).toEqual([]);
    });

    it('an admin has both mint forms and no member sentence', async () => {
        stubTokens();
        renderApp('/account');
        await screen.findByRole('heading', { name: 'Organization access tokens' });
        expect(await screen.findAllByRole('button', { name: 'Create token' })).toHaveLength(2);
        expect(screen.queryByText(MEMBER_SENTENCE)).toBeNull();
    });
});
