import { describe, expect, it } from 'vitest';
import {
    createJiraIntegration,
    JIRA_OPERATIONS,
    JIRA_SCOPES,
    jiraAdf,
    jiraApiBase,
    jiraScopesFor,
} from '../src/integrations/jira.js';
import type {
    ConnectionHandle,
    CredentialSource,
    FetchLike,
    FetchResponseLike,
} from '../src/integrations/operation.js';
import { runOperation } from '../src/integrations/operation.js';

const enc = new TextEncoder();
const ORIGIN = 'https://api.example.test';
const def = createJiraIntegration({ apiOrigin: ORIGIN });

const handle = (scopes: readonly string[]): ConnectionHandle => ({
    connectionId: 'c1',
    provider: 'jira',
    resource: { id: 'cloud-a', label: 'site-a.example.test' },
    authority: { scopes },
});

const source = (scopes: readonly string[]): CredentialSource => ({
    async acquire() {
        return { ok: true as const, credential: { accessToken: 'tok', expiresAt: null, authority: { scopes } } };
    },
});

const respond = (status: number, json: unknown): FetchResponseLike => {
    const body = enc.encode(JSON.stringify(json));
    return {
        status,
        headers: { get: () => null },
        body: {
            getReader() {
                let done = false;
                return {
                    async read() {
                        if (done) return { done: true };
                        done = true;
                        return { done: false, value: body };
                    },
                    async cancel() {},
                };
            },
        },
    };
};

const fetcher = (answer: (url: string, n: number) => FetchResponseLike) => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fn: FetchLike = async (url, init) => {
        calls.push({
            url,
            method: init.method,
            body: init.body === undefined ? undefined : JSON.parse(init.body),
        });
        return answer(url, calls.length);
    };
    return Object.assign(fn, { calls });
};

const run = (
    op: (typeof JIRA_OPERATIONS)[keyof typeof JIRA_OPERATIONS],
    input: unknown,
    f: FetchLike,
    scopes: readonly string[] = jiraScopesFor('write')
) =>
    runOperation(
        def,
        op as never,
        { handle: handle(scopes), credentials: source(scopes), fetch: f, deadlineMs: 2000 },
        input as never
    );

const BASE = '/ex/jira/cloud-a/rest/api/3';

