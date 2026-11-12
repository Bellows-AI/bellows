import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { TaskNavigation, UseTasks } from '../src/api/useTasks.js';
import { TaskInboxPage } from '../src/pages/TaskInboxPage.js';

/**
 * The task inbox at /tasks: rows, page states, URL filters. The page
 * reads the published context through `useTasksPage`, so the harness mounts it
 * under an Outlet context carrying the poll fake and a workspace fake — the
 * same two-level shape the shell and the layout publish in the real tree.
 */

const emptyWorkspace = { data: null, loading: true, error: null, refresh: () => {} };
const emptyRepos = { data: null, loading: true, error: null as string | null, refresh: () => {} };

const taskSummary = (over: Partial<import('../src/api/useTasks.js').TaskSummary> = {}) => ({
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the flaky login test',
    title: null,
    titleOrigin: null,
    titleRevision: 0,
    status: 'succeeded' as const,
    cancelRequestedAt: null,
    doneAt: null,
    repo: 'acme/widgets',
    executor: null,
    author: null,
    activity: null,
    summary: null,
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    activityAt: '2026-09-01T12:10:00.000Z',
    needsAnswer: false,
    ...over,
});

const navigation = (over: Partial<TaskNavigation['counts']> = {}): TaskNavigation => ({
    counts: { running: 0, review: 0, past: 0, ...over },
    running: [],
    review: [],
});

interface InboxTasks extends Partial<UseTasks> {
    items?: UseTasks['items'];
}

const renderInbox = (tasks: InboxTasks, path = '/tasks', repos: typeof emptyRepos = emptyRepos) => {
    const fake = {
        retry: () => {},
        loadMore: () => {},
        refresh: () => {},
        error: null,
        refreshError: null,
        loadMoreError: null,
        loadingMore: false,
        refreshing: false,
        actions: {},
        filters: { state: 'attention', q: null, repo: null, author: null, sort: 'newest' },
        ...tasks,
    } as UseTasks;
    return renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
            <Routes>
                <Route element={<Outlet context={{ tasks: fake, workspace: emptyWorkspace, repos }} />}>
                    <Route
                        path="tasks"
                        element={<Outlet context={{ tasks: fake, workspace: emptyWorkspace, repos }} />}
                    >
                        <Route index element={<TaskInboxPage />} />
                        <Route path="new" element={<div id="composer-slot">composer slot</div>} />
                    </Route>
                </Route>
            </Routes>
        </MemoryRouter>
    );
};

/** Every `<li>` row of the list, as its own markup slice. */
const rowsOf = (html: string): string[] => html.match(/<li class="inbox-row[^"]*">.*?<\/li>/g) ?? [];

/** The href of the one `<a>` whose opening tag carries `attribute`, whatever the attribute order. */
const linkHref = (html: string, attribute: string): string | undefined =>
    html
        .match(/<a [^>]*>/g)
        ?.find((tag) => tag.includes(attribute))
        ?.match(/href="([^"]*)"/)?.[1];

describe('TaskInboxPage rows — the display title', () => {
    const stored = { title: 'Fix the login crash', titleOrigin: 'agent' as const, titleRevision: 1 };

    it('renders the stored title, not the command, with the full text as title=', () => {
        const html = renderInbox({ items: [taskSummary({ ...stored, command: 'x'.repeat(500) })] });
        const row = rowsOf(html)[0]!;
        expect(row).toMatch(/<a [^>]*title="Fix the login crash"[^>]*>Fix the login crash<\/a>/);
        expect(row).not.toContain('xxxxxxxx');
    });

    it('names a blank prompt Task #<short id>', () => {
        const html = renderInbox({ items: [taskSummary({ command: '  ' })] });
        expect(rowsOf(html)[0]).toContain('>Task #11111111<');
    });
});

