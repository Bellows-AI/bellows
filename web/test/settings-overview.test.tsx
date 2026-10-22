import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { EnvPayload, UseEnv } from '../src/api/useEnv.js';
import type { Session } from '../src/api/useSession.js';
import type { InstallationRepo, ReposPayload, UseRepos } from '../src/api/useRepos.js';
import type { WorkspacePayload, UseWorkspace } from '../src/api/useWorkspace.js';
import { SettingsOverviewPage } from '../src/pages/SettingsOverviewPage.js';
import { deriveReadiness } from '../src/settings/readiness.js';
import { expectNoPlaceholder, memberSession } from './fixtures.js';

/**
 * The configuration overview's pure derivation (issue 180): five ordered readiness items computed
 * from exactly what SettingsLayout already polls — the session, the shared workspace poll and the
 * shared environment read. Presentation-neutral on purpose: no JSX, no fetches, no color words;
 * the page renders what this returns. The precedence rules the issue pins — a failed or errored
 * repositories read is never an empty list, initial loading never reports zero, and stale data
 * stays visible with its error rendered separately — are pinned here, at the only level where
 * every branch can be reached without a browser.
 */

const session: Pick<Session, 'organization' | 'role'> = {
    organization: { id: 'org-1', name: 'Bellows AI' },
    role: 'member',
};

const workspaceData = (over: Partial<WorkspacePayload> = {}): WorkspacePayload => ({
    executors: [],
    orgExecutors: [],
    defaultExecutor: null,
    ...over,
});

const repo = (name: string): InstallationRepo => ({
    owner: 'acme',
    name,
    private: true,
    defaultBranch: 'main',
    pushedAt: null,
});

/** The `/api/repos` answer the overview reads: the tracked list, and `meta.error` when GitHub failed. */
const reposData = (names: string[] = [], error: string | null = null): ReposPayload => ({
    repos: names.map(repo),
    installation: null,
    meta: { fetchedAt: '2026-01-01T00:00:00Z', error },
});

const envRow = (over: { name: string; isSecret?: boolean }) => ({
    name: over.name,
    value: null,
    isSecret: over.isSecret ?? false,
    updatedAt: '2026-01-01T00:00:00Z',
});

const emptyEnv: EnvPayload = { org: [], workspace: [], repos: [] };

const input = (
    over: {
        session?: Pick<Session, 'organization' | 'role'> | null;
        workspace?: { data?: WorkspacePayload | null; loading?: boolean; error?: string | null };
        repos?: { data?: ReposPayload | null; loading?: boolean; error?: string | null };
        environment?: { data?: EnvPayload | null; loading?: boolean; error?: string | null };
    } = {}
) => ({
    session: over.session === undefined ? session : over.session,
    workspace: { data: null, loading: false, error: null, ...over.workspace },
    repos: { data: null, loading: false, error: null, ...over.repos },
    environment: { data: null, loading: false, error: null, ...over.environment },
});

const byId = (...items: ReturnType<typeof deriveReadiness>) => new Map(items.map((item) => [item.id, item]));

describe('deriveReadiness — item order and identity', () => {
    it('returns the five items in the order the issue fixes, each with heading, status, tone, facts and action', () => {
        const items = deriveReadiness(input());
        expect(items.map((item) => item.id)).toEqual([
            'organization',
            'workspace',
            'repositories',
            'executors',
            'environment',
        ]);
        for (const item of items) {
            expect(item.heading.length).toBeGreaterThan(0);
            expect(item.status.length).toBeGreaterThan(0);
            expect(['ok', 'attention', 'pending', 'info']).toContain(item.tone);
            expect(Array.isArray(item.facts)).toBe(true);
        }
    });
});