describe('jira operations', () => {
    it('getIssue builds the path from the handle resource, never from the input', async () => {
        const f = fetcher(() => respond(200, { key: 'ABC-1' }));
        const r = await run(
            JIRA_OPERATIONS.getIssue,
            { key: 'ABC-1', fields: ['summary', 'status'], cloud: 'evil' },
            f
        );
        expect(r).toEqual({ ok: true, value: { key: 'ABC-1' } });
        expect(f.calls[0]?.url).toBe(`${ORIGIN}${BASE}/issue/ABC-1?fields=summary%2Cstatus`);
        expect(f.calls[0]?.method).toBe('GET');
    });

    it('getIssue refuses a malformed key before any request', async () => {
        const f = fetcher(() => respond(200, {}));
        await expect(run(JIRA_OPERATIONS.getIssue, { key: '../../x' }, f)).rejects.toThrow();
        await expect(run(JIRA_OPERATIONS.getIssue, { key: 'abc-1' }, f)).rejects.toThrow();
        expect(f.calls).toHaveLength(0);
    });

    it('searchIssues follows nextPageToken until isLast, capped at maxItems', async () => {
        const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ key: `ABC-${n * 100 + i + 1}` }));
        const f = fetcher((_u, n) => respond(200, { issues: page(n), nextPageToken: `t${n}`, isLast: false }));
        const r = await run(JIRA_OPERATIONS.searchIssues, { jql: 'project = ABC', maxResults: 100 }, f);
        expect(r.ok && (r.value as unknown[]).length).toBe(200);
        expect(f.calls).toHaveLength(2);
        expect(f.calls[0]?.url).toBe(`${ORIGIN}${BASE}/search/jql?jql=project+%3D+ABC&maxResults=100`);
        expect(f.calls[1]?.url).toContain('nextPageToken=t1');
        expect(f.calls[1]?.url.match(/nextPageToken/g)).toHaveLength(1);
    });

    it('searchIssues stops when there is no nextPageToken', async () => {
        const f = fetcher((_u, n) =>
            respond(200, n === 1 ? { issues: [{ key: 'A-1' }], nextPageToken: 't1' } : { issues: [{ key: 'A-2' }] })
        );
        const r = await run(JIRA_OPERATIONS.searchIssues, { jql: 'x' }, f);
        expect(r).toEqual({ ok: true, value: [{ key: 'A-1' }, { key: 'A-2' }] });
        expect(f.calls).toHaveLength(2);
    });

    it('listComments pages by startAt and total', async () => {
        const f = fetcher((_u, n) => respond(200, { comments: [{ id: `${n}a` }, { id: `${n}b` }], total: 5 }));
        const r = await run(JIRA_OPERATIONS.listComments, { key: 'ABC-1' }, f);
        expect(r.ok && (r.value as unknown[]).length).toBe(6);
        expect(f.calls.map((c) => c.url)).toEqual([
            `${ORIGIN}${BASE}/issue/ABC-1/comment?startAt=0&maxResults=100&orderBy=created`,
            `${ORIGIN}${BASE}/issue/ABC-1/comment?startAt=2&maxResults=100&orderBy=created`,
            `${ORIGIN}${BASE}/issue/ABC-1/comment?startAt=4&maxResults=100&orderBy=created`,
        ]);
    });

    it('addComment posts ADF and the bellows-operation property; a 5xx after dispatch is outcome_unknown', async () => {
        const ok = fetcher(() => respond(201, { id: '10' }));
        await run(JIRA_OPERATIONS.addComment, { key: 'ABC-1', body: 'a\nb', receiptId: 'op-1' }, ok);
        expect(ok.calls[0]).toEqual({
            url: `${ORIGIN}${BASE}/issue/ABC-1/comment`,
            method: 'POST',
            body: { body: jiraAdf('a\nb'), properties: [{ key: 'bellows-operation', value: { receipt: 'op-1' } }] },
        });
        const bad = fetcher(() => respond(503, {}));
        const r = await run(JIRA_OPERATIONS.addComment, { key: 'ABC-1', body: 'x', receiptId: 'op-2' }, bad);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.outcome.outcome).toBe('outcome_unknown');
    });

    it('jiraAdf is one paragraph per line, with no empty text node', () => {
        expect(jiraAdf('a\n\nb')).toEqual({
            type: 'doc',
            version: 1,
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
                { type: 'paragraph' },
                { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
            ],
        });
    });

    it('addComment without write:jira-work is insufficient_scopes with no request', async () => {
        const f = fetcher(() => respond(201, {}));
        const r = await run(
            JIRA_OPERATIONS.addComment,
            { key: 'ABC-1', body: 'x', receiptId: 'k' },
            f,
            jiraScopesFor('read')
        );
        expect(r).toMatchObject({
            ok: false,
            outcome: {
                outcome: 'integration_required',
                reason: 'insufficient_scopes',
                missingScopes: ['write:jira-work'],
            },
        });
        expect(f.calls).toHaveLength(0);
    });

    it('myself reads /myself', async () => {
        const f = fetcher(() => respond(200, { accountId: 'a' }));
        await run(JIRA_OPERATIONS.myself, {}, f);
        expect(f.calls[0]?.url).toBe(`${ORIGIN}${BASE}/myself`);
    });
});

describe('jira scopes', () => {
    it('write scopes include read scopes, offline_access and read:jira-user', () => {
        const read = jiraScopesFor('read');
        const write = jiraScopesFor('write');
        for (const s of read) expect(write).toContain(s);
        expect(write).toContain('offline_access');
        expect(write).toContain('read:jira-user');
        expect(write).toContain('write:jira-work');
        expect(read).not.toContain('write:jira-work');
        expect(JIRA_SCOPES.write).toEqual(['write:jira-work']);
    });

    it('the definition maps capabilities to scopes and the api base is origin plus cloud', () => {
        expect(def.capabilities.write).toEqual(['write:jira-work']);
        expect(def.capabilities.read).not.toContain('offline_access');
        expect(def.skills).toEqual(['jira']);
        expect(jiraApiBase(ORIGIN, 'cloud-a')).toBe(`${ORIGIN}${BASE}`);
    });
});