describe('TaskInboxPage header', () => {
    it('names the page with no description, and offers New task as its one action', () => {
        const html = renderInbox({
            navigation: navigation({ running: 1, review: 2 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('<h1>Tasks</h1>');
        expect(html).not.toContain('page-header-description');
        expect(html).toContain('href="/tasks/new"');
        expect(html).toContain('New task');
        // The org-wide counts ride the tabs; the header carries no meta line.
        expect(html).not.toContain('page-header-meta');
    });
});

describe('TaskInboxPage tab counts', () => {
    it('puts each organization count on its tab, Needs attention as running plus review', () => {
        const html = renderInbox({
            navigation: navigation({ review: 12, running: 3, past: 86 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('aria-label="Needs attention, 15 across the organization"');
        expect(html).toContain('aria-label="Running, 3 across the organization"');
        expect(html).toContain('aria-label="Past, 86 across the organization"');
        expect((html.match(/class="inbox-tab-count"/g) ?? []).length).toBe(3);
        // The old strip is gone: the tabs are the one place the counts live.
        expect(html).not.toContain('Organization total');
        expect(html).not.toContain('inbox-counts');
    });

    it('reads the same counts whatever the filters', () => {
        const html = renderInbox(
            {
                navigation: navigation({ review: 12, running: 3, past: 86 }),
                items: [],
                nextCursor: null,
                initial: false,
                filters: { state: 'past', q: 'login', repo: 'acme/widgets', author: 'octocat', sort: 'oldest' },
            },
            '/tasks?state=past&q=login&repo=acme%2Fwidgets&author=octocat&sort=oldest'
        );
        expect(html).toContain('aria-label="Needs attention, 15 across the organization"');
        expect(html).toContain('aria-label="Past, 86 across the organization"');
    });

    it('draws no count before the organization counts have landed', () => {
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        expect(html).not.toContain('inbox-tab-count');
        expect(html).not.toContain('across the organization');
    });
});

describe('TaskInboxPage filter chips', () => {
    const filtered = () =>
        renderInbox(
            {
                navigation: navigation({ review: 1 }),
                items: [taskSummary()],
                nextCursor: null,
                initial: false,
                filters: { state: 'review', q: 'login', repo: 'acme/widgets', author: 'octocat', sort: 'oldest' },
            },
            '/tasks?state=review&q=login&repo=acme%2Fwidgets&author=octocat&sort=oldest'
        );

    it('shows one chip per applied search, repository and author filter, and one for Needs review', () => {
        const html = filtered();
        expect((html.match(/class="inbox-chip"/g) ?? []).length).toBe(4);
        expect(html).toContain('State: Needs review');
        expect(html).toContain('Search: login');
        expect(html).toContain('Repository: acme/widgets');
        expect(html).toContain('Author: octocat');
    });

    it('removes exactly one filter per chip, keeping state, sort and the other filters', () => {
        const html = filtered();
        expect(linkHref(html, 'aria-label="Remove filter: Search"')).toBe(
            '/tasks?state=review&amp;repo=acme%2Fwidgets&amp;author=octocat&amp;sort=oldest'
        );
        expect(linkHref(html, 'aria-label="Remove filter: Repository"')).toBe(
            '/tasks?state=review&amp;q=login&amp;author=octocat&amp;sort=oldest'
        );
        expect(linkHref(html, 'aria-label="Remove filter: Author"')).toBe(
            '/tasks?state=review&amp;q=login&amp;repo=acme%2Fwidgets&amp;sort=oldest'
        );
        // Needs review has no tab: its chip goes back to Needs attention, the default state.
        expect(linkHref(html, 'aria-label="Remove filter: State"')).toBe(
            '/tasks?q=login&amp;repo=acme%2Fwidgets&amp;author=octocat&amp;sort=oldest'
        );
    });

    it('offers Clear filters back to the bare inbox beside the chips', () => {
        expect(linkHref(filtered(), 'class="inbox-clear"')).toBe('/tasks');
    });

    it('draws no chip for the default filters, nor for a non-default state or sort alone', () => {
        const html = renderInbox(
            {
                navigation: navigation({ review: 1 }),
                items: [taskSummary()],
                nextCursor: null,
                initial: false,
                filters: { state: 'past', q: null, repo: null, author: null, sort: 'oldest' },
            },
            '/tasks?state=past&sort=oldest'
        );
        expect(html).not.toContain('inbox-chip');
        expect(html).not.toContain('inbox-clear');
    });
});

describe('TaskInboxPage rows', () => {
    const everyState = (): { tasks: InboxTasks; html: string } => {
        const items = [
            taskSummary({ status: 'running', activity: '→ Bash npm test' }),
            taskSummary({ id: '22222222-2222-4222-8222-222222222222', status: 'queued' }),
            taskSummary({
                id: '44444444-4444-4444-8444-444444444444',
                status: 'running',
                cancelRequestedAt: '2026-09-01T12:11:00.000Z',
            }),
            taskSummary({ id: '55555555-5555-4555-8555-555555555555', status: 'failed' }),
            taskSummary({ id: '66666666-6666-4666-8666-666666666666', status: 'stopped' }),
            taskSummary({
                id: '77777777-7777-4777-8777-777777777777',
                status: 'succeeded',
                doneAt: '2026-09-01T13:00:00.000Z',
            }),
        ];
        const html = renderInbox({
            navigation: navigation({ running: 2, review: 2, past: 1 }),
            items,
            nextCursor: null,
            initial: false,
        });
        return { tasks: { items }, html };
    };

    it('renders a task holding an answerable question as Needs answer, ahead of Running', () => {
        const html = renderInbox({
            navigation: navigation({ running: 1 }),
            items: [taskSummary({ status: 'running', needsAnswer: true })],
            nextCursor: null,
            initial: false,
        });
        const [row] = rowsOf(html);
        expect(row).toMatch(/<span class="pill pill-accent"><svg[\s\S]*?<\/svg>Needs answer<\/span>/);
        expect(row).not.toContain('Running');
        // Its turn: the accent edge.
        expect(row).toMatch(/^<li class="inbox-row inbox-row-turn">/);
    });

    it('makes the title the one link to the detail view, with repo, author and a precise age', () => {
        const author = { id: 'a', login: 'octocat', name: null, avatarUrl: null };
        const html = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary({ author, activityAt: '2026-09-01T12:10:00.000Z' })],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('href="/tasks/11111111-1111-4111-8111-111111111111"');
        expect(html).toContain('acme/widgets');
        expect(html).toContain('octocat');
        // The relative age is backed by a machine-readable stamp and a precise hover value.
        expect(html).toContain('dateTime="2026-09-01T12:10:00.000Z"');
        expect(html).toContain('title="2026-09-01 12:10"');
    });

    it('shows the live activity line only under a running task', () => {
        const html = renderInbox({
            navigation: navigation({ running: 1 }),
            items: [
                taskSummary({ status: 'running', activity: '→ Bash npm test' }),
                taskSummary({ id: '22222222-2222-4222-8222-222222222222', status: 'queued', activity: '→ stale' }),
            ],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('→ Bash npm test');
        expect(html).not.toContain('→ stale');
    });

    it('shows a terminal row its summary on one line, the full text in its title', () => {
        const summary = 'Fixed the redirect loop and added a regression test for the login flow';
        const html = renderInbox({
            navigation: navigation({ review: 2 }),
            items: [
                taskSummary({ summary }),
                taskSummary({ id: '22222222-2222-4222-8222-222222222222', status: 'queued', summary: 'old words' }),
                taskSummary({
                    id: '33333333-3333-4333-8333-333333333333',
                    status: 'running',
                    activity: '→ Bash npm test',
                    summary: 'last run words',
                }),
            ],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain(`class="inbox-summary" title="${summary}">${summary}<`);
        expect(html).not.toContain('old words');
        expect(html).not.toContain('last run words');
    });

    it('draws each state as a toned pill from the one precedence', () => {
        const { html } = everyState();
        const rows = rowsOf(html);
        expect(rows).toHaveLength(6);
        expect(rows[0]).toContain('pill pill-ok');
        expect(rows[1]).toContain('pill pill-done');
        expect(rows[2]).toContain('sidenav-dot-stopping');
        expect(rows[3]).toContain('pill pill-bad');
        expect(rows[4]).toContain('pill pill-done');
        expect(rows[5]).toContain('pill pill-done inbox-state-done');
        const review = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(review).toContain('pill pill-accent');
        const waiting = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary({ status: 'queued', waitReason: 'review' })],
            nextCursor: null,
            initial: false,
        });
        expect(waiting).toContain('pill pill-done inbox-state-waiting');
    });

    it('holds exactly one link per row, and it is the title', () => {
        const { html } = everyState();
        for (const row of rowsOf(html)) {
            expect((row.match(/<a /g) ?? []).length).toBe(1);
            expect(row).toMatch(
                /^<li class="inbox-row[^"]*"><span class="inbox-mark"[^>]*>.*?<\/span><span class="inbox-title"><a /
            );
        }
    });

    it('renders the author as an avatar beside the login, and names a missing one', () => {
        const html = renderInbox({
            navigation: navigation({ review: 3 }),
            items: [
                taskSummary({ author: { id: 'a', login: 'octocat', name: null, avatarUrl: 'https://x.test/o.png' } }),
                taskSummary({
                    id: '22222222-2222-4222-8222-222222222222',
                    author: { id: 'b', login: 'hubot', name: null, avatarUrl: null },
                }),
                taskSummary({ id: '33333333-3333-4333-8333-333333333333', author: null }),
            ],
            nextCursor: null,
            initial: false,
        });
        const [withPicture, withInitial, unknown] = rowsOf(html);
        expect(withPicture).toContain('<img class="avatar" src="https://x.test/o.png"');
        expect(withPicture).toContain('octocat');
        expect(withInitial).toContain('avatar avatar-fallback');
        expect(withInitial).toContain('>H<');
        expect(unknown).toContain('>?<');
        expect(unknown).toContain('Unknown author');
    });
});

describe('TaskInboxPage rows — grouping, executor, live line, edges', () => {
    it('groups the rows under a day heading with its count, in the list order', () => {
        const now = Date.now();
        const html = renderInbox({
            navigation: navigation({ review: 3 }),
            items: [
                taskSummary({ activityAt: new Date(now).toISOString() }),
                taskSummary({ id: '22222222-2222-4222-8222-222222222222', activityAt: new Date(now).toISOString() }),
                taskSummary({ id: '33333333-3333-4333-8333-333333333333', activityAt: '2020-01-01T00:00:00.000Z' }),
            ],
            nextCursor: null,
            initial: false,
        });
        const heads = [
            ...html.matchAll(
                /<h2 class="inbox-group-head">([^<]*)<span class="inbox-group-count">(\d+)<\/span><\/h2>/g
            ),
        ];
        expect(heads.map((m) => [m[1], m[2]])).toEqual([
            ['Today', '2'],
            ['Older', '1'],
        ]);
        // The column header is gone: the day headings label the list.
        expect(html).not.toContain('inbox-columns');
    });

    it('shows the executor under the repository when the task names one', () => {
        const html = renderInbox({
            navigation: navigation({ review: 2 }),
            items: [
                taskSummary({ executor: 'claude-k8s' }),
                taskSummary({ id: '22222222-2222-4222-8222-222222222222', executor: null }),
            ],
            nextCursor: null,
            initial: false,
        });
        const [withExecutor, without] = rowsOf(html);
        expect(withExecutor).toContain('<span class="inbox-executor">claude-k8s</span>');
        expect(without).not.toContain('inbox-executor');
    });

    it("marks a running task's activity as live, and a finished summary as not", () => {
        const html = renderInbox({
            navigation: navigation({ running: 1, review: 1 }),
            items: [
                taskSummary({ status: 'running', activity: '→ Bash npm test' }),
                taskSummary({ id: '22222222-2222-4222-8222-222222222222', summary: 'Opened a PR' }),
            ],
            nextCursor: null,
            initial: false,
        });
        const [running, finished] = rowsOf(html);
        expect(running).toContain('class="inbox-summary is-live"');
        expect(finished).toContain('class="inbox-summary" title="Opened a PR"');
    });

    it('edges the rows whose turn it is — review in accent, failure in red — and no other', () => {
        const html = renderInbox({
            navigation: navigation({ running: 1, review: 2, past: 1 }),
            items: [
                taskSummary(),
                taskSummary({ id: '22222222-2222-4222-8222-222222222222', status: 'failed' }),
                taskSummary({ id: '33333333-3333-4333-8333-333333333333', status: 'running' }),
                taskSummary({
                    id: '44444444-4444-4444-8444-444444444444',
                    doneAt: '2026-09-01T13:00:00.000Z',
                }),
            ],
            nextCursor: null,
            initial: false,
        });
        const classes = rowsOf(html).map((row) => row.match(/^<li class="([^"]*)"/)?.[1]);
        expect(classes).toEqual(['inbox-row inbox-row-turn', 'inbox-row inbox-row-failed', 'inbox-row', 'inbox-row']);
    });
});

describe('TaskInboxPage footer', () => {
    it('counts the loaded rows, never a total', () => {
        const one = renderInbox({
            navigation: navigation({ review: 40 }),
            items: [taskSummary()],
            nextCursor: 'abc',
            initial: false,
        });
        expect(one).toContain('Showing 1 loaded task<');
        const two = renderInbox({
            navigation: navigation({ review: 40 }),
            items: [taskSummary(), taskSummary({ id: '22222222-2222-4222-8222-222222222222' })],
            nextCursor: null,
            initial: false,
        });
        expect(two).toContain('Showing 2 loaded tasks');
        expect(two).not.toContain('of 40');
    });
});

describe('TaskInboxPage page states', () => {
    it('loads with skeletons, never the empty call to action', () => {
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        expect(html).toContain('Loading tasks…');
        expect(html).not.toContain('No tasks yet');
        expect(html).not.toContain('No tasks match');
    });

    it('answers an empty organization with the first-task call to action', () => {
        const html = renderInbox({ navigation: navigation(), items: [], nextCursor: null, initial: false });
        expect(html).toContain('No tasks yet');
        expect(html).toContain('Start your first task');
        expect(html).not.toContain('No tasks match');
    });

    it('answers a filtered empty set with Clear filters, never the first-task CTA', () => {
        const html = renderInbox({
            navigation: navigation({ review: 3 }),
            items: [],
            nextCursor: null,
            initial: false,
        });
        expect(html).toContain('No tasks match these filters');
        expect(html).toContain('href="/tasks"');
        expect(html).toContain('Clear filters');
        expect(html).not.toContain('No tasks yet');
    });

    it('renders an inline error with Retry when the first page fails with nothing to show', () => {
        const html = renderInbox({
            navigation: null,
            items: null,
            nextCursor: null,
            initial: false,
            // The hook's real shape: a first-page failure IS the retained refresh error
            // (`firstPageError`), so both fields carry it at once.
            error: 'database is down',
            refreshError: 'database is down',
        });
        expect(html).toContain('load tasks — database is down');
        expect(html).toContain('Retry');
        // Nothing was ever shown, so there is no "last successful update" to fall back on.
        expect(html).not.toContain('showing the last successful update');
    });

    it('keeps the rows beside the refresh error', () => {
        const html = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
            refreshError: 'Request failed (503)',
        });
        expect(html).toContain('showing the last successful update.');
        expect(html).toContain('fix the flaky login test');
    });

    it('keeps the rows beside an older-page failure, with its own Retry', () => {
        const html = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: 'abc',
            initial: false,
            loadMoreError: 'Request failed (503)',
        });
        expect(html).toContain('load more tasks — Request failed (503)');
        expect(html).toContain('fix the flaky login test');
    });
});

describe('TaskInboxPage states and tabs', () => {
    it('draws the state tabs on the shared .tabs strip, still links with aria-current', () => {
        const html = renderInbox({
            navigation: navigation(),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(html).toMatch(/<nav class="tabs inbox-tabs" aria-label="Task state">/);
        expect(html).toContain('aria-current="page"');
    });

    it('says loading, no-results and a failed first page through the shared state note', () => {
        const loading = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        expect(loading).toContain('<p class="state-note" role="status">Loading tasks…</p>');
        const none = renderInbox({
            navigation: navigation({ review: 3 }),
            items: [],
            nextCursor: null,
            initial: false,
        });
        expect(none).toContain('<p class="state-note">No tasks match these filters</p>');
        const failed = renderInbox({
            navigation: null,
            items: null,
            nextCursor: null,
            initial: false,
            error: 'database is down',
            refreshError: 'database is down',
        });
        expect(failed).toContain('state-note error');
        expect(failed).not.toContain('No tasks yet');
        expect(failed).not.toContain('No tasks match');
        expect(failed).not.toMatch(/inbox-count"/);
    });
});

describe('TaskInboxPage pagination', () => {
    it('offers Load more only when a cursor exists, disabling into Loading…', () => {
        const more = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: 'abc',
            initial: false,
        });
        expect(more).toContain('Load more');
        expect(more).not.toContain('disabled');
        const loading = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: 'abc',
            initial: false,
            loadingMore: true,
        });
        expect(loading).toContain('Loading…');
        expect(loading).toContain('disabled');
        const exhausted = renderInbox({
            navigation: navigation({ review: 1 }),
            items: [taskSummary()],
            nextCursor: null,
            initial: false,
        });
        expect(exhausted).not.toContain('Load more');
    });
});

describe('TaskInboxPage filters', () => {
    it('renders three state tabs — Needs review is part of Needs attention — with the active one marked', () => {
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        const tabs = html.match(/<nav class="tabs inbox-tabs"[^>]*>.*?<\/nav>/)?.[0] ?? '';
        expect(tabs).toContain('Needs attention');
        expect(tabs).toContain('Running');
        expect(tabs).toContain('Past');
        expect(tabs).not.toContain('Needs review');
        expect((tabs.match(/<a /g) ?? []).length).toBe(3);
        expect((html.match(/inbox-tab is-active/g) ?? []).length).toBe(1);
    });

    it('marks no tab current on the tab-less Needs review state', () => {
        const html = renderInbox(
            {
                navigation: null,
                items: null,
                nextCursor: null,
                initial: true,
                filters: { state: 'review', q: null, repo: null, author: null, sort: 'newest' },
            },
            '/tasks?state=review'
        );
        expect(html).not.toContain('inbox-tab is-active');
    });

    it('draws one quiet toolbar: a labeled search and three triggers, no Filter button or framed field', () => {
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        const toolbar = html.match(/<div class="inbox-toolbar">.*?<\/form>.*?<\/div>/)?.[0] ?? '';
        expect(html).toContain('<form class="inbox-search">');
        expect(html).toContain('placeholder="Search task requests"');
        expect(html).toMatch(/<input[^>]*aria-label="Search"/);
        expect(html).not.toContain('>Filter</button>');
        expect(html).not.toContain('<select');
        expect(toolbar).not.toContain('class="field"');
        for (const name of ['Repository: All repositories', 'Author: Anyone', 'Sort: Newest']) {
            expect(html).toMatch(new RegExp(`class="select-trigger inbox-trigger"[^>]*aria-label="${name}"`));
        }
    });

    it('carries the current filters into the labeled search form', () => {
        const html = renderInbox(
            {
                navigation: null,
                items: null,
                nextCursor: null,
                initial: true,
                filters: { state: 'review', q: 'login', repo: 'acme/widgets', author: 'octocat', sort: 'oldest' },
            },
            '/tasks?state=review&q=login&repo=acme%2Fwidgets&author=octocat&sort=oldest'
        );
        expect(html).toContain('value="login"');
        // Each applied trigger shows its value, accented; the repository by its short name with
        // the full one as its title, even though the workspace poll answered nothing.
        expect(html).toMatch(/class="select-trigger inbox-trigger is-applied"[^>]*aria-label="Author: octocat"/);
        expect(html).toMatch(/class="select-trigger inbox-trigger is-applied"[^>]*aria-label="Repository: widgets"/);
        expect(html).toContain('title="acme/widgets"');
        expect(html).toContain('aria-label="Sort: Oldest"');
    });

    describe('the repo select reads the tracked list', () => {
        const filtered: InboxTasks = {
            navigation: null,
            items: null,
            nextCursor: null,
            initial: true,
            filters: { state: 'attention', q: null, repo: 'acme/gone', author: null, sort: 'newest' },
        };
        const renderWith = (repos: object) =>
            renderToStaticMarkup(
                <MemoryRouter initialEntries={['/tasks?repo=acme%2Fgone']}>
                    <Routes>
                        <Route
                            element={
                                <Outlet context={{ tasks: filtered as UseTasks, workspace: emptyWorkspace, repos }} />
                            }
                        >
                            <Route path="tasks" index element={<TaskInboxPage />} />
                        </Route>
                    </Routes>
                </MemoryRouter>
            );
        const reposRead = (over: object) => ({ data: null, loading: false, error: null, refresh: () => {}, ...over });
        const tracked = (error: string | null) => ({
            repos: [{ owner: 'acme', name: 'web', private: false, defaultBranch: 'main', pushedAt: null }],
            installation: null,
            meta: { fetchedAt: null, error },
        });

        // The open list (tracked repositories plus a vanished filter) is driven in task-inbox.dom.test.tsx;
        // closed, the trigger still names the vanished filter.
        it('keeps a vanished filter on the trigger', () => {
            const html = renderWith(reposRead({ data: tracked(null) }));
            expect(html).toContain('title="acme/gone"');
        });

        it('offers only the active filter after a failed read, and claims nothing about the list', () => {
            const html = renderWith(reposRead({ error: 'Request failed (503)' }));
            expect(html).not.toContain('acme/web');
            expect(html).toContain('acme/gone');
            expect(html).not.toContain('No repositories');
        });
    });
});

describe('the composer route', () => {
    it('is not the inbox index: /tasks renders the inbox, /tasks/new its own address', () => {
        // Route-order pin: `new` must precede `:id` or the detail page would swallow it. The
        // inbox's own content is asserted above; here the route table's shape is what is pinned.
        const html = renderInbox({ navigation: null, items: null, nextCursor: null, initial: true });
        expect(html).toContain('Loading tasks…');
    });
});

describe('the inbox sweep', () => {
    it('never leaks the sentinel values into the markup', () => {
        const html = renderInbox({
            navigation: navigation({ running: 1 }),
            items: [taskSummary({ status: 'running', activity: '→ Bash npm test', author: null })],
            nextCursor: 'abc',
            initial: false,
        });
        for (const forbidden of ['NaN', 'undefined', 'Infinity', '[object Object]']) {
            expect(html).not.toContain(forbidden);
        }
    });
});

describe('repository filter state', () => {
    it('says why the repository list is unavailable and offers a retry', () => {
        const html = renderInbox({ items: [] }, '/tasks', {
            ...emptyRepos,
            loading: false,
            error: 'repo read failed',
        });
        expect(html).toContain('repo read failed');
        expect(html).toContain('Retry');
    });

    it('says the repository list is loading', () => {
        expect(renderInbox({ items: [] })).toContain('Loading repositories');
    });
});