describe('deriveReadiness — loading never reports zero', () => {
    it('reports checking states while the polls have not answered', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    session: null,
                    workspace: { loading: true },
                    repos: { loading: true },
                    environment: { loading: true },
                })
            )
        );
        expect(items.get('workspace')?.status).toBe('Checking workspace…');
        expect(items.get('repositories')?.status).toBe('Checking repositories…');
        expect(items.get('executors')?.status).toBe('Checking executors…');
        expect(items.get('environment')?.status).toBe('Checking environment scopes…');
        expect(items.get('organization')?.status).toBe('Checking organization…');
        for (const id of ['workspace', 'repositories', 'executors', 'environment'] as const) {
            expect(items.get(id)?.tone).toBe('pending');
        }
        const rendered = JSON.stringify(items);
        expect(rendered).not.toMatch(/\b0 (repositories|personal executors|environment values)/);
        expect(rendered).not.toContain('ready');
    });
});

describe('deriveReadiness — initial failure versus stale data', () => {
    it('reports unavailable with the named error when the first workspace read fails', () => {
        const items = byId(
            ...deriveReadiness(
                input({ workspace: { data: null, loading: false, error: 'The workspace request failed' } })
            )
        );
        expect(items.get('workspace')?.status).toBe('Workspace status unavailable');
        expect(items.get('workspace')?.tone).toBe('attention');
        expect(JSON.stringify(items.get('workspace')?.facts)).toContain('The workspace request failed');
        expect(items.get('executors')?.status).toBe('Executor status unavailable');
    });

    it('reports repositories unavailable, with the named error, when the first read fails', () => {
        const items = byId(...deriveReadiness(input({ repos: { data: null, error: 'Repositories request failed' } })));
        expect(items.get('repositories')?.status).toBe('Repository status unavailable');
        expect(items.get('repositories')?.tone).toBe('attention');
        expect(JSON.stringify(items.get('repositories')?.facts)).toContain('Repositories request failed');
    });

    it('keeps deriving from stale data when a later poll fails — the error is not the item', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    workspace: { data: workspaceData(), error: 'poll failed' },
                    repos: { data: reposData(['web']), error: 'refresh failed' },
                })
            )
        );
        expect(items.get('workspace')?.status).toBe('Workspace available');
        expect(items.get('repositories')?.status).toBe('1 repository tracked');
        expect(JSON.stringify(items.get('workspace')?.facts)).not.toContain('poll failed');
        expect(JSON.stringify(items.get('repositories')?.facts)).not.toContain('refresh failed');
    });
});

describe('deriveReadiness — the workspace item has no root', () => {
    it('is available once the poll answers, with no path fact', () => {
        const items = byId(...deriveReadiness(input({ workspace: { data: workspaceData() } })));
        expect(items.get('workspace')?.status).toBe('Workspace available');
        expect(items.get('workspace')?.tone).toBe('ok');
        expect(items.get('workspace')?.facts).toEqual([]);
        expect(items.get('workspace')?.action).toEqual({ label: 'Open workspace settings', to: '/settings/workspace' });
    });

    it('never calls the executors unavailable for a missing root', () => {
        const items = byId(...deriveReadiness(input({ workspace: { data: workspaceData() } })));
        expect(items.get('executors')?.tone).not.toBe('attention');
        expect(JSON.stringify(items)).not.toMatch(/workspace root|Tasks cannot run/);
    });
});

describe('deriveReadiness — repositories come from the tracked list', () => {
    it('counts tracked repositories, with no clone state to report', () => {
        const items = byId(...deriveReadiness(input({ repos: { data: reposData(['web', 'api']) } })));
        expect(items.get('repositories')?.status).toBe('2 repositories tracked');
        expect(items.get('repositories')?.tone).toBe('ok');
        expect(items.get('repositories')?.action).toEqual({ label: 'Review repositories', to: '/settings/repos' });
    });

    it('agrees the count for one repository', () => {
        const items = byId(...deriveReadiness(input({ repos: { data: reposData(['web']) } })));
        expect(items.get('repositories')?.status).toBe('1 repository tracked');
    });

    it('reads a confirmed empty list as a neutral state', () => {
        const items = byId(...deriveReadiness(input({ repos: { data: reposData() } })));
        expect(items.get('repositories')?.status).toBe('No repositories tracked');
        expect(items.get('repositories')?.tone).toBe('info');
        expect(items.get('repositories')?.action).toEqual({ label: 'Review repositories', to: '/settings/repos' });
    });

    it('never reads an empty list that carries meta.error as "no repositories tracked"', () => {
        const items = byId(...deriveReadiness(input({ repos: { data: reposData([], 'GitHub is unreachable') } })));
        expect(items.get('repositories')?.status).toBe('Repository status unavailable');
        expect(items.get('repositories')?.tone).toBe('attention');
        expect(JSON.stringify(items.get('repositories')?.facts)).toContain('GitHub is unreachable');
    });

    it('keeps the last good rows when meta.error rides beside them', () => {
        const items = byId(...deriveReadiness(input({ repos: { data: reposData(['web'], 'GitHub is unreachable') } })));
        expect(items.get('repositories')?.status).toBe('1 repository tracked');
    });
});

