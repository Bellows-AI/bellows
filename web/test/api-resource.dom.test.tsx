import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mutate } from '../src/api/mutate.js';
import { subscribeUnauthenticated } from '../src/api/useSession.js';
import { useResource } from '../src/api/useResource.js';
import './dom.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const selectItems = (body: { items: string[] }) => body.items;

function gateNews() {
    const heard = vi.fn();
    const off = subscribeUnauthenticated(heard);
    return { heard, off };
}

describe('useResource', () => {
    it('hands a 401 to the gate instead of rendering an error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, {})));
        const { heard, off } = gateNews();
        const { result } = renderHook(() => useResource('/api/x', selectItems));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(heard).toHaveBeenCalledTimes(1);
        expect(result.current.error).toBeNull();
        expect(result.current.data).toBeNull();
        off();
    });

    it('aborts the in-flight load when a newer refresh starts', async () => {
        const signals: AbortSignal[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init: RequestInit) => {
                signals.push(init.signal as AbortSignal);
                return signals.length === 1
                    ? new Promise<Response>((_, reject) =>
                          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
                      )
                    : Promise.resolve(json(200, { items: ['fresh'] }));
            })
        );
        const { result } = renderHook(() => useResource('/api/x', selectItems));
        await waitFor(() => expect(signals).toHaveLength(1));
        act(() => result.current.refresh());
        await waitFor(() => expect(result.current.data).toEqual(['fresh']));
        expect(signals[0]?.aborted).toBe(true);
        expect(result.current.error).toBeNull();
    });

    it('reports a malformed body as an error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));
        const { result } = renderHook(() => useResource('/api/x', selectItems));
        await waitFor(() => expect(result.current.error).not.toBeNull());
        expect(result.current.loading).toBe(false);
        expect(result.current.data).toBeNull();
    });
});

describe('mutate', () => {
    it('hands a 401 to the gate and answers a session-expired refusal', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, {})));
        const { heard, off } = gateNews();
        expect(await mutate('/api/x', { method: 'POST', body: {} })).toEqual({
            ok: false,
            error: 'Your session expired',
        });
        expect(heard).toHaveBeenCalledTimes(1);
        off();
    });

    it('carries the refusal sentence and code, falling back to the verb', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(422, { error: 'Bad', code: 'BAD' })));
        expect(await mutate('/api/x', { method: 'PUT', body: {} })).toEqual({ ok: false, error: 'Bad', code: 'BAD' });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(500, {})));
        expect(await mutate('/api/x', { method: 'PUT', body: {}, verb: 'Could not save' })).toEqual({
            ok: false,
            error: 'Could not save (500)',
        });
    });

    it('turns a malformed success body into an error rather than a rejection', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));
        const result = await mutate('/api/x', { method: 'POST', body: {} }, (response) => response.json());
        expect(result.ok).toBe(false);
    });
});
