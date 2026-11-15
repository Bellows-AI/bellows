#!/usr/bin/env node
'use strict';
/*
 * The runner's Linear helper (docs/connections.md): issue, search, comments and add-comment against the
 * task's managed Linear connection. The board lists the connections bound to this task and issues a
 * token through the credential broker; this talks to Linear's GraphQL endpoint directly. No command prints
 * a token, and a token reaches nothing but the Authorization header of a request to the connection's apiBase.
 *
 * Requests and the reading of a GraphQL answer mirror core/src/integrations/linear.ts
 * (server/test/linear-helper-parity.test.ts pins the requests, next pages, scopes and the classifier).
 *
 * One wall-clock deadline covers every board and Linear request, retry and wait of a call. Exit codes:
 * 0 ok; 1 refused, bad input or unreachable past the deadline; 3 the user must connect or widen the
 * connection; 4 the add-comment outcome is unknown or in flight. A comment's id is its receipt's id, so a
 * possibly-posted comment is reconciled by reading `comment(id:)`, and a re-send can never post twice.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');

const PATH_PREFIX = '/graphql';
const DEADLINE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ASK_TIMEOUT_MS = 30_000;
const BACKOFF_MS = 250;
const BACKOFF_MAX_MS = 2000;
const BODY_CAP_BYTES = 8 * 1024 * 1024;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INTEGRATION_REQUIRED = 3;
const EXIT_UNKNOWN = 4;
const MS_PER_SECOND = 1000;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/;
const LINEAR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['started', 'dispatched', 'succeeded', 'failed', 'unknown'];
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_REDIRECT = 300;

const REQUIRED_SCOPES = {
    getIssue: ['read'],
    searchIssues: ['read'],
    listComments: ['read'],
    addComment: ['write'],
    viewer: ['read'],
    /** The reconcile read, helper-only. */
    comment: ['read'],
};
const PAGES = {
    searchIssues: { path: ['issues'], field: 'issues', maxPages: 10, maxItems: 200 },
    listComments: { path: ['issue', 'comments'], field: 'comments', maxPages: 10, maxItems: 1000 },
};

/** A call's end: the exit code, the closed outcome and reason on stdout, the guidance on stderr. */
class Stop extends Error {
    constructor(code, outcome, reason, message, extra = {}) {
        super(message);
        this.code = code;
        this.outcome = outcome;
        this.reason = reason;
        this.extra = extra;
    }
}
const bad = (message) => new Stop(EXIT_FAILED, 'bad_input', 'bad_input', message);
const deadline = () => new Stop(EXIT_FAILED, 'unavailable', 'deadline', 'linear: the call ran past its deadline; retry the step shortly.');
const refusedByBoard = () =>
    new Stop(
        EXIT_FAILED,
        'refused',
        'board_refused',
        'linear: the board refused this attempt: it holds a lease it no longer holds, or its task is no longer authorized. Each call reads the current pair: retry once, and if a fresh call is refused the same way, report it.'
    );

// ---- Requests: the core's operations, restated (the parity test is the enforcement) ----

const ISSUE_FIELDS =
    'id identifier title url priority createdAt updatedAt state { name type } assignee { id name email } ' +
    'team { key name } project { name } labels { nodes { name } }';
const PAGE_INFO = 'pageInfo { hasNextPage endCursor }';
const QUERIES = {
    getIssue: `query GetIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} description } }`,
    searchIssues:
        'query SearchIssues($filter: IssueFilter, $first: Int, $after: String) { ' +
        `issues(filter: $filter, first: $first, after: $after) { nodes { ${ISSUE_FIELDS} } ${PAGE_INFO} } }`,
    listComments:
        'query ListComments($id: String!, $first: Int, $after: String) { issue(id: $id) { ' +
        `comments(first: $first, after: $after) { nodes { id body url createdAt updatedAt user { id name email } } ${PAGE_INFO} } } }`,
    addComment:
        'mutation AddComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url createdAt } } }',
    viewer: 'query Viewer { viewer { id name email organization { id name urlKey } } }',
};
/** The reconcile read: helper-only, never a write. */
const COMMENT_BY_ID = 'query Comment($id: String!) { comment(id: $id) { id issue { id identifier } } }';

const graphql = (query, variables) => ({ method: 'POST', path: PATH_PREFIX, body: { query, variables } });
const record = (value) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null);
const issueRef = (key) => {
    if (typeof key !== 'string' || (!ISSUE_KEY.test(key) && !LINEAR_UUID.test(key))) throw new Error('not a Linear issue key or id');
    return key;
};

/** The IssueFilter for a structured search; at least one field. */
function issueFilter(input) {
    const given = (value) => typeof value === 'string' && value !== '';
    const filter = {};
    if (given(input.team)) filter.team = { key: { eq: input.team } };
    if (given(input.state)) filter.state = { name: { eqIgnoreCase: input.state } };
    if (given(input.assignee)) filter.assignee = input.assignee === 'me' ? { isMe: { eq: true } } : { email: { eq: input.assignee } };
    if (given(input.label)) filter.labels = { name: { eqIgnoreCase: input.label } };
    if (given(input.project)) filter.project = { name: { eqIgnoreCase: input.project } };
    if (given(input.text)) filter.searchableContent = { contains: input.text };
    if (Object.keys(filter).length === 0) throw new Error('a Linear search needs at least one filter field');
    return filter;
}

