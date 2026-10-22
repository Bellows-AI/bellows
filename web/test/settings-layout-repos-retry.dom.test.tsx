import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UseTasks } from '../src/api/useTasks.js';
import { SettingsLayout } from '../src/pages/SettingsLayout.js';

/** A failed repository read must be retried when the reader moves between settings pages. */
function ShellStub() {
    return <Outlet context={{ tasks: { jobs: null, error: null } as unknown as UseTasks }} />;
}

function Nav() {
    return (
        <>
            <Link to="/settings/a">a</Link>
            <Link to="/settings/b">b</Link>
        </>
    );
}

describe('settings layout repository retry', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('reads /api/repos again on in-area navigation after a failure, but not after a success', async () => {
        // A data-router navigation builds a Node Request around jsdom's AbortSignal; drop it (see dom.tsx).
        const NodeRequest = globalThis.Request;
        vi.stubGlobal(
            'Request',
            class extends NodeRequest {
                constructor(input: RequestInfo | URL, init: RequestInit = {}) {
                    const { signal: _signal, ...rest } = init;
                    super(input, rest);
                }
            }
        );
        let repoReads = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (url === '/api/repos') {
                    repoReads += 1;
                    return repoReads === 1
                        ? new Response(JSON.stringify({ error: 'down' }), { status: 502 })
                        : Response.json({ repos: [], installation: null, meta: { fetchedAt: null, error: null } });
                }
                return new Response(JSON.stringify({}), { status: 500 });
            })
        );
        const router = createMemoryRouter(
            [
                {
                    element: <ShellStub />,
                    children: [
                        {
                            path: 'settings',
                            element: <SettingsLayout />,
                            children: [
                                { path: 'a', element: <Nav /> },
                                { path: 'b', element: <Nav /> },
                            ],
                        },
                    ],
                },
            ],
            { initialEntries: ['/settings/a'] }
        );
        render(<RouterProvider router={router} />);
        await waitFor(() => expect(repoReads).toBe(1));
        fireEvent.click(screen.getByText('b'));
        await waitFor(() => expect(repoReads).toBe(2));
        fireEvent.click(screen.getByText('a'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(repoReads).toBe(2);
    });
});
