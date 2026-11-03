import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { BridgeOutcome } from '../src/mcp/bridge.js';
import { mapResult } from '../src/mcp/result.js';

const Schema = z.object({ items: z.array(z.string()), stale: z.boolean().optional() }).loose();
const summarize = (data: z.output<typeof Schema>) => `${data.items.length} items`;
const respond = (status: number, body: unknown): BridgeOutcome => ({ kind: 'response', status, body });
/** True when the text holds a tag bracket or a control character. */
const unsafe = (text: string): boolean =>
    Array.from(text).some((ch) => ch === '<' || ch === '>' || (ch.codePointAt(0) ?? 0) < 0x20);
const map = (outcome: BridgeOutcome) => mapResult(outcome, Schema, summarize);

describe('mapping a bridge outcome to a tool result', () => {
    it('a 2xx that passes the schema is structured content plus a text summary', () => {
        const mapped = map(respond(200, { items: ['a', 'b'] }));
        expect(mapped.outcome).toBe('ok');
        expect(mapped.result.isError).toBeUndefined();
        expect(mapped.result.structuredContent).toEqual({ items: ['a', 'b'] });
        expect(mapped.result.content).toEqual([{ type: 'text', text: '2 items' }]);
    });

    it('a stale payload stays stale, and fields the schema does not name are kept', () => {
        const mapped = map(respond(200, { items: [], stale: true, asOf: 'earlier' }));
        expect(mapped.result.structuredContent).toEqual({ items: [], stale: true, asOf: 'earlier' });
    });

    it.each([
        ['null', respond(200, null)],
        ['an empty body', respond(200, undefined)],
        ['a malformed body', respond(200, 'oops')],
        ['a body failing the schema', respond(200, { items: 'no' })],
        ['a 500', respond(500, { error: 'boom', code: 'INTERNAL' })],
        ['a 503', respond(503, { error: 'down', code: 'UNAVAILABLE' })],
        ['a redirect', respond(302, undefined)],
        ['a 4xx with no explanation', respond(404, undefined)],
        ['a timeout', { kind: 'inconclusive', reason: 'timeout' } as const],
        ['an abort', { kind: 'inconclusive', reason: 'aborted' } as const],
        ['a transport failure', { kind: 'inconclusive', reason: 'transport' } as const],
    ])('%s is inconclusive: an error that claims neither success nor failure', (_name, outcome) => {
        const mapped = map(outcome);
        expect(mapped.outcome).toBe('inconclusive');
        expect(mapped.result.isError).toBe(true);
        expect(mapped.result.structuredContent).toMatchObject({ outcome: 'inconclusive' });
    });

    it('a 4xx gives the board code and message verbatim', () => {
        const mapped = map(respond(409, { error: 'The task already finished', code: 'JOB_FINISHED' }));
        expect(mapped.outcome).toBe('refused');
        expect(mapped.result.isError).toBe(true);
        expect(mapped.result.structuredContent).toEqual({
            outcome: 'refused',
            code: 'JOB_FINISHED',
            message: 'The task already finished',
            status: 409,
        });
        expect(mapped.result.content).toEqual([{ type: 'text', text: 'JOB_FINISHED: The task already finished' }]);
    });

    it('a 4xx that has only an error name uses it as the code (insufficient_scope)', () => {
        const mapped = map(respond(403, { error: 'insufficient_scope' }));
        expect(mapped.result.structuredContent).toMatchObject({ outcome: 'refused', code: 'insufficient_scope' });
    });

    it('keeps the code verbatim but bounds the message and strips control characters and HTML tags', () => {
        const hostile = `<script>alert(1)</script>bad\u0000\u001b[31m input ${'x'.repeat(2000)}`;
        const mapped = map(respond(400, { error: hostile, code: 'VALIDATION_FAILED' }));
        const structured = mapped.result.structuredContent as { code: string; message: string };
        expect(structured.code).toBe('VALIDATION_FAILED');
        expect(structured.message.length).toBeLessThanOrEqual(500);
        expect(unsafe(structured.message)).toBe(false);
        expect(structured.message).toContain('bad');
        const text = (mapped.result.content[0] as { text: string }).text;
        expect(text.startsWith('VALIDATION_FAILED: ')).toBe(true);
        expect(unsafe(text)).toBe(false);
    });

    it('uses a code-less error text as the code only when it is a plain identifier', () => {
        const odd = map(respond(400, { error: `<b>nope</b> ${'y'.repeat(900)}` }));
        const structured = odd.result.structuredContent as { code: string; message: string };
        expect(structured.code).toBe('board_refused');
        expect(structured.message.length).toBeLessThanOrEqual(500);
        expect(unsafe(structured.message)).toBe(false);
        expect(map(respond(403, { error: 'insufficient_scope' })).result.structuredContent).toMatchObject({
            code: 'insufficient_scope',
        });
    });
});