/** The request of one operation: always a POST of {query, variables} to the GraphQL endpoint. */
function requestFor(op, input) {
    switch (op) {
        case 'getIssue':
            return graphql(QUERIES.getIssue, { id: issueRef(input.key) });
        case 'searchIssues': {
            const first = Math.min(Math.max(Math.floor(input.first ?? 50), 1), 100);
            return graphql(QUERIES.searchIssues, { filter: issueFilter(input), first });
        }
        case 'listComments':
            return graphql(QUERIES.listComments, { id: issueRef(input.key), first: 100 });
        case 'addComment':
            if (input.body === '') throw new Error('a comment needs a body');
            if (!LINEAR_UUID.test(input.receiptId)) throw new Error('a Linear comment id must be a UUID');
            return graphql(QUERIES.addComment, { input: { id: input.receiptId, issueId: issueRef(input.key), body: input.body } });
        case 'viewer':
            return graphql(QUERIES.viewer, {});
        default:
            throw new Error(`unknown operation ${op}`);
    }
}

/** The GraphQL connection at `data.<path>`; throws when the answer has none. */
function connectionAt(json, path) {
    let at = record(json)?.data;
    for (const field of path) at = record(at)?.[field];
    const nodes = record(at)?.nodes;
    if (!Array.isArray(nodes)) throw new Error(`no ${path.join('.')} nodes`);
    return { nodes, pageInfo: record(at)?.pageInfo };
}

/**
 * The request for the page after the one just read, or null (the core's relay pagination, restated). Only
 * `hasNextPage: false` ends the list; missing or odd page metadata throws (malformed), never "complete".
 */
function nextRequest(op, json, previous) {
    const { path } = PAGES[op];
    const info = record(connectionAt(json, path).pageInfo);
    if (info?.hasNextPage === false) return null;
    const cursor = info?.endCursor;
    if (info?.hasNextPage !== true || typeof cursor !== 'string' || cursor === '') throw new Error(`malformed ${path.join('.')} pageInfo`);
    return { ...previous, body: { ...previous.body, variables: { ...previous.body.variables, after: cursor } } };
}

// ---- Answer shapes: core's linearAnswerShape, restated (the parity test runs both on the same fixtures) ----

const text = (value) => typeof value === 'string' && value !== '';
const objectOrNull = (value) => value === null || record(value) !== null;
const ISSUE_OBJECTS = ['state', 'assignee', 'team', 'project', 'labels'];

function issueShape(value) {
    const issue = record(value);
    return (
        issue !== null &&
        text(issue.id) &&
        text(issue.identifier) &&
        typeof issue.title === 'string' &&
        ISSUE_OBJECTS.every((field) => field in issue && objectOrNull(issue[field])) &&
        (issue.description === null || typeof issue.description === 'string')
    );
}

function pageShape(value) {
    const page = record(value);
    const info = record(page?.pageInfo);
    const nodes = page?.nodes;
    return (
        Array.isArray(nodes) &&
        nodes.every((node) => text(record(node)?.id)) &&
        (info?.hasNextPage === false || (info?.hasNextPage === true && text(info.endCursor)))
    );
}

const SHAPES = {
    getIssue: (data) => issueShape(data.issue),
    searchIssues: (data) => pageShape(data.issues),
    listComments: (data) => pageShape(record(data.issue)?.comments),
    addComment: (data, request) => {
        const created = record(data.commentCreate);
        const id = record(created?.comment)?.id;
        const sent = record(record(request.body?.variables)?.input)?.id;
        return created?.success === true && text(id) && id === sent;
    },
    viewer: (data) => {
        const viewer = record(data.viewer);
        const org = record(viewer?.organization);
        return text(viewer?.id) && text(org?.id) && text(org?.urlKey);
    },
    // Helper-only: the reconcile read's comment, which reconcile then matches to the receipt and the issue.
    comment: (data) => text(record(data.comment)?.id),
};

/** Whether a 2xx answer is well-formed for `op`: core's `linearAnswerShape`. Anything else confirms nothing. */
function answerShape(op, json, request) {
    const answer = record(json);
    if (answer === null) return false;
    if (answer.errors !== undefined && !(Array.isArray(answer.errors) && answer.errors.length === 0)) return false;
    const data = record(answer.data);
    const shape = SHAPES[op];
    return data !== null && shape !== undefined && shape(data, request);
}

// ---- Reading a GraphQL answer: the core classifier, restated ----

/** The error kinds, most decisive first: the first kind any error carries is the answer's outcome. */
const ERROR_KINDS = [
    { kind: 'authentication', match: /authentication/, outcome: { outcome: 'unavailable', reason: 'credential-rejected', retryable: true } },
    { kind: 'forbidden', match: /forbidden/, outcome: { outcome: 'forbidden', reason: 'provider-denied' } },
    { kind: 'ratelimit', match: /ratelimit/, outcome: { outcome: 'rate_limited' } },
];
const NOT_FOUND_OUTCOME = { outcome: 'unavailable', reason: 'unexpected-status', retryable: true };
/** Each operation's root field: the one `data` field its answer carries (core's ROOT_FIELDS, plus the reconcile read). */
const ROOT_FIELDS = { getIssue: 'issue', searchIssues: 'issues', listComments: 'issue', addComment: 'commentCreate', viewer: 'viewer', comment: 'comment' };
/** The entity a not-found must name to be the root's absence (core's NOT_FOUND_ENTITIES, plus the reconcile read). */
const NOT_FOUND_ENTITIES = { getIssue: 'Issue', listComments: 'Issue', addComment: 'Issue', comment: 'Comment' };
const entityNotFound = (entity, message) => new RegExp(`^Entity not found: ${entity}(?![A-Za-z])`).test(String(message));

