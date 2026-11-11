import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { mockedActivityOf, publishedThread } from '../../e2e/fixtures/threads.js';
import { RouteError } from '../src/components/RouteError.js';
import { OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';

/** BEL-313: a failed thread tick keeps the poll alive, says so with a Retry, and heals on its own. */
const TASK = publishedThread[0]!.id;
const threadFetches = (calls: { url: string }[]) => calls.filter((call) => /\/api\/jobs\/[^/]+\/thread/.test(call.url));

/** The thread answers `replies` in order (an HTTP status number is a failure), then the last one forever. */
function board(replies: (number | 'ok')[]) {
    let served = 0;
    return stubFetch((call) => {
        if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (/\/api\/jobs\/[^/]+\/activity/.test(call.url)) return mockedActivityOf(publishedThread);
        if (/\/api\/jobs\/[^/]+\/thread/.test(call.url)) {
            const reply = replies[Math.min(served++, replies.length - 1)]!;
            return reply === 'ok' ? { jobs: publishedThread } : { status: reply, body: { error: 'board unavailable' } };
        }
    });
}

describe('thread poll after a failed tick', () => {
    it('keeps polling, then clears the error and shows the thread once the board answers', async () => {
        const calls = board([503, 'ok']);
        renderApp(`/tasks/${TASK}`);
        expect((await screen.findByRole('alert')).textContent).toContain('board unavailable');
        const failed = threadFetches(calls).length;
        // The retry comes from the poll's own timer: nothing here asks for it.
        expect(await screen.findByRole('region', { name: 'Conversation' })).toBeTruthy();
        expect(threadFetches(calls).length).toBeGreaterThan(failed);
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    it('Retry fetches the thread at once', async () => {
        const calls = board([503, 503, 503, 'ok']);
        renderApp(`/tasks/${TASK}`);
        const retry = await screen.findByRole('button', { name: 'Retry' });
        const before = threadFetches(calls).length;
        await act(async () => {
            await userEvent.click(retry);
        });
        expect(threadFetches(calls).length).toBe(before + 1);
    });
});

describe('route errorElement', () => {
    it('renders an alert and a reload action when a route throws while rendering', () => {
        const Boom = () => {
            throw new Error('render blew up');
        };
        const router = createMemoryRouter([{ path: '*', element: <Boom />, errorElement: <RouteError /> }]);
        render(<RouterProvider router={router} />);
        expect(screen.getByRole('alert').textContent).toContain('render blew up');
        expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    });
});
