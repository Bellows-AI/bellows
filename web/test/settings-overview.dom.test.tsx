import { cleanup, render, screen, within } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { EnvPayload, UseEnv } from '../src/api/useEnv.js';
import type { UseRepos } from '../src/api/useRepos.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import { SettingsOverviewPage } from '../src/pages/SettingsOverviewPage.js';
import { memberSession } from './fixtures.js';

/** The configuration overview as compact settings rows: two groups, one link per row. */

const answered = { loading: false, error: null, refresh: () => {} };
const workspace = {
    ...answered,
    data: { executors: [], orgExecutors: [], defaultExecutor: null },
} as unknown as UseWorkspace;
const repos = {
    ...answered,
    data: { repos: [], installation: null, meta: { fetchedAt: '2026-01-01T00:00:00Z', error: null } },
} as unknown as UseRepos;
const loadingEnv = { data: null, loading: true, error: null, refresh: () => {} } as unknown as UseEnv;
const envOf = (data: EnvPayload): UseEnv => ({ ...answered, data }) as unknown as UseEnv;
const row = (name: string, isSecret = false) => ({ name, value: null, isSecret, updatedAt: '2026-01-01T00:00:00Z' });

function renderOverview(env: UseEnv, over: { workspace?: UseWorkspace; repos?: UseRepos } = {}) {
    const router = createMemoryRouter(
        [
            {
                element: (
                    <Outlet
                        context={{
                            session: memberSession({ user: { githubUserId: 1 }, mode: 'none' }),
                            sessionLoading: false,
                            workspace: over.workspace ?? workspace,
                            repos: over.repos ?? repos,
                            env,
                        }}
                    />
                ),
                children: [{ path: 'settings', element: <SettingsOverviewPage /> }],
            },
        ],
        { initialEntries: ['/settings'] }
    );
    return render(<RouterProvider router={router} />);
}

describe('settings overview rows', () => {
    afterEach(cleanup);

    it('groups rows under General and Development in readiness order', () => {
        renderOverview(envOf({ org: [], workspace: [], repos: [] }));
        const groups = screen.getAllByRole('heading', { level: 2, name: /^(General|Development)$/ });
        expect(groups.map((g) => g.textContent)).toEqual(['General', 'Development']);
        const names = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
        expect(names).toEqual([
            '/settings/organization',
            '/settings/workspace',
            '/settings/repos',
            '/settings/executors',
            '/settings/organization',
        ]);
        const general = groups[0]!.closest('section')!;
        expect(within(general).getAllByRole('link')).toHaveLength(2);
    });

    it('each row with a destination is a single link named by its heading, to its exact route', () => {
        renderOverview(envOf({ org: [], workspace: [], repos: [] }));
        const routes: Record<string, string> = {
            Organization: '/settings/organization',
            Workspace: '/settings/workspace',
            Repositories: '/settings/repos',
            Executors: '/settings/executors',
            Environment: '/settings/organization',
        };
        for (const [name, to] of Object.entries(routes)) {
            expect(screen.getByRole('link', { name }).getAttribute('href')).toBe(to);
        }
        expect(screen.getAllByRole('link')).toHaveLength(5);
        expect(document.body.textContent).not.toContain('Review repositories');
    });

    it('the environment scope links are siblings of the row link, never inside it', () => {
        renderOverview(envOf({ org: [row('A')], workspace: [row('B', true)], repos: [] }));
        const rowLink = screen.getByRole('link', { name: 'Environment' });
        expect(rowLink.querySelector('a,button')).toBeNull();
        const scopeLink = screen.getByRole('link', { name: 'Workspace environment' });
        expect(rowLink.contains(scopeLink)).toBe(false);
        expect(rowLink.parentElement).toBe(scopeLink.closest('ul')?.parentElement);
        expect(screen.getByRole('link', { name: 'Organization environment' })).toBeTruthy();
    });

    it('loading and error rows are not links', () => {
        renderOverview(loadingEnv);
        expect(screen.queryByRole('link', { name: 'Environment' })).toBeNull();
        expect(screen.getByText('Checking environment scopes…')).toBeTruthy();
    });

    it('an empty environment reads "None set" with no warning or bad pill', () => {
        renderOverview(envOf({ org: [], workspace: [], repos: [] }));
        const status = screen.getByText('None set');
        expect(status.className).not.toMatch(/pill/);
        expect(screen.queryByText(/optional/)).toBeNull();
    });
});
