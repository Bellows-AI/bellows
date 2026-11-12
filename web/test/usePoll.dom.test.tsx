import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePoll, type PollOptions } from '../src/api/usePoll.js';

/** the ONE poll chain — cadence, visibility refetch, re-arm on error, abort safety, URL change. */
const SLOW = 60_000;
const every = (ms: number): PollOptions<{ n: number }> => ({ next: () => ms });

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const urls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map((call) => call[0] as string);

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('usePoll', () => {
    it('re-arms at the cadence next() names and stops when it answers null', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        let served = 0;
        const fetchMock = vi.fn(async () => reply(200, { n: ++served }));
        vi.stubGlobal('fetch', fetchMock);
        const { result } = renderHook(() =>
            usePoll<{ n: number }>('/api/a', { next: (o) => (o.kind === 'ok' && o.value.n >= 2 ? null : 1000) })
        );
        await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });
        expect(result.current.data).toEqual({ n: 2 });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(5000);
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the last answer, shows the error and re-arms after a failed tick', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const answers = [reply(200, { n: 1 }), reply(503, { error: 'down' }), reply(200, { n: 3 })];
        const fetchMock = vi.fn(async () => answers.shift()!);
        vi.stubGlobal('fetch', fetchMock);
        const { result } = renderHook(() => usePoll<{ n: number }>('/api/a', every(1000)));
        await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });
        expect(result.current.error).toBe('down');
        expect(result.current.data).toEqual({ n: 1 });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1000);
        });
        expect(result.current.data).toEqual({ n: 3 });
        expect(result.current.error).toBeNull();
    });

    it('leaves loading and error untouched when its request is aborted', async () => {
        let rejectFirst: (e: unknown) => void = () => undefined;
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(() => new Promise((_, reject) => (rejectFirst = reject)))
            .mockImplementation(async () => reply(200, { n: 2 }));
        vi.stubGlobal('fetch', fetchMock);
        const { result, rerender } = renderHook(({ url }) => usePoll<{ n: number }>(url, every(SLOW)), {
            initialProps: { url: '/api/a' },
        });
        expect(result.current.loading).toBe(true);
        rerender({ url: '/api/b' });
        // The first chain was aborted: its late rejection must not set an error or end loading.
        await act(async () => {
            rejectFirst(new DOMException('aborted', 'AbortError'));
        });
        await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
        expect(result.current.error).toBeNull();
        expect(urls(fetchMock)).toEqual(['/api/a', '/api/b']);
    });

    it('refetches at once when a hidden tab becomes visible, only when asked to', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const fetchMock = vi.fn(async () => reply(200, { n: 1 }));
        vi.stubGlobal('fetch', fetchMock);
        const hidden = vi.spyOn(document, 'hidden', 'get');
        hidden.mockReturnValue(true);
        const { result } = renderHook(() =>
            usePoll<{ n: number }>('/api/a', {
                next: (_o, isHidden) => (isHidden ? SLOW : 1000),
                refetchOnVisible: true,
            })
        );
        await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        hidden.mockReturnValue(false);
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        hidden.mockRestore();
    });

    it('clears the old answer on a URL change and does not refetch on visibility when not asked', async () => {
        const fetchMock = vi.fn(async (url: string) => reply(200, { n: url === '/api/a' ? 1 : 2 }));
        vi.stubGlobal('fetch', fetchMock);
        const { result, rerender } = renderHook(({ url }) => usePoll<{ n: number }>(url, every(SLOW)), {
            initialProps: { url: '/api/a' as string | null },
        });
        await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
        rerender({ url: '/api/b' });
        // Same render: the previous URL's rows are already gone, never shown under the new one.
        expect(result.current.data).toBeNull();
        await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
        document.dispatchEvent(new Event('visibilitychange'));
        expect(urls(fetchMock)).toEqual(['/api/a', '/api/b']);
        rerender({ url: null });
        expect(result.current.data).toBeNull();
        expect(result.current.loading).toBe(false);
    });

    it('keeps the held answer through a refresh of the same URL', async () => {
        const fetchMock = vi.fn(async () => reply(200, { n: 1 }));
        vi.stubGlobal('fetch', fetchMock);
        const { result } = renderHook(() => usePoll<{ n: number }>('/api/a', every(SLOW)));
        await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
        act(() => result.current.refresh());
        // Same render as the refresh: the page still holds the rows it had, and is not "loading".
        expect(result.current.data).toEqual({ n: 1 });
        expect(result.current.loading).toBe(false);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });
});
