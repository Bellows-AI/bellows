import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useRepos } from '../src/api/useRepos.js';
import { useWorkspace } from '../src/api/useWorkspace.js';
import { stubFetch } from './dom.js';

/**
 * The workspace read is executors only now: nothing clones, so nothing settles later. It is fetched
 * once, and again after an executor write — never on a timer.
 */

const payload = { executors: [], orgExecutors: [], defaultExecutor: null };
const reads = (calls: { method: string; url: string }[]) =>
    calls.filter((call) => call.method === 'GET' && call.url === '/api/workspace');

describe('useWorkspace', () => {
    it('fetches once and does not poll again after the answer', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const calls = stubFetch(({ url }) => (url === '/api/workspace' ? payload : undefined));
            const { result } = renderHook(() => useWorkspace());
            await waitFor(() => expect(result.current.data).not.toBeNull());
            await act(async () => {
                await vi.advanceTimersByTimeAsync(120_000);
            });
            expect(reads(calls)).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-fetches once after an executor save', async () => {
        const calls = stubFetch(({ method, url }) => {
            if (url === '/api/workspace') return payload;
            if (method === 'PUT' && url === '/api/workspace/executors') return {};
        });
        const { result } = renderHook(() => useWorkspace());
        await waitFor(() => expect(result.current.data).not.toBeNull());
        await act(async () => {
            expect(await result.current.saveExecutors([])).toBeNull();
        });
        await waitFor(() => expect(reads(calls)).toHaveLength(2));
    });

    it('exposes no repository selection or purge', async () => {
        stubFetch(({ url }) => (url === '/api/workspace' ? payload : undefined));
        const { result } = renderHook(() => useWorkspace());
        await waitFor(() => expect(result.current.data).not.toBeNull());
        expect(result.current).not.toHaveProperty('save');
        expect(result.current).not.toHaveProperty('purge');
    });
});

describe('useRepos', () => {
    it('refresh re-reads /api/repos, so a failed read can be retried', async () => {
        let answer: unknown = { status: 500, body: { error: 'boom' } };
        const calls = stubFetch(({ url }) => (url === '/api/repos' ? answer : undefined));
        const { result } = renderHook(() => useRepos(true));
        await waitFor(() => expect(result.current.error).toBe('boom'));
        answer = { repos: [], installation: null, meta: { fetchedAt: null, error: null } };
        await act(async () => {
            result.current.refresh();
        });
        await waitFor(() => expect(result.current.data).not.toBeNull());
        expect(result.current.error).toBeNull();
        expect(calls.filter((call) => call.url === '/api/repos')).toHaveLength(2);
    });
});
