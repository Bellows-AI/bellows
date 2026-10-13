import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockedActivityOf, publishedThread } from '../../e2e/fixtures/threads.js';
import type { TaskListResponse, TaskSummary } from '../src/api/useTasks.js';
import { OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';

/** Every page the shell routes to, plus a task detail. */
const ROUTES = [
    '/',
    '/tasks',
    '/tasks/new',
    '/settings',
    '/settings/workspace',
    '/settings/repos',
    '/settings/executors',
    '/settings/organization',
    '/account',
    `/tasks/${publishedThread[0]!.id}`,
];

/** The board as the shell reads it: the session, a thread for the detail route; every other read refused. */
function board() {
    return stubFetch((call) => {
        if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (/\/api\/jobs\/[^/]+\/thread/.test(call.url)) return { jobs: publishedThread };
        if (/\/api\/jobs\/[^/]+\/activity/.test(call.url)) return mockedActivityOf(publishedThread);
    });
}

/** Lets the page's first reads land, so the count reads the settled page and not the first paint. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

describe('every routed page', () => {
    for (const path of ROUTES) {
        it(`${path} answers with one main region and at most one h1`, async () => {
            board();
            const { container } = renderApp(path);
            await settle();
            expect(container.querySelectorAll('main#main-content')).toHaveLength(1);
            // The dashboard's PageHeader owns the page's one h1; other routes keep the at-most-one
            // check because several render h2 section headings without a page title.
            const h1s = container.querySelectorAll('main h1').length;
            if (path === '/') expect(h1s).toBe(1);
            else expect(h1s).toBeLessThanOrEqual(1);
        });
    }

    it('carries the dashboard telemetry only on the dashboard', async () => {
        board();
        const dashboard = renderApp('/');
        await settle();
        expect(dashboard.container.querySelectorAll('.updated-at')).toHaveLength(1);
        dashboard.unmount();
        for (const path of ['/tasks', '/settings/workspace']) {
            const { container, unmount } = renderApp(path);
            await settle();
            expect(container.querySelectorAll('main#main-content'), path).toHaveLength(1);
            expect(container.querySelectorAll('.updated-at'), path).toHaveLength(0);
            unmount();
        }
    });
});

const PAGE_SIZE = 25;
const SECOND_PAGE = 15;
/** Past the inbox's idle poll (30s with nothing running). */
const PAST_IDLE_POLL_MS = 31_000;

function summary(n: number): TaskSummary {
    const stamp = new Date(Date.UTC(2026, 8, 1, 12, 0, 0) - n * 60_000).toISOString();
    return {
        id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`,
        command: `inbox task ${n}`,
        status: 'succeeded',
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
        createdAt: stamp,
        activityAt: stamp,
        needsAnswer: false,
    };
}

/** Two keyset pages; page two repeats page one's last row, the straddle the merge dedupes. */
function inboxPages(url: string): TaskListResponse | undefined {
    if (!url.startsWith('/api/tasks')) return undefined;
    const navigation = { counts: { running: 0, review: 0, past: PAGE_SIZE + SECOND_PAGE }, running: [], review: [] };
    if (url.includes('cursor=')) {
        const items = Array.from({ length: SECOND_PAGE + 1 }, (_, i) => summary(PAGE_SIZE + i));
        return { navigation, page: { items, nextCursor: null } };
    }
    const items = Array.from({ length: PAGE_SIZE }, (_, i) => summary(i + 1));
    return { navigation, page: { items, nextCursor: 'page-two' } };
}

describe('the task inbox poll', () => {
    it('keeps the loaded depth, each row once, and the focused field', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const calls = stubFetch((call) => inboxPages(call.url));
        const { container } = renderApp('/tasks');
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const rows = () => container.querySelectorAll('.inbox-row');

        await waitFor(() => expect(rows()).toHaveLength(PAGE_SIZE));
        // The first page landing is not an append: the polite note stays silent.
        expect(container.querySelector('.inbox-note')!.textContent).toBe('');
        await user.click(screen.getByRole('button', { name: 'Load more' }));
        await waitFor(() => expect(rows().length).toBeGreaterThan(PAGE_SIZE));
        const loaded = rows().length;
        expect(container.querySelector('.inbox-footer')!.textContent).toContain(`Showing ${loaded} loaded tasks`);

        const search = within(container.querySelector<HTMLElement>('.inbox-search')!).getByLabelText('Search');
        await user.click(search);
        await user.type(search, 'half-typed');

        // Past the idle poll interval: a refresh must neither collapse the depth nor steal focus.
        // At depth two the rebuild reads page two by cursor — that read is the rebuild landing.
        const before = calls.filter((call) => call.url.includes('cursor=')).length;
        await act(() => vi.advanceTimersByTimeAsync(PAST_IDLE_POLL_MS));
        await waitFor(() =>
            expect(calls.filter((call) => call.url.includes('cursor=')).length).toBeGreaterThan(before)
        );
        await act(() => vi.advanceTimersByTimeAsync(500));

        expect(document.activeElement).toBe(search);
        expect((search as HTMLInputElement).value).toBe('half-typed');
        expect(rows().length).toBeGreaterThanOrEqual(loaded);
        const hrefs = [...container.querySelectorAll('.inbox-row a')].map((a) => a.getAttribute('href'));
        expect(new Set(hrefs).size, 'each loaded task renders once').toBe(hrefs.length);
    });
});