describe('deriveReadiness — executors', () => {
    it('reads zero rows as the deployment default, not an error', () => {
        const items = byId(...deriveReadiness(input({ workspace: { data: workspaceData() } })));
        expect(items.get('executors')?.status).toBe('Using the deployment default');
        expect(items.get('executors')?.tone).toBe('info');
        expect(JSON.stringify(items.get('executors')?.facts)).toContain('No personal executor rows are required');
        expect(items.get('executors')?.action).toEqual({ label: 'Manage executors', to: '/settings/executors' });
    });

    it('names the personal executor the resolved default picks', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    workspace: {
                        data: workspaceData({
                            executors: [
                                {
                                    id: 'e-fast',
                                    name: 'fast-box',
                                    suspended: false,
                                    type: 'claude',
                                    createdAt: '2026-01-01T00:00:00Z',
                                    gateFixRounds: 3,
                                },
                                {
                                    id: 'e-big',
                                    name: 'big-box',
                                    suspended: false,
                                    type: 'claude',
                                    createdAt: '2026-01-02T00:00:00Z',
                                    gateFixRounds: 3,
                                },
                            ],
                            defaultExecutor: { scope: 'user', name: 'big-box' },
                        }),
                    },
                })
            )
        );
        expect(items.get('executors')?.status).toBe('2 personal executors available');
        expect(items.get('executors')?.tone).toBe('ok');
        expect(JSON.stringify(items.get('executors')?.facts)).toContain(
            'big-box is the default executor for new tasks.'
        );
        expect(items.get('executors')?.action).toEqual({ label: 'Manage executors', to: '/settings/executors' });
    });

    it('names the organization profile the resolved default picks, by its scope (issue 391)', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    workspace: {
                        data: workspaceData({
                            executors: [],
                            orgExecutors: [
                                {
                                    name: 'team-runner',
                                    type: 'claude',
                                    createdAt: '2026-01-02T00:00:00Z',
                                    suspended: false,
                                },
                            ],
                            defaultExecutor: { scope: 'org', name: 'team-runner' },
                        }),
                    },
                })
            )
        );
        expect(JSON.stringify(items.get('executors')?.facts)).toContain(
            'team-runner (organization) is the default executor for new tasks.'
        );
    });
});

describe('deriveReadiness — environment', () => {
    it('reads an empty payload as optional, with no action to take', () => {
        const items = byId(...deriveReadiness(input({ environment: { data: emptyEnv } })));
        expect(items.get('environment')?.status).toBe('No custom environment values');
        expect(items.get('environment')?.tone).toBe('info');
        expect(JSON.stringify(items.get('environment')?.facts)).toContain('optional');
        expect(items.get('environment')?.action).toBeNull();
    });

    it('counts variables and secrets per scope without names or values, each scope linked', () => {
        const items = byId(
            ...deriveReadiness(
                input({
                    environment: {
                        data: {
                            org: [envRow({ name: 'SHARED' }), envRow({ name: 'ORG_TOKEN', isSecret: true })],
                            workspace: [envRow({ name: 'MINE' })],
                            repos: [
                                { owner: 'acme', name: 'web', vars: [envRow({ name: 'DEPLOY', isSecret: true })] },
                                { owner: 'acme', name: 'api', vars: [] },
                            ],
                        },
                    },
                })
            )
        );
        const environment = items.get('environment')!;
        expect(environment.status).toBe('4 environment values configured');
        const facts = environment.facts.map((fact) => fact.text);
        expect(facts).toContain('Organization scope: 1 variable, 1 secret');
        expect(facts).toContain('Workspace scope: 1 variable, 0 secrets');
        expect(facts).toContain('Repository scope: 0 variables, 1 secret across 2 repositories');
        expect(environment.facts.map((fact) => fact.link?.to)).toEqual([
            '/settings/organization',
            '/settings/workspace',
            '/settings/repos',
        ]);
        const rendered = JSON.stringify(environment);
        for (const secret of ['SHARED', 'ORG_TOKEN', 'MINE', 'DEPLOY']) expect(rendered).not.toContain(secret);
    });
});

