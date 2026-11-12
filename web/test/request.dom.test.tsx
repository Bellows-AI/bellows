import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from '../src/api/request.js';
import { subscribeUnauthenticated } from '../src/api/unauthenticated.js';

/** the ONE read shell — 401 to the gate once, refusals parsed, a bad body an error, never a cast. */
const answer = (status: number, body: string, contentType = 'application/json') =>
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } }))
    );

afterEach(() => vi.unstubAllGlobals());

describe('request', () => {
    it('hands a 401 to the gate exactly once and answers the expired-session sentence', async () => {
        answer(401, '{}');
        const gate = vi.fn();
        const off = subscribeUnauthenticated(gate);
        const result = await request('/api/x');
        off();
        expect(gate).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ ok: false, unauthenticated: true, status: 401 });
    });

    it('treats a non-JSON success body as an error, not a cast', async () => {
        answer(200, '<html>proxy page</html>', 'text/html');
        const result = await request('/api/x');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/unexpected|not json|malformed/i);
    });

    it('reads a refusal with its code and falls back to the verb and status', async () => {
        answer(409, '{"error":"taken","code":"CONFLICT"}');
        expect(await request('/api/x')).toMatchObject({ ok: false, error: 'taken', code: 'CONFLICT', status: 409 });
        answer(500, 'oops', 'text/plain');
        expect(await request('/api/x', { verb: 'Could not save' })).toMatchObject({
            ok: false,
            error: 'Could not save (500)',
        });
    });

    it('turns a network throw into a message and flags an abort', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
        expect(await request('/api/x')).toMatchObject({ ok: false, error: 'offline' });
        const controller = new AbortController();
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));
        controller.abort();
        expect(await request('/api/x', { signal: controller.signal })).toMatchObject({ ok: false, aborted: true });
    });

    it('runs the shape guard on the body and refuses a body that fails it', async () => {
        answer(200, '{"rows":3}');
        const isRows = (v: unknown): v is { rows: number[] } => Array.isArray((v as { rows?: unknown })?.rows);
        const result = await request('/api/x', { guard: isRows });
        expect(result.ok).toBe(false);
        answer(200, '{"rows":[1]}');
        expect(await request('/api/x', { guard: isRows })).toMatchObject({ ok: true, value: { rows: [1] } });
    });

    it('answers a 2xx with no body as undefined when asked for no body', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(null, { status: 204 }))
        );
        expect(await request('/api/x', { method: 'DELETE', empty: true })).toMatchObject({ ok: true });
    });

    it('reports an abort that lands while the body is being read as aborted, not malformed', async () => {
        const controller = new AbortController();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                const response = new Response('{}', { status: 200 });
                // The headers arrived; the body read is what the abort interrupts.
                vi.spyOn(response, 'json').mockImplementation(async () => {
                    controller.abort();
                    throw new DOMException('aborted', 'AbortError');
                });
                return response;
            })
        );
        expect(await request('/api/x', { signal: controller.signal })).toMatchObject({ ok: false, aborted: true });
    });
});
