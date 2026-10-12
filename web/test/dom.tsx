import { cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';
import { App, appRoutes } from '../src/App.js';
import { ThemeProvider } from '../src/theme.js';

/**
 * The shared harness of the `*.dom.test.tsx` layer — files that opt into jsdom with a
 * `@vitest-environment jsdom` docblock and drive the real components with Testing Library. The
 * board is a stubbed `fetch`; the router is a memory data router over the real route table, so a
 * page under test owns the same polls, blockers and links it owns in the browser.
 */

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.localStorage.clear();
});

// jsdom lacks these; Headless UI and the theme controller reach for them on mount.
if (typeof window !== 'undefined') {
    window.matchMedia ??= (query: string) =>
        ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
        }) as MediaQueryList;
    globalThis.ResizeObserver ??= class {
        observe() {}
        unobserve() {}
        disconnect() {}
    };
    Element.prototype.scrollIntoView ??= () => undefined;
}

export interface FetchCall {
    method: string;
    url: string;
    body: unknown;
}

/** A route's answer: a JSON body (status 200), or an explicit status, or a held promise. */
export type FetchReply = unknown | { status: number; body?: unknown } | Promise<unknown>;

export type FetchHandler = (call: FetchCall) => FetchReply | undefined;

const statusReply = (reply: unknown): reply is { status: number; body?: unknown } =>
    typeof reply === 'object' && reply !== null && 'status' in reply && typeof reply.status === 'number';

function toResponse(reply: unknown): Response {
    if (statusReply(reply)) {
        return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
            status: reply.status,
            headers: { 'content-type': 'application/json' },
        });
    }
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Replaces `fetch` with `handler`, recording every call. A handler returning `undefined` answers
 * 404, so an unexpected request is visible in `calls` rather than hanging the page.
 */
export function stubFetch(handler: FetchHandler): FetchCall[] {
    const calls: FetchCall[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const raw = init.body;
        const call: FetchCall = {
            method: (init.method ?? 'GET').toUpperCase(),
            url,
            body: typeof raw === 'string' ? safeJson(raw) : raw,
        };
        calls.push(call);
        const reply = await handler(call);
        return reply === undefined ? new Response(null, { status: 404 }) : toResponse(reply);
    });
    return calls;
}

function safeJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

/** Mounts the app's own route table at `path` under a memory data router. */
export function renderApp(path: string) {
    const router = createMemoryRouter([{ element: <App />, children: appRoutes }], { initialEntries: [path] });
    const view = render(
        <ThemeProvider>
            <RouterProvider router={router} />
        </ThemeProvider>
    );
    return { ...view, router };
}

/** Mounts one element at `path` under a memory data router, for a component that needs router context. */
export function renderAt(element: ReactNode, path = '/') {
    const router = createMemoryRouter([{ path: '*', element }], { initialEntries: [path] });
    return { ...render(<RouterProvider router={router} />), router };
}