describe('deriveReadiness — organization identity', () => {
    it('shows the organization name and role, with no internal id', () => {
        const items = byId(...deriveReadiness(input()));
        expect(items.get('organization')?.status).toBe('Configured');
        expect(JSON.stringify(items.get('organization')?.facts)).toContain('Bellows AI');
        expect(JSON.stringify(items.get('organization')?.facts)).toContain('Your role: Member');
        expect(items.get('organization')?.action).toEqual({
            label: 'Review organization settings',
            to: '/settings/organization',
        });
        expect(JSON.stringify(items)).not.toContain('org-1');
    });

    it('reports an admin role by its title only, with no invented powers', () => {
        const items = byId(
            ...deriveReadiness(input({ session: { organization: session.organization, role: 'admin' } }))
        );
        expect(JSON.stringify(items.get('organization')?.facts)).toContain('Your role: Admin');
    });

    it('keeps checking while the session has not resolved', () => {
        const items = byId(...deriveReadiness(input({ session: null })));
        expect(items.get('organization')?.status).toBe('Checking organization…');
        expect(items.get('organization')?.tone).toBe('pending');
    });
});

const fullSession = memberSession({
    user: { githubUserId: 1 },
    mode: 'none',
});

const idleWorkspace = {
    data: null,
    loading: true,
    error: null,
    saving: false,
    save: async () => null,
    saveExecutors: async () => null,
    listExecutorConfigs: async () => null,
} as unknown as UseWorkspace;

const idleRepos = {
    data: null,
    loading: true,
    error: null,
    refresh: () => {},
} as unknown as UseRepos;

const idleEnv = {
    data: null,
    loading: true,
    error: null,
    saving: false,
    refresh: () => {},
    saveOrg: async () => null,
    saveWorkspace: async () => null,
    saveRepo: async () => null,
} as unknown as UseEnv;

const renderOverview = (
    overrides: {
        session?: Session | null;
        workspace?: Partial<UseWorkspace>;
        repos?: Partial<UseRepos>;
        env?: Partial<UseEnv>;
    } = {}
): string =>
    renderToStaticMarkup(
        <MemoryRouter initialEntries={['/settings']}>
            <Routes>
                <Route
                    element={
                        <Outlet
                            context={{
                                session: overrides.session === undefined ? fullSession : overrides.session,
                                sessionLoading: false,
                                workspace: { ...idleWorkspace, ...overrides.workspace },
                                repos: { ...idleRepos, ...overrides.repos },
                                env: { ...idleEnv, ...overrides.env },
                            }}
                        />
                    }
                >
                    <Route path="settings" element={<SettingsOverviewPage />} />
                </Route>
            </Routes>
        </MemoryRouter>
    );