function errorText(error) {
    const ext = record(record(error)?.extensions);
    return [ext?.code, ext?.type]
        .filter((v) => typeof v === 'string')
        .join(' ')
        .toLowerCase()
        .replace(/[^a-z ]/g, '')
        .replace(/ (?=found|limit)/g, '');
}

/** A well-formed `errors`: an array whose every element is an object with a string message (the core's rule). */
const wellFormedErrors = (errors) =>
    Array.isArray(errors) && errors.every((error) => typeof record(error)?.message === 'string');

/**
 * Core's `linearNotFound`: a well-formed error answer saying the operation's own root entity does not exist (the
 * message names it and any `path` starts at its field). Another entity's not-found or malformed `errors` is not.
 */
function notFound(op, json) {
    const entity = NOT_FOUND_ENTITIES[op];
    if (entity === undefined || !wholeAnswerError(op, json)) return false;
    return record(json).errors.some((error) => entityNotFound(entity, error.message));
}

/**
 * Core's `linearWholeAnswerError`: a well-formed error answer with no root data (data absent or null, or its root field
 * absent or null) whose every error path is absent or exactly the root field. Only it carries a definitive verdict.
 */
function wholeAnswerError(op, json) {
    const field = ROOT_FIELDS[op];
    const answer = record(json);
    const errors = answer?.errors;
    if (field === undefined || !wellFormedErrors(errors) || errors.length === 0) return false;
    if (answer.data !== undefined && answer.data !== null) {
        const data = record(answer.data);
        if (data === null || (data[field] !== undefined && data[field] !== null)) return false;
    }
    return errors.every((error) => error.path === undefined || (Array.isArray(error.path) && error.path.length === 1 && error.path[0] === field));
}

/**
 * Whether a refusal may say "nothing was applied": no body to read (a bare status), or an answer with no root data
 * and no error deeper than the root. Partial data, an unreadable error list or a deeper error wins over the verdict.
 */
function beforeApply(op, json) {
    if (json === null) return true;
    const answer = record(json);
    if (answer === null) return false;
    if (answer.errors === undefined) {
        const data = record(answer.data);
        return answer.data === undefined || answer.data === null || (data !== null && (data[ROOT_FIELDS[op]] ?? null) === null);
    }
    return wholeAnswerError(op, json);
}

/** A commentCreate answer whose data is a well-formed success with the sent id: posted, whatever errors ride beside it. */
function confirmedPost(json, request) {
    const created = record(record(record(json)?.data)?.commentCreate);
    const id = record(created?.comment)?.id;
    const sent = record(record(request.body?.variables)?.input)?.id;
    return created?.success === true && text(id) && id === sent;
}

/**
 * Whether a well-formed error answer to commentCreate refused its input before applying it: an INPUT_ERROR that is
 * not about the comment itself. The only GraphQL answer besides auth, forbidden and rate limits that says "not posted".
 */
function inputRefused(json) {
    const errors = record(json)?.errors;
    if (!wholeAnswerError('addComment', json)) return false;
    if (errors.some((error) => entityNotFound('Comment', error.message))) return false;
    return errors.some((error) => record(error.extensions)?.code === 'INPUT_ERROR');
}

/**
 * The named kind of an answer's errors (ERROR_KINDS), or null when it has none the core names. Error text is read only
 * from a well-formed `errors`: a malformed one is final and names nothing.
 */
function errorKind(json) {
    const errors = record(json)?.errors;
    if (!wellFormedErrors(errors) || errors.length === 0) return null;
    const texts = errors.map(errorText);
    return ERROR_KINDS.find((k) => texts.some((text) => k.match.test(text))) ?? null;
}

/** The core's `classifyLinearAnswer`: an outcome, or null where the answer is a value (2xx) or its status decides (4xx). */
function classify(json, op, status) {
    const answer = record(json);
    const errors = answer?.errors;
    const twoHundred = status >= HTTP_OK && status < HTTP_REDIRECT;
    const failed = (reason) =>
        op.effect === 'write' ? { outcome: 'outcome_unknown', operation: op.name } : { outcome: 'unavailable', reason, retryable: true };
    if (errors !== undefined && !wellFormedErrors(errors)) return twoHundred ? failed('malformed-response') : null;
    if (Array.isArray(errors) && errors.length > 0) {
        // A definitive kind needs a whole-answer error; beside partial data it is an upstream error.
        const kind = wholeAnswerError(op.name, json) ? errorKind(json) : null;
        if (kind) return { ...kind.outcome };
        if (notFound(op.name, json)) return { ...NOT_FOUND_OUTCOME };
        return twoHundred ? failed('upstream-error') : null;
    }
    return twoHundred && record(answer?.data) === null ? failed('malformed-response') : null;
}

// ---- The wall-clock deadline and the wire ----

const remaining = (ctx) => ctx.end - ctx.deps.now();

/** The wait before the next try; false when the deadline cannot cover it. */
async function pause(ctx, ms) {
    if (ms === null || ms >= remaining(ctx)) return false;
    await ctx.deps.sleep(ms);
    return true;
}

