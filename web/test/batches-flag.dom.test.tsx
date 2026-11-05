import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockedActivityOf, publishedThread } from '../../e2e/fixtures/threads.js';
import { OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';

/** BEL-264: the web learns `batches` from `/api/auth/me` and shows nothing batch-shaped while it is not true. */
const TASK = publishedThread[0]!.id;
const BATCH = { id: 'bbbbbbbb-0000-4000-8000-000000000001', title: 'Rollout batch' };

/** The board as the shell reads it, with `batches` set (or the key missing, a malformed `/me`). */
function board(batches: boolean | 'missing') {
    const session: Record<string, unknown> = { ...OPEN_BOARD_SESSION };
    if (batches === 'missing') delete session.batches;
    else session.batches = batches;
    return stubFetch((call) => {
        if (call.url === '/api/auth/me') return session;
        if (call.url.startsWith('/api/batches')) return { batches: [BATCH] };
        if (/\/api\/jobs\/[^/]+\/thread/.test(call.url)) return { jobs: publishedThread };
        if (/\/api\/jobs\/[^/]+\/activity/.test(call.url)) return mockedActivityOf(publishedThread);
    });
}

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));
const batchFetches = (calls: { url: string }[]) => calls.filter((call) => call.url.startsWith('/api/batches'));
const sidenavLabels = (root: ParentNode) =>
    [...root.querySelectorAll('a.sidenav-link')].map((a) => a.textContent?.replace(/\d+$/, '').trim());

describe('batches off', () => {
    for (const batches of [false, 'missing'] as const) {
        it(`hides the Batches link from the sidenav and the drawer (batches: ${String(batches)})`, async () => {
            board(batches);
            const { container } = renderApp('/tasks');
            await settle();
            expect(sidenavLabels(container.querySelector('.sidenav')!)).toEqual(['Dashboard', 'Tasks', 'Settings']);
            await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
            expect(sidenavLabels(screen.getByRole('dialog', { name: 'Navigation' }))).toEqual([
                'Dashboard',
                'Tasks',
                'Settings',
            ]);
        });
    }

    for (const path of ['/batches', '/batches/new', '/batches/some-id']) {
        it(`${path} lands on the dashboard, shows no batch page and reads no batch API`, async () => {
            const calls = board(false);
            const { container, router } = renderApp(path);
            await settle();
            expect(router.state.location.pathname).toBe('/');
            expect(container.querySelector('.batch-backlink, [data-page="batches"]')).toBeNull();
            expect(screen.queryByText(/batch/i)).toBeNull();
            expect(batchFetches(calls)).toEqual([]);
        });
    }

    it('shows no backlink and does not ask which batches a task belongs to', async () => {
        const calls = board(false);
        const { container } = renderApp(`/tasks/${TASK}`);
        await settle();
        expect(container.querySelector('.batch-backlink')).toBeNull();
        expect(batchFetches(calls)).toEqual([]);
    });
});

describe('batches on', () => {
    it('lists Batches between Tasks and Settings, in the sidenav and the drawer', async () => {
        board(true);
        const { container } = renderApp('/tasks');
        await settle();
        const expected = ['Dashboard', 'Tasks', 'Batches', 'Settings'];
        expect(sidenavLabels(container.querySelector('.sidenav')!)).toEqual(expected);
        await userEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
        expect(sidenavLabels(screen.getByRole('dialog', { name: 'Navigation' }))).toEqual(expected);
    });

    it('keeps a direct visit to /batches on the batches page', async () => {
        board(true);
        const { router } = renderApp('/batches');
        await settle();
        expect(router.state.location.pathname).toBe('/batches');
    });

    it('shows the task backlink to its batch', async () => {
        const calls = board(true);
        const { container } = renderApp(`/tasks/${TASK}`);
        await settle();
        expect(container.querySelector('.batch-backlink')?.textContent).toContain(BATCH.title);
        expect(batchFetches(calls).length).toBeGreaterThan(0);
    });
});
