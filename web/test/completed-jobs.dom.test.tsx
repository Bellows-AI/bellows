import { OBJECTIVE_MODE } from '@factory-ai/core';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeUnauthenticated } from '../src/api/unauthenticated.js';
import { useCompletedJobs } from '../src/api/useCompletedJobs.js';
import type { Job } from '../src/api/useJobs.js';

/**
 * The board poll the dashboard's task section runs, pinned at the wire: the EIGHT-row bound
 * travels in the request (the server bounds the list; the panel renders what it gets), a
 * failed tick keeps the last good rows, the server's own error message wins over the
 * status-line fallback, and a 401 goes to the gate and ends the chain.
 */

const job = (id: string): Job => ({
    id,
    command: 'do the thing',
    title: null,
    titleOrigin: null,
    titleRevision: 0,
    status: 'succeeded',
    attempts: 1,
    author: null,
    stoppedBy: null,
    doneBy: null,
    sessionId: null,
    exitCode: 0,
    output: null,
    summary: null,
    failureKind: null,
    gates: null,
    runtime: null,
    repo: null,
    executor: null,
    workflowNode: null,
    workflowName: null,
    mode: OBJECTIVE_MODE,
    followUpTo: null,
    rootJobId: id,
    doneAt: null,
    cancelRequestedAt: null,
    workspacePath: null,
    createdAt: '2026-08-21T12:00:00.000Z',
    startedAt: null,
    finishedAt: '2026-08-21T12:20:00.000Z',
    wallClockMs: null,
    agentTurns: null,
    setupMs: null,
    interruptions: [],
    taskWallClockMs: null,
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
    questions: [],
    connections: [],
    bindingRevision: 0,
    attachments: [],
    integrationRequirements: [],
    executionUser: null,
    actingFor: null,
});

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const VISIBLE_POLL_DELAY_MS = 30_000;
const HIDDEN_POLL_DELAY_MS = 60_000;

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('useCompletedJobs', () => {
    it('requests the terminal list bounded at eight rows and lands the rows', async () => {
        const fetch = vi.fn().mockResolvedValue(json({ jobs: [job('j1')] }));
        vi.stubGlobal('fetch', fetch);
        const { result } = renderHook(() => useCompletedJobs());
        await waitFor(() => expect(result.current.jobs?.[0]?.id).toBe('j1'));
        expect(fetch).toHaveBeenCalledWith('/api/jobs?status=terminal&limit=8', expect.anything());
        expect(result.current.error).toBeNull();
    });

    it('keeps the last good rows when a later tick fails, with the server message, and re-arms', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const responses = [json({ jobs: [job('good')] }), json({ error: 'board exploded' }, 500), json({ jobs: [] })];
        const fetch = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()));
        vi.stubGlobal('fetch', fetch);
        const { result } = renderHook(() => useCompletedJobs());
        await waitFor(() => expect(result.current.jobs?.[0]?.id).toBe('good'));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(VISIBLE_POLL_DELAY_MS);
        });
        expect(result.current.error).toBe('board exploded');
        expect(result.current.jobs?.[0]?.id).toBe('good');
        await act(async () => {
            await vi.advanceTimersByTimeAsync(VISIBLE_POLL_DELAY_MS);
        });
        expect(result.current.jobs).toEqual([]);
        expect(result.current.error).toBeNull();
    });

    it('falls back to the status line when the body names no error', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 503)));
        const { result } = renderHook(() => useCompletedJobs());
        await waitFor(() => expect(result.current.error).toBe('Request failed (503)'));
    });

    it('polls a hidden tab at the slower pace', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ jobs: [] })));
        vi.stubGlobal('fetch', fetch);
        renderHook(() => useCompletedJobs());
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
        await act(async () => {
            await vi.advanceTimersByTimeAsync(VISIBLE_POLL_DELAY_MS);
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(HIDDEN_POLL_DELAY_MS - VISIBLE_POLL_DELAY_MS);
        });
        expect(fetch).toHaveBeenCalledTimes(2);
        hidden.mockRestore();
    });

    it('hands a 401 to the session gate and stops polling', async () => {
        // An expired session is not a board failure: the gate takes over, and the poll must
        // NOT re-arm — a dead session must not become an infinite re-auth loop.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const gate = vi.fn();
        const off = subscribeUnauthenticated(gate);
        try {
            const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({}, 401)));
            vi.stubGlobal('fetch', fetch);
            const { result } = renderHook(() => useCompletedJobs());
            await waitFor(() => expect(gate).toHaveBeenCalledTimes(1));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(HIDDEN_POLL_DELAY_MS * 2);
            });
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(result.current.error).toBeNull();
        } finally {
            off();
        }
    });
});