/** `Retry-After` in seconds as milliseconds, or null where absent or not a plain count. */
function retryAfterMs(headers) {
    const value = headers.get('retry-after');
    return value && /^\d{1,6}$/.test(value.trim()) ? Number(value) * MS_PER_SECOND : null;
}

async function readText(response) {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > BODY_CAP_BYTES) throw new Error('response too large');
            chunks.push(next.value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** One request within the deadline: {status, headers, json, malformed}, or a throw. */
async function wire(ctx, url, init) {
    const left = remaining(ctx);
    if (left <= 0) throw deadline();
    const response = await ctx.deps.fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, left))),
    });
    const text = await readText(response);
    let json = null;
    let malformed = false;
    if (text.trim() !== '') {
        try {
            json = JSON.parse(text);
        } catch {
            malformed = true;
        }
    }
    return { status: response.status, headers: response.headers, json, malformed };
}

// ---- The board: connection list and operation receipts ----

/**
 * A board request retried inside the deadline. `accept(res)` returns a value to stop, null to try again
 * (an answer that is not the one needed), or throws a Stop. A refusal of the pair is final.
 */
async function board(ctx, method, path, body, accept) {
    const { env } = ctx.deps;
    let backoff = BACKOFF_MS;
    while (remaining(ctx) > 0) {
        const pair = await ctx.deps.pair(env);
        if (!env.FACTORY_STATS_URL || !pair.jobId || !pair.leaseToken) {
            throw new Stop(EXIT_FAILED, 'unavailable', 'no_pair', 'linear: this container holds no attempt credential, so the board cannot be asked.');
        }
        const url = `${env.FACTORY_STATS_URL.replace(/\/+$/, '')}/api/jobs/${pair.jobId}${path}`;
        const headers = { 'x-factory-job-id': pair.jobId, 'x-factory-job-lease-token': pair.leaseToken, accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        let wait = backoff;
        try {
            const res = await wire(ctx, url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            if (res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN) throw refusedByBoard();
            if (res.status === HTTP_TOO_MANY) wait = retryAfterMs(res.headers) ?? backoff;
            else if (res.status < HTTP_SERVER_ERROR) {
                const value = accept(res);
                if (value !== null) return value;
            }
        } catch (error) {
            if (error instanceof Stop) throw error;
        }
        if (!(await pause(ctx, wait))) break;
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
    throw deadline();
}

function validEntry(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || typeof entry.provider !== 'string') return false;
    if (entry.provider !== 'linear') return true;
    if (!UUID.test(entry.id) || typeof entry.site !== 'string' || typeof entry.resource !== 'string') return false;
    if (typeof entry.access !== 'string' || typeof entry.apiBase !== 'string') return false;
    try {
        const url = new URL(entry.apiBase);
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname.endsWith(PATH_PREFIX);
    } catch {
        return false;
    }
}

/**
 * Tells the board this task needs a Linear connection it lacks (the ask rides the agent's control socket,
 * see connection-ask.cjs). 'bound' and 'absent' return; 'unavailable' and 'waiting' end the call at exit 3.
 * An answer the board did not confirm is retried inside the deadline and never read as either verdict.
 */
async function requireConnection(ctx, target) {
    let backoff = BACKOFF_MS;
    while (remaining(ctx) > 0) {
        const result = await ctx.deps.ask('linear', Math.max(1, Math.min(ASK_TIMEOUT_MS, remaining(ctx))), target);
        if (result.kind === 'absent') return 'absent';
        if (result.kind === 'refused') throw refusedByBoard();
        if (result.kind === 'answer') {
            if (result.answer === 'bound') return 'bound';
            if (result.answer === 'unavailable') {
                throw new Stop(
                    EXIT_INTEGRATION_REQUIRED,
                    'integration_required',
                    'connection_unavailable',
                    'linear: the user chose to continue without a Linear connection; continue without Linear and say so in your report.'
                );
            }
            throw new Stop(
                EXIT_INTEGRATION_REQUIRED,
                'integration_required',
                'waiting_for_connection',
                'linear: no Linear connection is bound to this task and the board is waiting for the user to connect one. Stop here: the task pauses at this point and resumes in this session once it is connected.'
            );
        }
        if (!(await pause(ctx, backoff))) break;
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
    throw deadline();
}

/**
 * The one Linear connection this call uses. Only a confirmed list may say "none": a list with any malformed entry is
 * unconfirmed and ends the call (never an ask), and a list that does not arrive retries until the deadline.
 */
async function connectionFor(ctx, workspace, asked = false) {
    const list = await board(ctx, 'GET', '/credentials/connections', undefined, (res) => {
        if (res.status !== HTTP_OK || !Array.isArray(res.json?.connections)) return null;
        if (!res.json.connections.every(validEntry)) {
            throw new Stop(EXIT_FAILED, 'unavailable', 'malformed', 'linear: the board listed a connection this helper cannot read; report it.');
        }
        return res.json.connections;
    });
    const linear = list.filter((entry) => entry.provider === 'linear');
    const wanted = workspace === undefined ? linear : linear.filter((entry) => entry.site.toLowerCase() === workspace.toLowerCase());
    if (wanted.length === 0 && !asked && (await requireConnection(ctx, workspace)) === 'bound') {
        return connectionFor(ctx, workspace, true);
    }
    if (wanted.length === 0) {
        const named = workspace === undefined ? '' : ` for ${workspace}`;
        throw new Stop(EXIT_INTEGRATION_REQUIRED, 'integration_required', 'no_connection', `linear: no Linear connection${named} is bound to this task; ask the user to connect Linear and bind it.`);
    }
    if (wanted.length > 1) throw bad('linear: several Linear connections are bound to this task; pass --workspace URLKEY to choose one.');
    return wanted[0];
}

const validReceipt = (receipt) =>
    receipt &&
    typeof receipt.id === 'string' &&
    UUID.test(receipt.id) &&
    STATUSES.includes(receipt.status) &&
    (receipt.dispatchedAt === null || receipt.dispatchedAt === undefined || typeof receipt.dispatchedAt === 'string') &&
    (receipt.result === null || receipt.result === undefined || UUID.test(String(receipt.result?.commentId)));

/** Begin the operation's durable receipt; any refusal ends the call before Linear is touched. */
function beginReceipt(ctx, conn, key, fingerprint) {
    const request = { connectionId: conn.id, provider: 'linear', operation: 'addComment', key, fingerprint };
    return board(ctx, 'POST', '/operations', request, (res) => {
        if (res.status === HTTP_OK && validReceipt(res.json?.receipt)) return res.json.receipt;
        if (res.status === HTTP_CONFLICT) {
            throw new Stop(EXIT_FAILED, 'refused', 'key_reused', 'linear: this operation key was already used for a different comment; pass another --key.');
        }
        if (res.status >= 400) throw new Stop(EXIT_FAILED, 'refused', 'receipt_refused', 'linear: the board would not record this comment.');
        return null;
    });
}

/** Move the receipt: {receipt} on success, {conflict:true, receipt} when another invocation moved it, {failed:true} when unrecorded. */
async function moveReceipt(ctx, receipt, from, to, result) {
    const body = { from, to, ...(result ? { result } : {}) };
    try {
        return await board(ctx, 'PUT', `/operations/${receipt.id}`, body, (res) => {
            if (res.status === HTTP_OK && validReceipt(res.json?.receipt)) return { receipt: res.json.receipt };
            if (res.status === HTTP_CONFLICT) return { conflict: true, receipt: validReceipt(res.json?.receipt) ? res.json.receipt : null };
            if (res.status >= 400) return { failed: true };
            return null;
        });
    } catch (error) {
        if (error instanceof Stop) return { failed: true };
        throw error;
    }
}

// ---- Linear ----

/** The token for `conn`, and the connection that issued it: after a reconnect, the one the board now lists for that workspace. */
async function credentialFor(ctx, first, required) {
    let conn = first;
    let result = await ctx.deps.credential(conn.id, Math.max(1, remaining(ctx)));
    if (!result.ok && result.reason === 'integration_required' && (await requireConnection(ctx, conn.site)) === 'bound') {
        conn = await connectionFor(ctx, conn.site, true);
        result = await ctx.deps.credential(conn.id, Math.max(1, remaining(ctx)));
    }
    if (!result.ok) {
        if (result.reason === 'integration_required') {
            throw new Stop(EXIT_INTEGRATION_REQUIRED, 'integration_required', 'connection', 'linear: the connection needs the user to connect or reconnect it.');
        }
        throw new Stop(EXIT_FAILED, 'unavailable', result.reason ?? 'credential', 'linear: the board did not issue a credential for this connection.');
    }
    // A credential that names no scopes confirms nothing about them: never read it as "lacks the scope".
    if (!Array.isArray(result.scopes)) {
        throw new Stop(EXIT_FAILED, 'unavailable', 'malformed', 'linear: the board issued a credential without its scopes; report it.');
    }
    const missing = required.filter((scope) => !result.scopes.includes(scope));
    if (missing.length > 0) {
        throw new Stop(
            EXIT_INTEGRATION_REQUIRED,
            'integration_required',
            'insufficient_scopes',
            `linear: the connection lacks ${missing.join(', ')}; ask the user to allow it.`,
            { missingScopes: missing }
        );
    }
    return { token: result.token, conn };
}

/**
 * One GraphQL request. Answers {kind:'ok', json} | {kind:'refused', reason} | {kind:'unauthorized'} |
 * {kind:'ambiguous'} (a write whose answer is not trustworthy) | {kind:'failed'} (a read with `once`).
 * The verdict on a JSON answer is `classify`'s (the core's): authentication erases the cached credential and re-asks
 * once, a rate limit backs off inside the deadline, a named not-found is `not-found`. A read retries 5xx, non-JSON
 * and transport errors inside the deadline; a write never retries them.
 */
async function linearSend(ctx, conn, op, request, options = {}) {
    const write = op === 'addComment';
    let reauthed = false;
    let live = conn;
    let backoff = BACKOFF_MS;
    for (;;) {
        const issued = await credentialFor(ctx, live, REQUIRED_SCOPES[op]);
        live = issued.conn;
        let wait = backoff;
        try {
            const res = await wire(ctx, live.apiBase, {
                method: 'POST',
                headers: { authorization: `Bearer ${issued.token}`, accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify(request.body),
            });
            const verdict =
                res.status === HTTP_UNAUTHORIZED
                    ? { outcome: 'unavailable', reason: 'credential-rejected' }
                    : res.status < HTTP_SERVER_ERROR && res.status !== HTTP_TOO_MANY && !res.malformed
                      ? classify(res.json, { name: op, effect: write ? 'write' : 'read' }, res.status)
                      : null;
            const json = res.malformed ? null : res.json;
            // Partial data wins over a definitive verdict: a write is then reconciled, a read is an upstream error.
            const notDefinitive = write ? { kind: 'ambiguous' } : { kind: 'refused', reason: 'upstream-error', unavailable: true };
            if (write && !res.malformed && res.status < HTTP_SERVER_ERROR && confirmedPost(res.json, request)) {
                return { kind: 'ok', json: res.json };
            }
            const definite = beforeApply(op, json);
            if (verdict?.reason === 'credential-rejected') {
                if (!definite) return notDefinitive;
                if (reauthed) return { kind: 'unauthorized' };
                reauthed = true;
                ctx.deps.eraseCredential(live.id);
                continue;
            }
            if (res.status >= HTTP_REDIRECT && res.status < 400) {
                throw new Stop(EXIT_FAILED, 'unavailable', 'redirect', 'linear: Linear answered with a redirect; nothing was followed.');
            }
            if (res.status === HTTP_TOO_MANY || verdict?.outcome === 'rate_limited') {
                if (!definite) return notDefinitive;
                wait = retryAfterMs(res.headers) ?? backoff;
            } else if (res.status === HTTP_FORBIDDEN || verdict?.outcome === 'forbidden') {
                if (!definite) return notDefinitive;
                return { kind: 'refused', reason: 'provider-denied' };
            } else if (write) {
                // "Nothing was posted" only on a definite refusal before applying (auth, forbidden, rate limit above, or an
                // input error); a 5xx, an unreadable body, malformed errors or an unexpected shape may have posted it.
                if (!res.malformed && res.status < HTTP_SERVER_ERROR && inputRefused(res.json)) {
                    return { kind: 'refused', reason: notFound(op, res.json) ? 'not-found' : 'bad-request' };
                }
                const answered = res.status < 400 && !res.malformed && verdict === null && answerShape(op, res.json, request);
                return answered ? { kind: 'ok', json: res.json } : { kind: 'ambiguous' };
            } else if (res.status >= HTTP_SERVER_ERROR || (res.malformed && res.status < 400)) {
                // No trustworthy answer: a read tries again.
            } else if (res.malformed) {
                return { kind: 'refused', reason: 'malformed', unavailable: true };
            } else if (verdict?.reason === 'malformed-response') {
                // A malformed verdict is final: no error text in that answer is read.
                return { kind: 'refused', reason: 'malformed', unavailable: true };
            } else if (notFound(op, res.json)) {
                return { kind: 'refused', reason: 'not-found', json: res.json };
            } else if (verdict !== null) {
                return { kind: 'refused', reason: verdict.reason, unavailable: true };
            } else if (res.status >= 400) {
                const errors = record(res.json)?.errors;
                if (errors !== undefined && !wellFormedErrors(errors)) return { kind: 'refused', reason: 'malformed', unavailable: true };
                // A 4xx no rule names (another entity's not-found among them) is core's status outcome, never a verdict.
                return { kind: 'refused', reason: 'unexpected-status', unavailable: true };
            } else if (!answerShape(op, res.json, request)) {
                // A 2xx of the wrong shape confirms nothing.
                return { kind: 'refused', reason: 'malformed', unavailable: true };
            } else {
                return { kind: 'ok', json: res.json };
            }
        } catch (error) {
            if (error instanceof Stop) throw error;
            if (write) return { kind: 'ambiguous' };
        }
        if (options.once && !write) return { kind: 'failed' };
        if (!(await pause(ctx, wait))) throw deadline();
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
}

/** A read that must succeed: any other answer ends the call with its closed reason. */
async function readLinear(ctx, conn, op, request) {
    const answer = await linearSend(ctx, conn, op, request);
    if (answer.kind === 'ok') return answer.json;
    if (answer.kind === 'unauthorized') {
        throw new Stop(EXIT_FAILED, 'refused', 'credential_rejected', 'linear: credential rejected by Linear after a fresh one was issued; report it.');
    }
    if (answer.reason === 'not-found') {
        throw new Stop(EXIT_FAILED, 'refused', 'not-found', 'linear: Linear says the issue does not exist or this connection cannot see it. Report it.');
    }
    if (answer.reason === 'malformed') {
        throw new Stop(EXIT_FAILED, 'unavailable', 'malformed', 'linear: Linear answered in a shape this helper cannot read; nothing is concluded from it. Retry the step shortly, then report it.');
    }
    throw new Stop(
        EXIT_FAILED,
        answer.unavailable ? 'unavailable' : 'refused',
        answer.reason,
        `linear: Linear refused the request (${answer.reason}). Report it; do not work around it.`
    );
}

async function collect(ctx, conn, op, input) {
    const { path, maxPages, maxItems } = PAGES[op];
    let request = requestFor(op, input);
    const items = [];
    for (let page = 0; page < maxPages; page++) {
        const json = await readLinear(ctx, conn, op, request);
        let next;
        try {
            items.push(...connectionAt(json, path).nodes);
            next = nextRequest(op, json, request);
        } catch {
            throw new Stop(EXIT_FAILED, 'unavailable', 'malformed', 'linear: Linear answered with a page this helper cannot read.');
        }
        if (items.length > maxItems) return { items: items.slice(0, maxItems), truncated: true };
        if (next === null) return { items, truncated: false };
        if (items.length === maxItems) return { items, truncated: true };
        request = next;
    }
    return { items, truncated: true };
}

// ---- add-comment ----

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Whether the comment with the receipt's id exists, by the read-only `comment(id:)` query. 'found': the comment with
 * that id, on that issue. 'absent' (licenses one re-send with the same id) only on Linear's explicit
 * "Entity not found: Comment" error. Everything else is null, inconclusive: a failed or timed-out read, `comment: null`
 * without an error, a missing `data`, another entity's not-found, or the id on another issue.
 */
async function reconcile(ctx, conn, issue, receiptId) {
    try {
        const answer = await linearSend(ctx, conn, 'comment', graphql(COMMENT_BY_ID, { id: receiptId }), { once: true });
        // `not-found` for the `comment` read is only ever about the comment itself (NOT_FOUND_ROOTS.comment).
        if (answer.kind === 'refused' && answer.reason === 'not-found') return 'absent';
        if (answer.kind !== 'ok') return null;
        const found = record(record(answer.json?.data)?.comment);
        if (found?.id !== receiptId) return null;
        const on = record(found.issue);
        return on?.identifier === issue || on?.id === issue ? 'found' : null;
    } catch (error) {
        if (error instanceof Stop) throw error;
        return null;
    }
}

const done = (ctx, commentId) => ctx.deps.stdout(`${JSON.stringify({ commentId })}\n`);

/** The receipt's last word: recorded where possible, printed regardless. */
async function succeed(ctx, receipt) {
    await moveReceipt(ctx, receipt, ['dispatched', 'unknown'], 'succeeded', { commentId: receipt.id });
    done(ctx, receipt.id);
    return EXIT_OK;
}

const unknown = () =>
    new Stop(
        EXIT_UNKNOWN,
        'outcome_unknown',
        'unknown',
        'linear: whether the comment was posted is unknown. Run the same command again later: it checks before it posts, and never posts twice.'
    );

/** One commentCreate carrying the receipt's id; the answer decides, an ambiguous one is reconciled. */
async function post(ctx, conn, receipt, issue, body, resent) {
    const request = requestFor('addComment', { key: issue, body, receiptId: receipt.id });
    // A Stop past this point (deadline, broker) leaves the receipt dispatched; the next call reconciles it.
    const answer = await linearSend(ctx, conn, 'addComment', request);
    if (answer.kind === 'ok') {
        const created = record(record(answer.json?.data)?.commentCreate);
        if (created?.success === true && record(created.comment)?.id === receipt.id) return succeed(ctx, receipt);
        return settle(ctx, conn, receipt, issue, body, resent);
    }
    if (answer.kind === 'ambiguous') return settle(ctx, conn, receipt, issue, body, resent);
    await moveReceipt(ctx, receipt, ['dispatched'], 'failed');
    if (answer.kind === 'unauthorized') {
        throw new Stop(EXIT_FAILED, 'refused', 'credential_rejected', 'linear: credential rejected by Linear after a fresh one was issued; nothing was posted. Report it.');
    }
    throw new Stop(EXIT_FAILED, 'refused', answer.reason, `linear: Linear refused the comment (${answer.reason}); nothing was posted. Report it.`);
}

/**
 * Reconcile a possibly-posted comment: found is success; Linear's explicit not-found re-sends once with the same id
 * (the id is the dedupe); anything else is unknown, and the receipt says so.
 */
async function settle(ctx, conn, receipt, issue, body, resent = false) {
    const seen = await reconcile(ctx, conn, issue, receipt.id);
    if (seen === 'found') return succeed(ctx, receipt);
    if (seen === 'absent' && !resent) return post(ctx, conn, receipt, issue, body, true);
    if (receipt.status !== 'unknown') await moveReceipt(ctx, receipt, ['dispatched'], 'unknown');
    throw unknown();
}

async function addComment(ctx, bound, issue, body, explicitKey) {
    try {
        issueRef(issue);
    } catch {
        throw bad('linear: that is not an issue key.');
    }
    if (body === '') throw bad('linear: the comment body is empty.');
    if (explicitKey !== undefined && !OPERATION_KEY.test(explicitKey)) throw bad('linear: --key is 1-128 characters of A-Z a-z 0-9 . _ : -.');
    const { conn } = await credentialFor(ctx, bound, REQUIRED_SCOPES.addComment);
    const operationKey = explicitKey ?? sha256(`${conn.id}|${issue}|${body}`);
    const receipt = await beginReceipt(ctx, conn, operationKey, sha256(`${issue}|${body}`));
    // A stored success confirms the comment only when its result is the receipt's own id (the comment's id); any other
    // succeeded receipt is checked against Linear, never printed from the board alone.
    if (receipt.status === 'succeeded' && receipt.result?.commentId === receipt.id) {
        done(ctx, receipt.id);
        return EXIT_OK;
    }
    if (receipt.status === 'succeeded') return settle(ctx, conn, receipt, issue, body);
    if (receipt.status === 'failed') {
        throw new Stop(EXIT_FAILED, 'refused', 'failed_before', 'linear: this comment was refused earlier and nothing was posted; fix the cause and pass another --key to try again.');
    }
    if (receipt.status !== 'started') return settle(ctx, conn, receipt, issue, body);

    const moved = await moveReceipt(ctx, receipt, ['started'], 'dispatched');
    if (moved.conflict) {
        throw new Stop(EXIT_UNKNOWN, 'in_progress', 'in_progress', 'linear: another invocation holds this comment; it is in progress and is not posted twice.');
    }
    if (moved.failed) throw new Stop(EXIT_FAILED, 'unavailable', 'receipt_unrecorded', 'linear: the board did not record the comment as started; nothing was posted.');
    return post(ctx, conn, moved.receipt, issue, body, false);
}

// ---- The command line ----

const SEARCH_FLAGS = ['team', 'state', 'assignee', 'label', 'project', 'text'];
const USAGE =
    'usage: linear.cjs issue KEY | search [--team KEY] [--state NAME] [--assignee me|EMAIL] [--label NAME] [--project NAME] [--text TEXT] (at least one) | comments KEY | comment KEY (--body-file PATH | --body TEXT) [--key K]   (each: [--workspace URLKEY])';
const FLAGS = {
    issue: ['workspace'],
    search: [...SEARCH_FLAGS, 'workspace'],
    comments: ['workspace'],
    comment: ['body-file', 'body', 'key', 'workspace'],
};

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const allowed = FLAGS[command];
    if (!allowed) throw bad(USAGE);
    const positional = [];
    const flags = {};
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const name = arg.slice(2);
        if (!allowed.includes(name) || rest[i + 1] === undefined) throw bad(USAGE);
        flags[name] = rest[++i];
    }
    if (positional.length !== (command === 'search' ? 0 : 1)) throw bad(USAGE);
    return { command, target: positional[0], flags };
}

function bodyOf(ctx, flags) {
    if ((flags.body === undefined) === (flags['body-file'] === undefined)) throw bad('linear: pass exactly one of --body-file and --body.');
    if (flags.body !== undefined) return flags.body;
    try {
        return ctx.deps.readFile(flags['body-file']);
    } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw bad(`linear: no such file: ${flags['body-file']}`);
        throw bad(`linear: ${flags['body-file']} is unreadable (${error?.code ?? 'error'}).`);
    }
}

async function execute(ctx, argv) {
    const { command, target, flags } = parseArgs(argv);
    const body = command === 'comment' ? bodyOf(ctx, flags) : undefined;
    const search = Object.fromEntries(SEARCH_FLAGS.filter((name) => flags[name] !== undefined).map((name) => [name, flags[name]]));
    const request = (op, input, message) => {
        try {
            return requestFor(op, input);
        } catch {
            throw bad(message);
        }
    };
    // Bad input ends the call before the board is asked.
    if (command === 'issue') request('getIssue', { key: target }, 'linear: that is not an issue key.');
    if (command === 'comments') request('listComments', { key: target }, 'linear: that is not an issue key.');
    if (command === 'search') request('searchIssues', search, 'linear: search needs at least one of --team, --state, --assignee, --label, --project, --text.');
    const conn = await connectionFor(ctx, flags.workspace);
    if (command === 'issue') {
        const json = await readLinear(ctx, conn, 'getIssue', requestFor('getIssue', { key: target }));
        // The shape check already held: data.issue is a well-formed issue.
        ctx.deps.stdout(`${JSON.stringify(json.data.issue)}\n`);
    } else if (command === 'search') {
        const { items, truncated } = await collect(ctx, conn, 'searchIssues', search);
        ctx.deps.stdout(`${JSON.stringify({ issues: items, truncated })}\n`);
    } else if (command === 'comments') {
        const { items, truncated } = await collect(ctx, conn, 'listComments', { key: target });
        ctx.deps.stdout(`${JSON.stringify({ comments: items, truncated })}\n`);
    } else {
        return addComment(ctx, conn, target, body, flags.key);
    }
    return EXIT_OK;
}

/** Runs one command; every exit prints its closed outcome on stdout and its guidance on stderr, never a token. */
async function run(argv, deps) {
    const ctx = { deps, end: deps.now() + deps.deadlineMs };
    try {
        return await execute(ctx, argv);
    } catch (error) {
        if (!(error instanceof Stop)) {
            deps.stderr('linear: unexpected failure.\n');
            deps.stdout(`${JSON.stringify({ outcome: 'unavailable', reason: 'internal' })}\n`);
            return EXIT_FAILED;
        }
        deps.stdout(`${JSON.stringify({ outcome: error.outcome, reason: error.reason, ...error.extra })}\n`);
        deps.stderr(`${error.message}\n`);
        return error.code;
    }
}

/** The real process's dependencies; the broker, the pair helper and the connection ask are baked at fixed paths in both images. */
function defaultDeps(env = process.env) {
    const broker = require('/usr/local/bin/credential-broker.cjs');
    const { currentPair } = require('/usr/local/bin/attempt-pair.cjs');
    return {
        env,
        now: Date.now,
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        pair: currentPair,
        ask: (provider, remainingMs, target) =>
            require('/usr/local/bin/connection-ask.cjs').askConnection(provider, { deadlineMs: remainingMs, ...(target === undefined ? {} : { target }) }),
        credential: (id, remainingMs) => broker.connectionCredential(id, { ...broker.defaultDeps(env), deadlineMs: remainingMs }),
        eraseCredential: (id) => broker.erase(broker.defaultDeps(env), broker.connectionKey(id)),
        readFile: (path) => fs.readFileSync(path, 'utf8'),
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        deadlineMs: DEADLINE_MS,
    };
}

if (require.main === module) {
    run(process.argv.slice(2), defaultDeps()).then((code) => {
        process.exitCode = code;
    });
}

module.exports = { run, requestFor, nextRequest, classify, answerShape, notFound, defaultDeps, REQUIRED_SCOPES };
