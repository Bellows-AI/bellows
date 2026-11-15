import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    classifyLinearAnswer,
    createLinearIntegration,
    LINEAR_ISSUE_KEY,
    LINEAR_OPERATIONS,
    LINEAR_SCOPES,
    linearApiBase,
    linearNotFound,
    linearScopesFor,
} from '../src/integrations/linear.js';
import type {
    ConnectionHandle,
    CredentialSource,
    FetchLike,
    FetchResponseLike,
} from '../src/integrations/operation.js';
import { runOperation } from '../src/integrations/operation.js';

const enc = new TextEncoder();
const ORIGIN = 'https://api.example.test';
const URL_ = `${ORIGIN}/graphql`;
const def = createLinearIntegration({ apiOrigin: ORIGIN });
const RECEIPT = '0b6c1a8e-3f4d-4c2b-9a1e-5d7f8e9a0b1c';
const ISSUE_UUID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const handle = (scopes: readonly string[]): ConnectionHandle => ({
    connectionId: 'c1',
    provider: 'linear',
    resource: { id: 'org-1', label: 'lane-workspace' },
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

const fetcher = (answer: (n: number) => FetchResponseLike) => {
    const calls: { url: string; method: string; body: { query: string; variables: Record<string, unknown> } }[] = [];
    const fn: FetchLike = async (url, init) => {
        calls.push({ url, method: init.method, body: init.body === undefined ? undefined : JSON.parse(init.body) });
        return answer(calls.length);
    };
    return Object.assign(fn, { calls });
};

const run = (
    op: (typeof LINEAR_OPERATIONS)[keyof typeof LINEAR_OPERATIONS],
    input: unknown,
    f: FetchLike,
    scopes: readonly string[] = linearScopesFor('write')
) =>
    runOperation(
        def,
        op as never,
        { handle: handle(scopes), credentials: source(scopes), fetch: f, deadlineMs: 2000 },
        input as never
    );

const connection = (nodes: unknown[], next: string | null) => ({
    nodes,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
});

type Fixture = { label: string; json: unknown };
const ANSWERS = JSON.parse(readFileSync(new URL('./fixtures/linear-answers.json', import.meta.url), 'utf8')) as Record<
    string,
    { input: unknown; accept: Fixture[]; reject: Fixture[] }
>;

describe('linear operations', () => {
    it('getIssue posts the issue query with the key as id', async () => {
        const valid = ANSWERS.getIssue?.accept[0]?.json as { data: { issue: Record<string, unknown> } };
        const issue = { ...valid.data.issue, identifier: 'ENG-1' };
        const f = fetcher(() => respond(200, { data: { issue } }));
        const r = await run(LINEAR_OPERATIONS.getIssue, { key: 'ENG-1' }, f);
        expect(r).toEqual({ ok: true, value: { data: { issue } } });
        expect(f.calls[0]?.url).toBe(URL_);
        expect(f.calls[0]?.method).toBe('POST');
        expect(f.calls[0]?.body.variables).toEqual({ id: 'ENG-1' });
        expect(f.calls[0]?.body.query).toMatch(/^query GetIssue\(\$id: String!\) \{ issue\(id: \$id\) \{/);
    });

    it('accepts a team key or a UUID as the issue, and refuses anything else before any request', async () => {
        const f = fetcher(() => respond(200, { data: { issue: {} } }));
        await run(LINEAR_OPERATIONS.getIssue, { key: ISSUE_UUID }, f);
        expect(f.calls[0]?.body.variables).toEqual({ id: ISSUE_UUID });
        for (const key of ['eng-1', 'ENG-0', 'ENG-01', 'ENGINEERING1-1', '../x', '', 'ENG-1 ']) {
            await expect(run(LINEAR_OPERATIONS.getIssue, { key }, f)).rejects.toThrow();
        }
        expect(f.calls).toHaveLength(1);
        expect(LINEAR_ISSUE_KEY.test('A1B2-42')).toBe(true);
    });

    it('searchIssues builds an IssueFilter from every structured field', async () => {
        const f = fetcher(() => respond(200, { data: { issues: connection([{ id: 'a' }], null) } }));
        const r = await run(
            LINEAR_OPERATIONS.searchIssues,
            { team: 'ENG', state: 'In Progress', assignee: 'me', label: 'Bug', project: 'Core', text: 'login' },
            f
        );
        expect(r).toEqual({ ok: true, value: [{ id: 'a' }] });
        expect(f.calls[0]?.body.query).toMatch(
            /^query SearchIssues\(\$filter: IssueFilter, \$first: Int, \$after: String\) \{ issues\(filter: \$filter, first: \$first, after: \$after\) \{ nodes \{/
        );
        expect(f.calls[0]?.body.query).toContain('pageInfo { hasNextPage endCursor }');
        expect(f.calls[0]?.body.variables).toEqual({
            first: 50,
            filter: {
                team: { key: { eq: 'ENG' } },
                state: { name: { eqIgnoreCase: 'In Progress' } },
                assignee: { isMe: { eq: true } },
                labels: { name: { eqIgnoreCase: 'Bug' } },
                project: { name: { eqIgnoreCase: 'Core' } },
                searchableContent: { contains: 'login' },
            },
        });
    });

    it('searchIssues matches a named assignee by email and needs at least one field', async () => {
        const f = fetcher(() => respond(200, { data: { issues: connection([], null) } }));
        await run(LINEAR_OPERATIONS.searchIssues, { assignee: 'dev@example.test', first: 500 }, f);
        expect(f.calls[0]?.body.variables).toEqual({
            first: 100,
            filter: { assignee: { email: { eq: 'dev@example.test' } } },
        });
        await expect(run(LINEAR_OPERATIONS.searchIssues, {}, f)).rejects.toThrow();
        await expect(run(LINEAR_OPERATIONS.searchIssues, { text: '', first: 5 }, f)).rejects.toThrow();
        expect(f.calls).toHaveLength(1);
    });

    it('searchIssues follows endCursor with the same query and stops at maxItems', async () => {
        const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ id: `${n}-${i}` }));
        const f = fetcher((n) => respond(200, { data: { issues: connection(page(n), `cur${n}`) } }));
        const r = await run(LINEAR_OPERATIONS.searchIssues, { team: 'ENG', first: 100 }, f);
        expect(r.ok && (r.value as unknown[]).length).toBe(200);
        expect(f.calls).toHaveLength(2);
        expect(f.calls[1]?.method).toBe('POST');
        expect(f.calls[1]?.body.query).toBe(f.calls[0]?.body.query);
        expect(f.calls[1]?.body.variables).toEqual({ ...f.calls[0]?.body.variables, after: 'cur1' });
    });

    it('listComments pages the issue comments until hasNextPage is false', async () => {
        const f = fetcher((n) =>
            respond(200, {
                data: { issue: { comments: connection([{ id: `c${n}` }], n < 3 ? `cur${n}` : null) } },
            })
        );
        const r = await run(LINEAR_OPERATIONS.listComments, { key: 'ENG-7' }, f);
        expect(r).toEqual({ ok: true, value: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] });
        expect(f.calls.map((c) => c.body.variables)).toEqual([
            { id: 'ENG-7', first: 100 },
            { id: 'ENG-7', first: 100, after: 'cur1' },
            { id: 'ENG-7', first: 100, after: 'cur2' },
        ]);
        expect(new Set(f.calls.map((c) => c.body.query)).size).toBe(1);
    });

    // An enumeration is complete only when Linear says so (`hasNextPage: false`): missing or odd page metadata is
    // an unconfirmed answer, never "that was everything".
    it.each([
        ['no pageInfo', { nodes: [{ id: 'a' }] }],
        ['a null pageInfo', { nodes: [{ id: 'a' }], pageInfo: null }],
        ['hasNextPage without endCursor', { nodes: [{ id: 'a' }], pageInfo: { hasNextPage: true } }],
        [
            'hasNextPage with an empty endCursor',
            { nodes: [{ id: 'a' }], pageInfo: { hasNextPage: true, endCursor: '' } },
        ],
        ['hasNextPage not a boolean', { nodes: [{ id: 'a' }], pageInfo: { hasNextPage: 'no', endCursor: null } }],
    ])('a page with %s is malformed, not a complete list', async (_label, page) => {
        const search = fetcher(() => respond(200, { data: { issues: page } }));
        expect(await run(LINEAR_OPERATIONS.searchIssues, { team: 'ENG' }, search)).toMatchObject({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'malformed-response' },
        });
        const comments = fetcher(() => respond(200, { data: { issue: { comments: page } } }));
        expect(await run(LINEAR_OPERATIONS.listComments, { key: 'ENG-7' }, comments)).toMatchObject({
            ok: false,
            outcome: { outcome: 'unavailable', reason: 'malformed-response' },
        });
    });

    it('listComments stops at maxPages', async () => {
        const f = fetcher((n) =>
            respond(200, { data: { issue: { comments: connection([{ id: `c${n}` }], `cur${n}`) } } })
        );
        const r = await run(LINEAR_OPERATIONS.listComments, { key: 'ENG-7' }, f);
        expect(f.calls).toHaveLength(10);
        expect(r.ok && (r.value as unknown[]).length).toBe(10);
    });

    it('addComment sends commentCreate with the receipt as the comment id', async () => {
        const f = fetcher(() => respond(200, { data: { commentCreate: { success: true, comment: { id: RECEIPT } } } }));
        const r = await run(LINEAR_OPERATIONS.addComment, { key: 'ENG-1', body: 'a\nb', receiptId: RECEIPT }, f);
        expect(r.ok).toBe(true);
        expect(f.calls[0]?.body.query).toMatch(
            /^mutation AddComment\(\$input: CommentCreateInput!\) \{ commentCreate\(input: \$input\) \{ success comment \{/
        );
        expect(f.calls[0]?.body.variables).toEqual({ input: { id: RECEIPT, issueId: 'ENG-1', body: 'a\nb' } });
    });

    it('addComment refuses an empty body, a bad key or a receipt that is not a UUID before any request', async () => {
        const f = fetcher(() => respond(200, {}));
        for (const input of [
            { key: 'ENG-1', body: '', receiptId: RECEIPT },
            { key: 'eng-1', body: 'x', receiptId: RECEIPT },
            { key: 'ENG-1', body: 'x', receiptId: 'op-1' },
        ]) {
            await expect(run(LINEAR_OPERATIONS.addComment, input, f)).rejects.toThrow();
        }
        expect(f.calls).toHaveLength(0);
    });

    it('addComment without write is insufficient_scopes with no request', async () => {
        const f = fetcher(() => respond(200, {}));
        const r = await run(
            LINEAR_OPERATIONS.addComment,
            { key: 'ENG-1', body: 'x', receiptId: RECEIPT },
            f,
            linearScopesFor('read')
        );
        expect(r).toEqual({
            ok: false,
            outcome: {
                outcome: 'integration_required',
                reason: 'insufficient_scopes',
                provider: 'linear',
                missingScopes: ['write'],
            },
        });
        expect(f.calls).toHaveLength(0);
    });

    it('viewer reads the viewer and its organization', async () => {
        const f = fetcher(() => respond(200, { data: { viewer: { id: 'u1' } } }));
        await run(LINEAR_OPERATIONS.viewer, {}, f, linearScopesFor('read'));
        expect(f.calls[0]?.body).toEqual({
            query: 'query Viewer { viewer { id name email organization { id name urlKey } } }',
            variables: {},
        });
    });
});

describe('linear GraphQL answers through runOperation', () => {
    const errors = (extensions: Record<string, unknown>) => ({ errors: [{ message: 'x', extensions }], data: null });

    it.each([
        [
            'authentication',
            errors({ code: 'AUTHENTICATION_ERROR', type: 'authentication error' }),
            { outcome: 'unavailable', reason: 'credential-rejected', retryable: true },
        ],
        [
            'forbidden',
            errors({ code: 'FORBIDDEN', type: 'forbidden' }),
            { outcome: 'forbidden', reason: 'provider-denied' },
        ],
        [
            'not found for the issue',
            {
                errors: [{ message: 'Entity not found: Issue', path: ['issue'], extensions: { code: 'INPUT_ERROR' } }],
                data: null,
            },
            { outcome: 'unavailable', reason: 'unexpected-status', retryable: true },
        ],
        // A not-found code that names no entity is not the issue's absence (linearNotFound).
        [
            'a not-found code that names no entity',
            errors({ code: 'ENTITY_NOT_FOUND', type: 'invalid input' }),
            { outcome: 'unavailable', reason: 'upstream-error', retryable: true },
        ],
        ['ratelimited', errors({ code: 'RATELIMITED', type: 'ratelimited' }), { outcome: 'rate_limited' }],
        [
            'an unknown error',
            errors({ code: 'INVALID_INPUT', type: 'invalid input' }),
            { outcome: 'unavailable', reason: 'upstream-error', retryable: true },
        ],
        ['no data', { data: null }, { outcome: 'unavailable', reason: 'malformed-response', retryable: true }],
        ['no data field at all', {}, { outcome: 'unavailable', reason: 'malformed-response', retryable: true }],
    ])('a 200 with %s is its failure outcome, never ok', async (_name, answer, outcome) => {
        const f = fetcher(() => respond(200, answer));
        expect(await run(LINEAR_OPERATIONS.getIssue, { key: 'ENG-1' }, f)).toEqual({ ok: false, outcome });
    });

    it('a write that ends in an unknown GraphQL error or no data is outcome_unknown', async () => {
        for (const answer of [errors({ code: 'INTERNAL_ERROR' }), { data: null }]) {
            const f = fetcher(() => respond(200, answer));
            expect(await run(LINEAR_OPERATIONS.addComment, { key: 'ENG-1', body: 'x', receiptId: RECEIPT }, f)).toEqual(
                { ok: false, outcome: { outcome: 'outcome_unknown', operation: 'addComment' } }
            );
        }
    });

    it('the most decisive error wins when several arrive', () => {
        const answer = {
            errors: [
                { message: 'bad input', extensions: { code: 'INVALID_INPUT' } },
                { message: 'not you', extensions: { type: 'authentication error' } },
            ],
        };
        expect(classifyLinearAnswer(answer, { name: 'getIssue', effect: 'read' }, 200)).toEqual({
            outcome: 'unavailable',
            reason: 'credential-rejected',
            retryable: true,
        });
        expect(classifyLinearAnswer({ data: { viewer: null } }, { name: 'viewer', effect: 'read' }, 200)).toBeNull();
    });

    // The shapes api.linear.app sends: a missing entity and a rate limit are HTTP 400 GraphQL error documents.
    const NOT_FOUND = {
        errors: [
            {
                message: 'Entity not found: Issue',
                extensions: { type: 'invalid input', code: 'INPUT_ERROR', statusCode: 400 },
            },
        ],
        data: null,
    };
    const unexpected = { outcome: 'unavailable', reason: 'unexpected-status', retryable: true };

    it.each([
        ['RATELIMITED', errors({ code: 'RATELIMITED', statusCode: 400 }), { outcome: 'rate_limited' }],
        ['an entity not found', NOT_FOUND, unexpected],
        [
            'AUTHENTICATION_ERROR',
            errors({ code: 'AUTHENTICATION_ERROR', statusCode: 401 }),
            { outcome: 'unavailable', reason: 'credential-rejected', retryable: true },
        ],
        [
            'FORBIDDEN',
            errors({ code: 'FORBIDDEN', type: 'forbidden' }),
            { outcome: 'forbidden', reason: 'provider-denied' },
        ],
        ['any other GraphQL error', errors({ code: 'INPUT_ERROR', type: 'invalid input' }), unexpected],
        ['a body that is no GraphQL document', { message: 'bad request' }, unexpected],
    ])('a 400 with %s is the outcome its status twin gets', async (_name, answer, outcome) => {
        for (const op of ['read', 'write'] as const) {
            const f = fetcher(() => respond(400, answer));
            const r =
                op === 'read'
                    ? await run(LINEAR_OPERATIONS.getIssue, { key: 'ENG-1' }, f)
                    : await run(LINEAR_OPERATIONS.addComment, { key: 'ENG-1', body: 'x', receiptId: RECEIPT }, f);
            expect(r).toEqual({ ok: false, outcome });
        }
    });

    it('a 200 with an entity not found reads like a 404', async () => {
        const f = fetcher(() => respond(200, NOT_FOUND));
        expect(await run(LINEAR_OPERATIONS.getIssue, { key: 'ENG-1' }, f)).toEqual({ ok: false, outcome: unexpected });
    });

    it('a second page with errors ends the search with its outcome', async () => {
        const f = fetcher((n) =>
            respond(
                200,
                n === 1 ? { data: { issues: connection([{ id: 'a' }], 'c1') } } : errors({ code: 'RATELIMITED' })
            )
        );
        expect(await run(LINEAR_OPERATIONS.searchIssues, { team: 'ENG' }, f)).toEqual({
            ok: false,
            outcome: { outcome: 'rate_limited' },
        });
    });
});

describe('linear scopes and definition', () => {
    it('write consent is read plus write', () => {
        expect(linearScopesFor('read')).toEqual(['read']);
        expect(linearScopesFor('write')).toEqual(['read', 'write']);
        expect(LINEAR_SCOPES).toEqual({ read: ['read'], write: ['write'] });
    });

    it('the definition maps capabilities to scopes and the api base is origin plus /graphql', () => {
        expect(def.id).toBe('linear');
        expect(def.kind).toBe('connection');
        expect(def.capabilities).toEqual({ read: ['read'], write: ['write'] });
        expect(def.api.pathPrefix).toBe('/graphql');
        expect(def.api.origin({ id: 'org-1', label: 'x' })).toBe(ORIGIN);
        expect(def.skills).toEqual(['factory-linear']);
        expect(linearApiBase(`${ORIGIN}/`)).toBe(URL_);
        expect(createLinearIntegration().api.origin({ id: 'org-1', label: 'x' })).toBe('https://api.linear.app');
    });
});

/**
 * Every operation's answer has one shape (`linearAnswerShape`), checked before any success: an answer that fails it
 * is `malformed-response` (`outcome_unknown` for the comment), never a value, an empty list or not-found. The same
 * fixtures pin the runner helper (server/test/linear-helper-parity.test.ts, driver/test/linear-helper.test.ts).
 */
describe('linear answer shapes through runOperation', () => {
    for (const [name, table] of Object.entries(ANSWERS).filter(([name]) => name in LINEAR_OPERATIONS)) {
        const op = LINEAR_OPERATIONS[name as keyof typeof LINEAR_OPERATIONS];
        it.each(table.accept.map((f) => [f.label, f.json]))(`${name} accepts %s`, async (_label, json) => {
            const r = await run(
                op,
                table.input,
                fetcher(() => respond(200, json))
            );
            expect(r.ok).toBe(true);
        });
        it.each(table.reject.map((f) => [f.label, f.json]))(`${name} refuses %s as malformed`, async (_label, json) => {
            const r = await run(
                op,
                table.input,
                fetcher(() => respond(200, json))
            );
            expect(r).toMatchObject({
                ok: false,
                outcome:
                    op.effect === 'write'
                        ? { outcome: 'outcome_unknown', operation: name }
                        : { outcome: 'unavailable', reason: 'malformed-response' },
            });
        });
    }
});

type NotFoundFixture = { label: string; op: string; json: unknown; notFound: boolean };
const NOT_FOUND = (ANSWERS as unknown as { notFound: NotFoundFixture[] }).notFound;

/** A not-found names the operation's own root entity (and, when Linear gives a path, that root field). */
describe('linear not-found is about the operation root only', () => {
    it.each(NOT_FOUND.map((f) => [f.op, f.label, f]))('%s: %s', (_op, _label, fixture) => {
        const { op, json, notFound } = fixture as NotFoundFixture;
        expect(linearNotFound(op, json)).toBe(notFound);
        const operation = LINEAR_OPERATIONS[op as keyof typeof LINEAR_OPERATIONS];
        const outcome = classifyLinearAnswer(json, operation, 200);
        // At 200 a root not-found reads like Jira's 404; any other entity's is an upstream error (or unknown for a write).
        if (notFound) expect(outcome).toEqual({ outcome: 'unavailable', reason: 'unexpected-status', retryable: true });
        else expect(outcome).not.toMatchObject({ reason: 'unexpected-status' });
    });
});

const PARTIAL = (ANSWERS as unknown as { partial: { label: string; op: string; json: unknown }[] }).partial;
const DEFINITIVE = ['credential-rejected', 'provider-denied', 'unexpected-status'];

/** Errors beside root data, or deeper than the root, never make a definitive verdict: partial data wins. */
describe('linear errors with partial data', () => {
    it.each(PARTIAL.map((f) => [f.op, f.label, f]))('%s: %s', (_op, _label, fixture) => {
        const { op, json } = fixture as { op: string; json: unknown };
        const operation = LINEAR_OPERATIONS[op as keyof typeof LINEAR_OPERATIONS];
        expect(linearNotFound(op, json)).toBe(false);
        for (const status of [200, 400]) {
            const outcome = classifyLinearAnswer(json, operation, status) as {
                outcome?: string;
                reason?: string;
            } | null;
            expect(outcome?.outcome).not.toBe('rate_limited');
            expect(outcome?.outcome).not.toBe('forbidden');
            expect(DEFINITIVE).not.toContain(outcome?.reason);
        }
    });
});
