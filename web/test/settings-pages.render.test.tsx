import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { UseEnv } from '../src/api/useEnv.js';
import type { UseRepos } from '../src/api/useRepos.js';
import type { UseWorkspace } from '../src/api/useWorkspace.js';
import type { Session } from '../src/api/useSession.js';
import { SettingsExecutorsPage } from '../src/pages/SettingsExecutorsPage.js';
import { SettingsOrganizationPage } from '../src/pages/SettingsOrganizationPage.js';
import { SettingsRepositoriesPage } from '../src/pages/SettingsRepositoriesPage.js';
import { SettingsWorkflowsPage } from '../src/pages/SettingsWorkflowsPage.js';
import { SettingsWorkspacePage } from '../src/pages/SettingsWorkspacePage.js';
import { EXECUTOR_SCOPE } from '../src/workspace/executors.js';
import { expectNoPlaceholder, memberSession } from './fixtures.js';

/**
 * The pages of the settings tree, rendered through a real route tree so the layout's outlet
 * context exists. Under `renderToStaticMarkup` effects never fire, so hooks normally sit in their
 * initial (loading) state — which the first tests pin. The harness also takes OVERRIDES for the
 * published context, which is how the failure postures get reached: a page whose poll already
 * FAILED (`loading: false, data: null, error`) is unreachable in a plain SSR render, and it is
 * exactly the state where an editor mounted early would seed empty drafts over stored rows.
 */

