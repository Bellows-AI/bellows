import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { telemetryStats } from '@factory-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { StatsPayload } from '../src/api/useStats.js';
import { LoginGate } from '../src/components/LoginGate.js';
import type { PendingSignInPayload } from '../src/onboarding.js';
import { OnboardingPage } from '../src/pages/OnboardingPage.js';
import { ThemeProvider } from '../src/theme.js';
import { renderApp, renderAt, stubFetch } from './dom.js';
import { memberSession } from './fixtures.js';
import { emptyUsage } from './telemetry-fixture.js';

/**
 * The sign-in surfaces a component can answer for on its own: the gate's refusal reason, the
 * selection screen's empty-choice blocker, and the dashboard's scope dropdown re-polling the
 * figures. The real OAuth round trip against the stub IdP stays in `e2e/auth.spec.ts`.
 */

afterEach(() => {
    window.history.replaceState(null, '', '/');
});

describe('the login gate', () => {
    it('says why a refused sign-in came back, and still offers the sign-in', async () => {
        stubFetch(({ url }) => (url === '/api/auth/me' ? { authenticated: false } : undefined));
        window.history.replaceState(null, '', '/?auth_error=denied');
        renderAt(
            <ThemeProvider>
                <LoginGate>
                    <p>the dashboard</p>
                </LoginGate>
            </ThemeProvider>
        );

        const signIn = await screen.findByRole('link', { name: 'Sign in with GitHub' });
        const gate = signIn.closest('.login-gate') as HTMLElement;
        expect(within(gate).getByRole('alert').textContent).toBe('Sign-in was cancelled.');
        expect(screen.queryByText('the dashboard')).toBeNull();
    });
});

const pending: PendingSignInPayload = {
    identity: { login: 'octocat', displayName: 'The Octocat', avatarUrl: null },
    installations: [
        { id: '888888', account: 'other-org', tracked: null },
        { id: '999999', account: 'acme', tracked: null },
    ],
    selected: ['888888', '999999'],
    reselect: false,
    org: null,
    returnTo: '/',
};

describe('the selection screen', () => {
    it('refuses Continue on a choice of nothing, says what is missing, and re-enables on a choice', async () => {
        const calls = stubFetch(({ url }) => (url === '/api/auth/github/complete' ? { status: 500 } : undefined));
        const user = userEvent.setup();
        renderAt(
            <ThemeProvider>
                <OnboardingPage payload={pending} />
            </ThemeProvider>
        );
        const orgBox = (account: string) =>
            within(
                screen.getByText(account, { selector: '.onboarding-org *' }).closest('.onboarding-org') as HTMLElement
            ).getByRole('checkbox');

        await user.click(orgBox('other-org'));
        await user.click(orgBox('acme'));

        const cont = screen.getByRole('button', { name: 'Continue' });
        expect(cont.getAttribute('aria-disabled')).toBe('true');
        expect(screen.getByText('Choose at least one organization to continue.')).toBeTruthy();
        // The visible reason is also the button's description: a screen reader hears why.
        const describedBy = cont.getAttribute('aria-describedby');
        expect(describedBy && document.getElementById(describedBy)?.textContent).toBe(
            'Choose at least one organization to continue.'
        );
        // The attempted action is receivable — it cannot post, and the screen stands.
        await user.click(cont);
        expect(calls.filter((c) => c.url === '/api/auth/github/complete')).toEqual([]);
        expect(document.querySelector('.onboarding')).not.toBeNull();

        // Choosing one organization re-enables the action, and it posts.
        await user.click(orgBox('other-org'));
        expect(cont.getAttribute('aria-disabled')).not.toBe('true');
        expect(screen.queryByText('Choose at least one organization to continue.')).toBeNull();
        await user.click(cont);
        await waitFor(() => expect(calls.filter((c) => c.url === '/api/auth/github/complete')).toHaveLength(1));
    });
});

const ORG = { id: 'test-org', name: 'Test Org' };

const member = memberSession({
    user: { id: 'u-1', login: 'e2e-user', name: null, githubUserId: 1 },
    membership: { invitedAt: null, claimedAt: '2026-08-01T00:00:00Z' },
    organization: ORG,
    organizations: [ORG],
});

/** An empty-telemetry stats payload whose meta echoes the scope the request asked for. */
const stats = (scope: 'org' | 'mine'): StatsPayload => ({
    telemetry: telemetryStats(
        { sessions: [], coverage: { from: null, to: null } },
        {
            repos: ['test-org/repo'],
            now: new Date('2026-08-21T12:00:00.000Z'),
            usage: emptyUsage(new Date('2026-08-21T12:00:00.000Z')),
        }
    ),
    tasks: null,
    meta: {
        fetchedAt: '2026-08-21T12:00:00.000Z',
        ageSeconds: 0,
        stale: false,
        organization: { mode: 'directory', current: ORG, available: [ORG] },
        repos: [{ owner: 'test-org', name: 'repo' }],
        range: { preset: 'all', from: null, to: null },
        scope,
        scopeLogin: scope === 'mine' ? 'e2e-user' : null,
        telemetry: {
            status: 'empty',
            reason: null,
            source: 'postgres',
            fetchedAt: '2026-08-21T12:00:00.000Z',
            ageSeconds: 0,
            stale: false,
            repoFilter: ['test-org/repo'],
            otherRepoSessions: 0,
            sessionsWithoutHook: 0,
            unattributedSessions: 0,
        },
    },
});

describe('the dashboard scope dropdown', () => {
    it('re-polls the figures for the signed-in member, and back to the organization', async () => {
        const calls = stubFetch(({ url }) => {
            if (url === '/api/auth/me') return member;
            if (url.startsWith('/api/stats?')) return stats(url.includes('scope=mine') ? 'mine' : 'org');
        });
        const statsCalls = () => calls.filter((c) => c.url.startsWith('/api/stats?')).map((c) => c.url);
        const user = userEvent.setup();
        renderApp('/');

        const trigger = await waitFor(() => {
            const found = document.getElementById('scope-select');
            expect(found).not.toBeNull();
            return found as HTMLElement;
        });
        expect(trigger.textContent).toBe('Organization');
        expect(statsCalls().every((url) => !url.includes('scope=mine'))).toBe(true);

        await user.click(trigger);
        await user.click(await screen.findByRole('option', { name: 'Personal' }));
        await waitFor(() => expect(statsCalls().at(-1)).toContain('scope=mine'));
        expect(trigger.textContent).toBe('Personal');
        // No seeded figures for this member: the ONE empty state, no per-task figures.
        await waitFor(() => expect(document.querySelector('.usage-empty')).not.toBeNull());
        expect(screen.queryByText('Per-task usage')).toBeNull();

        // Back to org: `scope=org` is not a URL form — its absence IS the org request.
        await user.click(trigger);
        await user.click(await screen.findByRole('option', { name: 'Organization' }));
        await waitFor(() => expect(statsCalls().at(-1)).not.toContain('scope=mine'));
        expect(trigger.textContent).toBe('Organization');
    });
});
