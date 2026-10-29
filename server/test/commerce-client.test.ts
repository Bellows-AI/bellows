import { describe, expect, it } from 'vitest';
import { createCommerceClient } from '../src/commerce/commerce-client.js';
import type { UsageRecord } from '../src/db/commerce-store.js';

/** BEL-146: the outbound usage POST — authenticated, bounded, and never believing a partial answer. */
const TOKEN = 'commerce-test-token-0123456789abcdef-xyz';
const URL_BASE = 'https://commerce.example/';
const ORG = 'org-1';
const NEVER = 60_000;

const record = (n: number): UsageRecord => ({
    jobId: `00000000-0000-4000-8000-00000000000${n}`,
    rootJobId: `00000000-0000-4000-8000-00000000000${n}`,
    claimSeq: n,
    requestingJobId: null,
    launch: 'observed',
    adoptsClaimSeq: null,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T00:07:00.000Z',
    durationMs: 420_000,
});

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const keyOf = (r: UsageRecord) => ({ jobId: r.jobId, claimSeq: r.claimSeq });

function clientOver(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return handler(String(url), init);
    }) as typeof fetch;
    return { client: createCommerceClient({ url: URL_BASE, token: TOKEN, fetch: fetchFn }), calls };
}

describe('commerce client', () => {
    it('sends the bearer token and the records', async () => {
        const { client, calls } = clientOver(() => json({ accepted: [keyOf(record(1))] }));
        await client.reportUsage(ORG, [record(1)], Date.now() + NEVER);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(`https://commerce.example/v1/orgs/${ORG}/usage`);
        expect(calls[0]?.init.method).toBe('POST');
        expect((calls[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBe(`Bearer ${TOKEN}`);
        expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ records: [record(1)] });
    });

    it('acknowledges only keys that were sent and echoed', async () => {
        const stranger = { jobId: '99999999-0000-4000-8000-000000000000', claimSeq: 1 };
        const { client } = clientOver(() => json({ accepted: [keyOf(record(1)), stranger] }));
        const result = await client.reportUsage(ORG, [record(1), record(2)], Date.now() + NEVER);
        expect(result.acked).toEqual([keyOf(record(1))]);
        expect(result.errorCode).toBe('not_acknowledged');
    });

    it('a full acknowledgement carries no error', async () => {
        const { client } = clientOver(() => json({ accepted: [keyOf(record(1)), keyOf(record(2))] }));
        const result = await client.reportUsage(ORG, [record(1), record(2)], Date.now() + NEVER);
        expect(result).toEqual({ acked: [keyOf(record(1)), keyOf(record(2))], errorCode: null });
    });

    it.each([
        ['accepted is not a list', () => json({ accepted: 'x' })],
        ['accepted is missing', () => json({})],
        ['the body is not JSON', () => new Response('<html>', { status: 200 })],
        ['the body is empty', () => new Response('', { status: 200 })],
        ['an entry is not a key', () => json({ accepted: [null, 7, { jobId: 3 }] })],
    ])('a malformed ack acknowledges nothing: %s', async (_name, answer) => {
        const { client } = clientOver(answer);
        const result = await client.reportUsage(ORG, [record(1)], Date.now() + NEVER);
        expect(result.acked).toEqual([]);
        expect(result.errorCode).not.toBeNull();
    });

    it.each([
        ['401', () => json({}, 401)],
        ['404', () => json({}, 404)],
        ['400', () => json({ accepted: [keyOf(record(1))] }, 400)],
        ['500', () => json({ accepted: [keyOf(record(1))] }, 500)],
        ['429', () => json({}, 429)],
        ['a redirect', () => Response.redirect('https://elsewhere.example/', 302)],
        [
            'a connection reset',
            () => {
                throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
            },
        ],
    ])('treats %s as a failure, acknowledging nothing', async (_name, answer) => {
        const { client } = clientOver(answer);
        const result = await client.reportUsage(ORG, [record(1)], Date.now() + NEVER);
        expect(result.acked).toEqual([]);
        expect(result.errorCode).not.toBeNull();
    });

    it('bounds the call by the absolute deadline', async () => {
        const { client } = clientOver(
            (_url, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                })
        );
        const started = Date.now();
        const result = await client.reportUsage(ORG, [record(1)], started + 120);
        expect(Date.now() - started).toBeLessThan(2000);
        expect(result.acked).toEqual([]);
        expect(result.errorCode).not.toBeNull();
    });

    it('dispatches nothing once the deadline has passed', async () => {
        const { client, calls } = clientOver(() => json({ accepted: [keyOf(record(1))] }));
        const result = await client.reportUsage(ORG, [record(1)], Date.now() - 1);
        expect(calls).toHaveLength(0);
        expect(result).toEqual({ acked: [], errorCode: 'deadline' });
    });

    it('a body that breaks mid-stream is a failure', async () => {
        const { client } = clientOver(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"accepted":['));
                },
                pull() {
                    throw new Error('stream broke');
                },
            });
            return new Response(body, { status: 200 });
        });
        const result = await client.reportUsage(ORG, [record(1)], Date.now() + NEVER);
        expect(result.acked).toEqual([]);
        expect(result.errorCode).not.toBeNull();
    });

    it('never puts the token in an error', async () => {
        const answers = [
            () => json({ error: `bad ${TOKEN}` }, 500),
            () => {
                throw new Error(`boom ${TOKEN}`);
            },
            () => new Response(TOKEN, { status: 200 }),
        ];
        for (const answer of answers) {
            const { client } = clientOver(answer);
            const result = await client.reportUsage(ORG, [record(1)], Date.now() + NEVER);
            expect(JSON.stringify(result)).not.toContain(TOKEN);
        }
    });

    it('encodes the org id into the path', async () => {
        const { client, calls } = clientOver(() => json({ accepted: [] }));
        await client.reportUsage('a/b', [record(1)], Date.now() + NEVER);
        expect(calls[0]?.url).toBe('https://commerce.example/v1/orgs/a%2Fb/usage');
    });
});