describe('SettingsOverviewPage (render) — identity and headings', () => {
    const render = renderOverview;

    it('renders one h1 with the eyebrow and description naming the organization', () => {
        const html = render();
        expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
        expect(html).toContain('Configuration overview');
        expect(html).toContain('Settings</p>');
        expect(html).toContain('Review what is configured for Bellows AI and your workspace.');
        expectNoPlaceholder(html);
    });

    it('shows the identity definition list without the internal id', () => {
        const html = render();
        expect(html).toContain('Bellows AI');
        expect(html).toContain('Your role');
        expect(html).toContain('Member');
        expect(html).not.toContain('bellows');
    });

    it('renders the five readiness headings in order', () => {
        const html = render();
        const headings = [
            '<h2>Organization</h2>',
            '<h2>Workspace</h2>',
            '<h2>Repositories</h2>',
            '<h2>Executors</h2>',
            '<h2>Environment</h2>',
        ];
        let at = -1;
        for (const heading of headings) {
            const next = html.indexOf(heading);
            expect(next, heading).toBeGreaterThan(at);
            at = next;
        }
    });

    it('reads as checking on a cold load, with no action link yet', () => {
        const html = render({ session: null });
        expect(html).toContain('Checking workspace…');
        expect(html).toContain('Checking repositories…');
        expect(html).toContain('Checking executors…');
        expect(html).toContain('Checking environment scopes…');
        expect(html).toContain('Checking your session…');
        expect(html).not.toContain('readiness-action');
    });
});

describe('SettingsOverviewPage (render) — readiness states', () => {
    const render = renderOverview;

    it('links every item to its exact destination once the polls answer', () => {
        const html = render({
            workspace: {
                loading: false,
                data: {
                    executors: [
                        {
                            id: 'e-fast',
                            name: 'fast-box',
                            suspended: false,
                            type: 'claude',
                            createdAt: '2026-01-01T00:00:00Z',
                            gateFixRounds: 3,
                        },
                    ],
                    orgExecutors: [],
                    defaultExecutor: { scope: 'user', name: 'fast-box' },
                },
            },
            repos: { loading: false, data: reposData(['web']) },
            env: { loading: false, data: emptyEnv },
        });
        expect(html).toContain('href="/settings/organization"');
        expect(html).toContain('Review organization settings');
        expect(html).toContain('href="/settings/workspace"');
        expect(html).toContain('href="/settings/repos"');
        expect(html).toContain('href="/settings/executors"');
        expect(html).toContain('Workspace available');
        expect(html).toContain('1 repository tracked');
        expect(html).toContain('1 personal executor available');
        expect(html).toContain('No custom environment values');
    });

    it('wears each item tone as a status pill from the shared tone set', () => {
        // ok → the green pill, attention → the red one, pending → the warning pill, a neutral
        // fact → the untoned pill. The words stay the message; the card edge stays neutral.
        const answered = render({
            workspace: {
                loading: false,
                data: workspaceData(),
            },
            repos: { loading: false, data: reposData(['web']) },
            env: { loading: false, data: emptyEnv },
        });
        expect(answered).toContain('<p class="readiness-status pill pill-ok">Workspace available</p>');
        expect(answered).toContain('<p class="readiness-status pill">No custom environment values</p>');
        expect(answered).toContain('<li class="readiness-item">');
        expect(render({ session: null })).toContain(
            '<p class="readiness-status pill pill-warn">Checking workspace…</p>'
        );
    });

    it('says a failed repositories read is unavailable, never "no repositories tracked"', () => {
        const html = render({
            workspace: { loading: false, data: workspaceData() },
            repos: { loading: false, data: null, error: 'the repositories read failed' },
            env: { loading: false, data: emptyEnv },
        });
        expect(html).toContain('Repository status unavailable');
        expect(html).toContain('the repositories read failed');
        expect(html).not.toContain('No repositories tracked');
    });

    it('renders a later poll failure as a separate status line under the last-good items', () => {
        const html = render({
            workspace: { loading: false, error: 'the workspace poll failed', data: workspaceData() },
            env: { loading: false, error: 'the environment read failed', data: emptyEnv },
        });
        expect(html).toContain('Workspace available');
        expect(html).toContain('<p class="status">the workspace poll failed</p>');
        expect(html).toContain('<p class="status">the environment read failed</p>');
    });

    it('names the error once on an initial failure — the item fact is the announcement', () => {
        const html = render({ workspace: { loading: false, error: 'the first read failed' } });
        expect(html).toContain('Workspace status unavailable');
        expect(html.split('the first read failed').length - 1).toBe(1);
    });
});