/** Source inspection, the `window.confirm` idiom: some contracts are about the file, not the render. */
const sourceOf = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/pages/${name}`, import.meta.url)), 'utf8');

const session = memberSession({ role: 'admin', mode: 'none' });

/** The hooks' initial (still loading) shape — what SettingsLayout publishes on a cold render. */
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

/** The layout's unsaved-change registry (issue 181), inert under a static render. */
const idleUnsaved = { guards: new Map(), setGuard: () => {} };

const render = (
    path: string,
    overrides: {
        session?: Session;
        workspace?: Partial<UseWorkspace>;
        repos?: Partial<UseRepos>;
        env?: Partial<UseEnv>;
    } = {}
) => {
    /**
     * Publishes what SettingsLayout promises — the shell context, both polls and the unsaved
     * registry — with the polls taken from the overrides, not from the real hooks: the point of
     * this suite is the pages' POSTURES, and the layout's own fetches are the wiring suite's
     * business.
     */
    function SettingsArea() {
        return (
            <Outlet
                context={{
                    session: overrides.session ?? session,
                    sessionLoading: false,
                    workspace: { ...idleWorkspace, ...overrides.workspace },
                    repos: { ...idleRepos, ...overrides.repos },
                    env: { ...idleEnv, ...overrides.env },
                    unsaved: idleUnsaved,
                }}
            />
        );
    }
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route element={<SettingsArea />}>
                    <Route path="settings">
                        <Route path="organization" element={<SettingsOrganizationPage />} />
                        <Route path="workspace" element={<SettingsWorkspacePage />} />
                        <Route path="repos" element={<SettingsRepositoriesPage />} />
                        <Route path="executors" element={<SettingsExecutorsPage />} />
                        <Route path="workflows" element={<SettingsWorkflowsPage />} />
                    </Route>
                </Route>
            </Routes>
        </MemoryRouter>
    );
};

describe('Settings organization page', () => {
    it('renders identity and scope context, and holds the core editor back until the environment arrives', () => {
        // The stub is gone (issue 180): the page answers "who am I and what is this scope" before
        // any editor. The editor still mounts only on data: its draft is seeded from initialVars
        // in a state initializer, so an early mount would freeze empty rows over the stored ones.
        const html = render('/settings/organization');
        expect(html).toContain('Bellows AI');
        expect(html).toContain('Your role');
        expect(html).toContain('Admin');
        expect(html).not.toContain('bellows');
        expect(html).toContain('Any member can edit.');
        expect(html).toContain('Loading environment…');
        expect(html).not.toContain('No variables configured.');
        expectNoPlaceholder(html);
    });

    it('leaves the editor enabled for a member — the server route is the authorization', () => {
        // `PUT /api/env/org` accepts any member of the installation (routes.env.test.ts), so a
        // disabled browser control was never authorization — it was a false claim about the API.
        const html = render('/settings/organization', {
            session: { ...session, role: 'member' },
            env: {
                loading: false,
                data: {
                    org: [{ name: 'SHARED', value: '1', isSecret: false, updatedAt: '2026-01-01T00:00:00Z' }],
                    workspace: [],
                    repos: [],
                },
            },
        });
        // No INPUT is disabled for a member — the row's name and value stay editable. (The Save
        // button itself may render disabled while the draft is clean, which is issue 182's
        // save-state rule, not a role gate.)
        expect(html.match(/<input [^>]*disabled/g) ?? []).toHaveLength(0);
        expect(html).not.toContain('shown here read-only');
    });

    it('carries no client-only admin gate in its source', () => {
        for (const page of ['SettingsOrganizationPage.tsx', 'SettingsRepositoriesPage.tsx']) {
            const source = sourceOf(page);
            expect(source, page).not.toContain('isAdmin');
        }
    });

    it('renders no editor after a failed environment read — the error is the whole story', () => {
        // loading is false and data is null: the ternary's "else" arm. An editor mounted here
        // would be an ENABLED empty draft whose save wipes whatever is stored.
        const html = render('/settings/organization', {
            env: { loading: false, error: 'The environment request failed' },
        });
        expect(html).toContain('The environment request failed');
        expect(html).not.toContain('No variables configured.');
        expect(html).not.toContain('Add variable');
    });

    it('carries the members section for an admin of a github-mode deployment (issue 410)', () => {
        const html = render('/settings/organization', {
            session: { ...session, mode: 'github', role: 'admin' },
        });
        // Effects never fire under a static render: the section is at its loading posture, which
        // is the renderable proof it mounted. The row work is members-panel's suite.
        expect(html).toContain('Loading members…');
    });

    it('renders no member table for a member — the roster read is admin-gated, so the section fetches nothing', () => {
        const html = render('/settings/organization', {
            session: { ...session, mode: 'github', role: 'member' },
        });
        expect(html).toContain('Member roles are managed by your organization');
        expect(html).not.toContain('<table');
        expect(html).not.toContain('Loading members…');
    });

    it('renders no members section at all under AUTH_MODE=none — no session, no role', () => {
        const html = render('/settings/organization', { session: { ...session, mode: 'none' } });
        expect(html).not.toContain('Member roles are managed');
        expect(html).not.toContain('Loading members…');
    });
});

describe('Settings workspace page', () => {
    it('owns the member\u2019s own scopes only: no checkout root, orphan list or checkout management', () => {
        // The page reads no workspace data: nothing is checked out on the board, so a cold render
        // is the whole page and it never waits on the workspace poll.
        const html = render('/settings/workspace');
        expect(html).not.toContain('Loading your workspace');
        expect(html).toContain('My workspace');
        expect(html).toContain('Applies only to tasks the current member starts.');
        expect(html).toContain('Edited only by that member.');
        for (const gone of [
            'ORG_WORKSPACE_ROOT',
            'Your checkouts live at',
            'Manage repository checkouts',
            'Nothing checked out',
            'Still on disk',
            'Delete from disk',
            'Workspace root not configured',
        ]) {
            expect(html, gone).not.toContain(gone);
        }
        expectNoPlaceholder(html);
    });

    it('is unaffected by a failed workspace read: that error belongs to the executors', () => {
        const html = render('/settings/workspace', {
            workspace: { loading: false, error: 'The workspace request failed' },
        });
        expect(html).not.toContain('The workspace request failed');
        expect(html).toContain('My workspace');
    });

    it('renders the personal environment editor when its store answers', () => {
        const html = render('/settings/workspace', {
            workspace: {
                loading: false,
                data: {
                    executors: [],
                    orgExecutors: [],
                    defaultExecutor: null,
                },
            },
            env: { loading: false, data: { org: [], workspace: [], repos: [] } },
        });
        expect(html).toContain('My workspace');
        expect(html).toContain('No variables configured.');
    });

    it('keeps the way back to a task draft on the executor dialog’s credentials detour', () => {
        const html = render('/settings/workspace?return=/tasks/new', {
            workspace: {
                loading: false,
                data: {
                    executors: [],
                    orgExecutors: [],
                    defaultExecutor: null,
                },
            },
        });
        expect(html).toContain('You have a task draft in progress.');
    });

    it('renders no editor after a failed environment read', () => {
        const html = render('/settings/workspace', {
            // The workspace poll must have settled for the page to reach its env section at all.
            workspace: {
                loading: false,
                data: {
                    executors: [],
                    orgExecutors: [],
                    defaultExecutor: null,
                },
            },
            env: { loading: false, error: 'The environment request failed' },
        });
        expect(html).toContain('The environment request failed');
        expect(html).not.toContain('No variables configured.');
        expect(html).not.toContain('Add variable');
    });
});

describe('Settings executors page', () => {
    it('says it is loading until the workspace poll answers, executors riding that poll', () => {
        const html = render('/settings/executors');
        expect(html).toContain('Loading your workspace…');
        expect(html).toContain(EXECUTOR_SCOPE);
        expectNoPlaceholder(html);
    });

    it('scopes the list, carries the guidance, and marks the resolved default', () => {
        const html = render('/settings/executors', {
            workspace: {
                loading: false,
                data: {
                    executors: [
                        {
                            id: 'e-main',
                            name: 'main',
                            suspended: false,
                            type: 'claude-code',
                            createdAt: '2026-09-01T00:00:00.000Z',
                            gateFixRounds: 3,
                        },
                        {
                            id: 'e-oc',
                            name: 'oc',
                            suspended: false,
                            type: 'opencode',
                            createdAt: '2026-09-02T00:00:00.000Z',
                            gateFixRounds: 3,
                        },
                    ],
                    orgExecutors: [
                        {
                            name: 'team-runner',
                            type: 'claude-code',
                            createdAt: '2026-09-03T00:00:00.000Z',
                            suspended: false,
                        },
                    ],
                    defaultExecutor: { scope: 'user', name: 'main' },
                },
            },
        });
        expect(html).toContain('page-header-description');
        expect(html).toContain('Each task runs with its selected executor');
        expect(html).toContain('<h2>My workspace</h2>');
        // The resolved default names the personal row: that one carries the caption (issue 391's
        // preference shape, the old isDefault flag's successor).
        expect(html.match(/Default — selected on new tasks/g)?.length).toBe(1);
        // The organization panel renders below the personal one, with the shared profile.
        expect(html).toContain('<h2>Organization</h2>');
        expect(html).toContain('team-runner');
        expect(html).toContain('Add executor');
        // The save announcement's region is mounted before any save, so the sentence is heard
        // when it arrives (issue 261).
        expect(html).toMatch(/<p class="muted" role="status"><\/p>/);
    });

    it('renders no list after a failed workspace read — the error is the whole story', () => {
        // "No personal executors configured" beside an error would claim a fact about the
        // workspace the request never delivered.
        const html = render('/settings/executors', {
            workspace: { loading: false, error: 'The workspace request failed' },
        });
        expect(html).toContain('The workspace request failed');
        expect(html).not.toContain('No personal executors configured');
        expect(html).not.toContain('Add executor');
    });

    it('fetches nothing on mount — the config read belongs to the dialog open, not the page', () => {
        // Stubbed at the global the page would fetch through: a static render runs no effects,
        // and nothing else in these components fetches at module scope.
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        render('/settings/executors');
        expect(fetch).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});

describe('Settings workflows page', () => {
    // The page owns its own poll (`useWorkflowsManagement`) rather than riding the layout's
    // shared workspace/env polls — the same precedent `TaskComposerPage` sets for `useWorkflows`,
    // since no other settings page needs this data. Effects never fire under a static render, so
    // this pins the one posture SSR can reach: the page's one h1, no default-workflow panel, and
    // that it fetches nothing before mount.
    it('renders the workflows page with no default-workflow panel', () => {
        const html = render('/settings/workflows');
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>Workflows</h1>');
        expect(html).toContain('page-header-eyebrow');
        expect(html).toContain('page-header-description');
        expect(html).not.toContain('Default workflow');
        expect(html).not.toContain('Iterate on PR review comments');
        expectNoPlaceholder(html);
    });

    it('fetches nothing on mount — a static render runs no effects', () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        render('/settings/workflows');
        expect(fetch).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});

describe('Settings repositories page', () => {
    const tracked = (name: string, over: object = {}) => ({
        owner: 'acme',
        name,
        private: false,
        defaultBranch: 'main',
        pushedAt: '2026-09-01T00:00:00.000Z',
        ...over,
    });
    const answered = (names: string[], error: string | null = null): Partial<UseRepos> => ({
        loading: false,
        data: {
            repos: names.map((name) => tracked(name)),
            installation: { id: '1', account: 'acme', repositorySelection: 'all' },
            meta: { fetchedAt: '2026-09-01T00:00:00.000Z', error },
        },
    });

    it('states nothing about the list while the read is unresolved', () => {
        const html = render('/settings/repos');
        expect(html).toContain('Loading repositories');
        expect(html).not.toContain('No repositories');
        expect(html).not.toContain('No variables configured.');
        expectNoPlaceholder(html);
    });

    it('lists the tracked repositories with their branch and a Configure action, and nothing to select', () => {
        const html = render('/settings/repos', { repos: answered(['web', 'api']) });
        expect(html).toContain('acme/web');
        expect(html).toContain('acme/api');
        expect(html).toContain('>main<');
        expect(html.match(/<button[^>]*>Configure<\/button>/g)?.length).toBe(2);
        for (const gone of [
            'type="checkbox"',
            'Save selection',
            'Selection limited to',
            'Checkout status',
            'Selection summary',
            'ORG_WORKSPACE_ROOT',
            'Not checked out',
            'Enable ',
        ]) {
            expect(html, gone).not.toContain(gone);
        }
    });

    it('names a failed read, rather than stating the list is empty', () => {
        const html = render('/settings/repos', { repos: { loading: false, error: 'Request failed (503)' } });
        expect(html).toContain('Request failed (503)');
        expect(html).not.toContain('not installed on any repositories');
    });

    it('does not depend on the workspace poll: a failed one is not the repositories page\u2019s error', () => {
        const html = render('/settings/repos', {
            workspace: { loading: false, error: 'The workspace request failed' },
            repos: answered(['web']),
        });
        expect(html).not.toContain('The workspace request failed');
        expect(html).toContain('acme/web');
    });

    it('keeps no role-conditional sentence — the editor is every member\u2019s to edit (issue 180)', () => {
        // The old page told members the editor was read-only; the server route never was
        // (routes.env.test.ts accepts a member). The rewritten page has no role gate and no
        // such sentence — and no editor before a repository is chosen.
        const html = render('/settings/repos', { session: { ...session, role: 'member' } });
        expect(html).not.toContain('shown here read-only');
        expect(html).not.toContain('An admin configures repository environment');
    });

    it('renders no repository editor after a failed environment read', () => {
        const html = render('/settings/repos', {
            env: { loading: false, error: 'The environment request failed' },
        });
        expect(html).toContain('The environment request failed');
        expect(html).not.toContain('No variables configured.');
        expect(html).not.toContain('Add variable');
    });

    it('renders no configuration detail before a repository is chosen', () => {
        const html = render('/settings/repos');
        expect(html).not.toContain('Selected repository:');
        expect(html).not.toContain('Choose a repository…');
    });

    it('states the scope context in the header: the organization the repositories belong to', () => {
        const html = render('/settings/repos');
        expect(html).toMatch(/class="page-header-meta"[\s\S]*<dt>Organization<\/dt><dd>Bellows AI<\/dd>/);
    });

    it('keeps the repositories table full width — no master/detail split', () => {
        const html = render('/settings/repos');
        expect(html).not.toContain('repo-columns');
    });
});

describe('settings scope context (issue 182 invariants)', () => {
    // Scope context stays BEFORE the controls: each page's own sentence names the scope, and the
    // editor mounts under it. The guard dialog copy never appears in a clean render — it exists
    // only when the coordinator has something pending, which a static render cannot be.
    const envData = {
        org: [{ name: 'CORE_SECRET', value: null, isSecret: true, updatedAt: '2026-09-01T00:00:00.000Z' }],
        workspace: [],
        repos: [{ owner: 'octo', name: 'hooks', vars: [] }],
    };

    it('renders the org editor under its scope sentence, tabs counting the stored rows', () => {
        const html = render('/settings/organization', { env: { loading: false, data: envData } });
        expect(html).toContain('Injected into every runner in this deployment');
        expect(html).toContain('Variables (0)');
        expect(html).toContain('Secrets (1)');
        expect(html).not.toContain('Discard unsaved changes?');
    });

    it('renders the workspace editor under its scope sentence', () => {
        const html = render('/settings/workspace', {
            workspace: {
                loading: false,
                data: {
                    executors: [],
                    orgExecutors: [],
                    defaultExecutor: null,
                },
            },
            env: { loading: false, data: envData },
        });
        expect(html).toContain('Your own defaults, on every task you queue.');
        expect(html).toContain('No variables configured.');
        expect(html).not.toContain('Discard unsaved changes?');
    });

    it('renders the repositories page with no dialog while clean, and no empty editor before a choice', () => {
        // Issue 182's invariant on the repos page: a clean area raises no discard dialog. Issue
        // 181's shape: the editor appears only behind a row's Configure action — no select panel
        // renders an empty draft before a repository is chosen.
        const html = render('/settings/repos', { env: { loading: false, data: envData } });
        expect(html).not.toContain('Choose a repository…');
        expect(html).not.toContain('Selected repository:');
        expect(html).not.toContain('Discard unsaved changes?');
    });
});

describe('settings page headers', () => {
    // Every page answers "where am I" with exactly one h1 — the page header's — and the
    // Settings eyebrow names the tree the page sits in (#159).
    it.each([
        ['/settings/organization', 'Organization'],
        ['/settings/workspace', 'Workspace'],
        ['/settings/repos', 'Repositories'],
        ['/settings/executors', 'Executors'],
        ['/settings/workflows', 'Workflows'],
    ])('%s carries one h1 naming the section, under the Settings eyebrow', (path, title) => {
        const html = render(path);
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain(`<h1>${title}</h1>`);
        expect(html).toContain('page-header-eyebrow');
        expect(html).toContain('>Settings</p>');
    });

    it('leaves no inner heading restating the page title', () => {
        expect(render('/settings/organization')).not.toContain('<h2>Organization</h2>');
        expect(render('/settings/workspace')).not.toContain('<h2>Workspace</h2>');
        expect(render('/settings/executors')).not.toContain('<h2>Executors</h2>');
        expect(render('/settings/repos')).not.toContain('<h2>Repositories</h2>');
        // The repositories page names its list by label, not by a heading that would restate the title.
        expect(render('/settings/repos')).toContain('aria-label="Tracked repositories"');
    });

    it('puts Add executor in the executors page header', () => {
        const html = render('/settings/executors', {
            workspace: {
                loading: false,
                data: {
                    executors: [],
                    orgExecutors: [],
                    defaultExecutor: null,
                },
            },
        });
        expect(html).toContain('page-header-actions');
        expect(html).toContain('Add executor');
    });
});

describe('draft return banner', () => {
    it('offers the way back to the composer on both pages the composer links to', () => {
        for (const page of ['executors', 'repos']) {
            const html = render(`/settings/${page}?return=/tasks/new`);
            expect(html, page).toContain('You have a task draft in progress.');
            expect(html, page).toContain('href="/tasks/new"');
        }
    });

    it('stays out of the way without the return parameter', () => {
        for (const page of ['executors', 'repos']) {
            expect(render(`/settings/${page}`), page).not.toContain('task draft in progress');
        }
    });
});
