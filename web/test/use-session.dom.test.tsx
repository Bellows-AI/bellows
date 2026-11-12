import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportUnauthenticated } from '../src/api/unauthenticated.js';
import { useSession } from '../src/api/useSession.js';

/** a slow older `/api/auth/me` check never overwrites the newer one; an unmounted hook sets nothing. */
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const me = (login: string | null) =>
    new Response(JSON.stringify(login === null ? { authenticated: false } : { authenticated: true, user: { login } }), {
        status: 200,
    });

describe('useSession ordering', () => {
    it('keeps the newest check when an older one answers last', async () => {
        const abortable = (signal: AbortSignal, answer: Response) =>
            new Promise<Response>((resolve, reject) => {
                signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                // The older check would resolve after the newer one, were it not aborted.
                setTimeout(() => resolve(answer), 50);
            });
        const calls: AbortSignal[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init: RequestInit) => {
                calls.push(init.signal as AbortSignal);
                return calls.length === 1
                    ? abortable(init.signal as AbortSignal, me('old'))
                    : Promise.resolve(me(null));
            })
        );
        const { result } = renderHook(() => useSession());
        await act(async () => {
            reportUnauthenticated();
        });
        await waitFor(() => expect(result.current.loading).toBe(false));
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(calls[0]?.aborted).toBe(true);
        expect(result.current.session).toBeNull();
        expect(result.current.error).toBeNull();
    });

    it('does not turn a 401 from its own probe into another probe', async () => {
        const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
        vi.stubGlobal('fetch', fetchMock);
        const { result } = renderHook(() => useSession());
        await waitFor(() => expect(result.current.error).toBe('Could not check the session (401)'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
