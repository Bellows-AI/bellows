#!/usr/bin/env node
'use strict';
/*
 * The runner's Jira helper (docs/connections.md): issue, search, comments and add-comment against the
 * task's managed Jira connection. The board lists the connections bound to this task and issues a
 * token through the credential broker; this talks to Atlassian directly. No command prints a token,
 * and a token reaches nothing but the Authorization header of a request to the connection's API origin.
 *
 * Requests mirror core/src/integrations/jira.ts (server/test/jira-helper-parity.test.ts pins the
 * paths, bodies and next pages). Like core, a request path is the full `/ex/jira/{cloud}/rest/api/3/...`
 * path and is resolved against the API ORIGIN only, never appended to the connection's apiBase.
 *
 * One wall-clock deadline covers every board and Jira request, retry and wait of a call. Exit codes:
 * 0 ok; 1 refused, bad input or unreachable past the deadline; 3 the user must connect or widen the
 * connection; 4 the add-comment outcome is unknown or in flight (never replayed).
 */
const crypto = require('node:crypto');
const fs = require('node:fs');

const PATH_PREFIX = '/ex/jira';
const DEADLINE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const BACKOFF_MS = 250;
const BACKOFF_MAX_MS = 2000;
const BODY_CAP_BYTES = 8 * 1024 * 1024;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INTEGRATION_REQUIRED = 3;
const EXIT_UNKNOWN = 4;
const MS_PER_SECOND = 1000;
const RECONCILE_PAGE = 50;
const RECONCILE_PAGES = 2;
const RECONCILE_SKEW_MS = 5 * 60 * 1000;
const OPERATION_PROPERTY = 'bellows-operation';
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-[1-9][0-9]*$/;
const OPERATION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMENT_ID = /^\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['started', 'dispatched', 'succeeded', 'failed', 'unknown'];
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_REDIRECT = 300;

const REQUIRED_SCOPES = {
    getIssue: ['read:jira-work'],
    searchIssues: ['read:jira-work'],
    listComments: ['read:jira-work'],
    addComment: ['write:jira-work'],
    myself: ['read:jira-user'],
};
const PAGES = {
    searchIssues: { field: 'issues', maxPages: 10, maxItems: 200 },
    listComments: { field: 'comments', maxPages: 10, maxItems: 1000 },
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
const deadline = () => new Stop(EXIT_FAILED, 'unavailable', 'deadline', 'jira: the call ran past its deadline; retry the step shortly.');

// ---- Requests: the core's operations, restated (the parity test is the enforcement) ----

const base = (cloudId) => `${PATH_PREFIX}/${encodeURIComponent(cloudId)}/rest/api/3`;
const issueKey = (key) => {
    if (typeof key !== 'string' || !ISSUE_KEY.test(key)) throw new Error('not a Jira issue key');
    return key;
};
const withQuery = (path, params) => (params.toString() === '' ? path : `${path}?${params.toString()}`);
const withParam = (previousPath, name, value) => {
    const url = new URL(previousPath, 'http://placeholder.invalid');
    url.searchParams.set(name, value);
    return `${url.pathname}${url.search}`;
};
const arrayOf = (json, field) => {
    const value = json?.[field];
    if (!Array.isArray(value)) throw new Error(`no ${field} array`);
    return value;
};
const adf = (text) => ({
    type: 'doc',
    version: 1,
    content: text.split('\n').map((line) => (line === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: line }] })),
});

/** The request of one operation for one site: method, the full path under /ex/jira, and a body. */
function requestFor(op, input, cloudId) {
    switch (op) {
        case 'getIssue': {
            const params = new URLSearchParams();
            if (input.fields && input.fields.length > 0) params.set('fields', input.fields.join(','));
            return { method: 'GET', path: withQuery(`${base(cloudId)}/issue/${issueKey(input.key)}`, params) };
        }
        case 'searchIssues': {
            const params = new URLSearchParams({ jql: input.jql });
            if (input.fields && input.fields.length > 0) params.set('fields', input.fields.join(','));
            const size = Math.min(Math.max(Math.floor(input.maxResults ?? 50), 1), 100);
            params.set('maxResults', String(size));
            return { method: 'GET', path: withQuery(`${base(cloudId)}/search/jql`, params) };
        }
        case 'listComments':
            return {
                method: 'GET',
                path: `${base(cloudId)}/issue/${issueKey(input.key)}/comment?startAt=0&maxResults=100&orderBy=created`,
            };
        case 'addComment':
            if (input.body === '' || input.operationKey === '') throw new Error('a comment needs a body and a key');
            return {
                method: 'POST',
                path: `${base(cloudId)}/issue/${issueKey(input.key)}/comment`,
                body: {
                    body: adf(input.body),
                    properties: [{ key: OPERATION_PROPERTY, value: { key: input.operationKey } }],
                },
            };
        case 'myself':
            return { method: 'GET', path: `${base(cloudId)}/myself` };
        default:
            throw new Error(`unknown operation ${op}`);
    }
}

/** The path of the page after the one just read, or null (the core's pagination, restated). */
function nextPath(op, json, previousPath) {
    if (op === 'searchIssues') {
        if (json.isLast === true || typeof json.nextPageToken !== 'string' || json.nextPageToken === '') return null;
        return withParam(previousPath, 'nextPageToken', json.nextPageToken);
    }
    const comments = arrayOf(json, 'comments');
    const startAt = Number(new URL(previousPath, 'http://placeholder.invalid').searchParams.get('startAt'));
    if (typeof json.total !== 'number' || !Number.isInteger(startAt) || comments.length === 0) return null;
    const following = startAt + comments.length;
    return following < json.total ? withParam(previousPath, 'startAt', String(following)) : null;
}

// ---- The wall-clock deadline and the wire ----

const remaining = (ctx) => ctx.end - ctx.deps.now();

/** The wait before the next try; null when the deadline cannot cover it. */
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

/** One request within the deadline: {status, headers, json} (json is null where the body is empty or not JSON), or a throw. */
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
            throw new Stop(EXIT_FAILED, 'unavailable', 'no_pair', 'jira: this container holds no attempt credential, so the board cannot be asked.');
        }
        const url = `${env.FACTORY_STATS_URL.replace(/\/+$/, '')}/api/jobs/${pair.jobId}${path}`;
        const headers = { 'x-factory-job-id': pair.jobId, 'x-factory-job-lease-token': pair.leaseToken, accept: 'application/json' };
        if (body !== undefined) headers['content-type'] = 'application/json';
        let wait = backoff;
        try {
            const res = await wire(ctx, url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            if (res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN) {
                throw new Stop(
                    EXIT_FAILED,
                    'refused',
                    'board_refused',
                    'jira: the board refused this attempt: it holds a lease it no longer holds, or its task is no longer authorized. Each call reads the current pair: retry once, and if a fresh call is refused the same way, report it.'
                );
            }
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
    if (entry.provider !== 'jira') return true;
    if (!UUID.test(entry.id) || typeof entry.site !== 'string' || typeof entry.resource !== 'string') return false;
    if (typeof entry.access !== 'string' || typeof entry.apiBase !== 'string') return false;
    try {
        const url = new URL(entry.apiBase);
        return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname === base(entry.resource);
    } catch {
        return false;
    }
}

/** The one Jira connection this call uses. Only a confirmed list may say "none"; anything else retries. */
async function connectionFor(ctx, site) {
    const list = await board(ctx, 'GET', '/credentials/connections', undefined, (res) =>
        res.status === 200 && Array.isArray(res.json?.connections) && res.json.connections.every(validEntry) ? res.json.connections : null
    );
    const jira = list.filter((entry) => entry.provider === 'jira');
    const wanted = site === undefined ? jira : jira.filter((entry) => entry.site.toLowerCase() === site.toLowerCase());
    if (wanted.length === 0) {
        const named = site === undefined ? '' : ` for ${site}`;
        throw new Stop(EXIT_INTEGRATION_REQUIRED, 'integration_required', 'no_connection', `jira: no Jira connection${named} is bound to this task; ask the user to connect Jira and bind it.`);
    }
    if (wanted.length > 1) throw bad('jira: several Jira connections are bound to this task; pass --site HOST to choose one.');
    return wanted[0];
}

const validReceipt = (receipt) =>
    receipt &&
    typeof receipt.id === 'string' &&
    UUID.test(receipt.id) &&
    STATUSES.includes(receipt.status) &&
    (receipt.dispatchedAt === null || receipt.dispatchedAt === undefined || typeof receipt.dispatchedAt === 'string') &&
    (receipt.result === null || receipt.result === undefined || COMMENT_ID.test(String(receipt.result?.commentId)));

/** Begin the operation's durable receipt; any refusal ends the call before Jira is touched. */
function beginReceipt(ctx, conn, key, fingerprint) {
    const request = { connectionId: conn.id, provider: 'jira', operation: 'addComment', key, fingerprint };
    return board(ctx, 'POST', '/operations', request, (res) => {
        if (res.status === 200 && validReceipt(res.json?.receipt)) return res.json.receipt;
        if (res.status === HTTP_CONFLICT) {
            throw new Stop(EXIT_FAILED, 'refused', 'key_reused', 'jira: this operation key was already used for a different comment; pass another --key.');
        }
        if (res.status >= 400) throw new Stop(EXIT_FAILED, 'refused', 'receipt_refused', 'jira: the board would not record this comment.');
        return null;
    });
}

/** Move the receipt: {receipt} on success, {conflict:true, receipt} when another invocation moved it, {failed:true} when unrecorded. */
async function moveReceipt(ctx, receipt, from, to, result) {
    const body = { from, to, ...(result ? { result } : {}) };
    try {
        return await board(ctx, 'PUT', `/operations/${receipt.id}`, body, (res) => {
            if (res.status === 200 && validReceipt(res.json?.receipt)) return { receipt: res.json.receipt };
            if (res.status === HTTP_CONFLICT) return { conflict: true, receipt: validReceipt(res.json?.receipt) ? res.json.receipt : null };
            if (res.status >= 400) return { failed: true };
            return null;
        });
    } catch (error) {
        if (error instanceof Stop) return { failed: true };
        throw error;
    }
}

// ---- Jira ----

/** Where a request path goes: the connection's API origin, and only under that site's prefix. */
function urlFor(conn, path) {
    const origin = new URL(conn.apiBase).origin;
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith(`${base(conn.resource)}/`)) throw bad('jira: that request is outside the connection.');
    return url;
}

async function credentialFor(ctx, conn, required) {
    const result = await ctx.deps.credential(conn.id, Math.max(1, remaining(ctx)));
    if (!result.ok) {
        if (result.reason === 'integration_required') {
            throw new Stop(EXIT_INTEGRATION_REQUIRED, 'integration_required', 'connection', 'jira: the connection needs the user to connect or reconnect it.');
        }
        throw new Stop(EXIT_FAILED, 'unavailable', result.reason ?? 'credential', 'jira: the board did not issue a credential for this connection.');
    }
    const missing = required.filter((scope) => !(result.scopes ?? []).includes(scope));
    if (missing.length > 0) {
        throw new Stop(
            EXIT_INTEGRATION_REQUIRED,
            'integration_required',
            'insufficient_scopes',
            `jira: the connection lacks ${missing.join(', ')}; ask the user to allow it.`,
            { missingScopes: missing }
        );
    }
    return result.token;
}

/**
 * One Jira request. Answers {kind:'ok', json} | {kind:'refused', reason} | {kind:'unauthorized'} |
 * {kind:'ambiguous'} (a write whose answer is not trustworthy) | {kind:'failed'} (a read with `once`).
 * A 401 erases the cached credential and re-asks once; 429 honours Retry-After; a read retries 5xx and
 * transport errors inside the deadline, a write never retries them.
 */
async function jiraSend(ctx, conn, op, request, options = {}) {
    const write = request.method !== 'GET';
    let reauthed = false;
    let backoff = BACKOFF_MS;
    for (;;) {
        const token = await credentialFor(ctx, conn, REQUIRED_SCOPES[op]);
        let wait = backoff;
        try {
            const res = await wire(ctx, urlFor(conn, request.path), {
                method: request.method,
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: 'application/json',
                    ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
            });
            if (res.status === HTTP_UNAUTHORIZED) {
                if (reauthed) return { kind: 'unauthorized' };
                reauthed = true;
                ctx.deps.eraseCredential(conn.id);
                continue;
            }
            if (res.status >= HTTP_REDIRECT && res.status < 400) {
                throw new Stop(EXIT_FAILED, 'unavailable', 'redirect', 'jira: Jira answered with a redirect; nothing was followed.');
            }
            if (res.status === HTTP_TOO_MANY) {
                wait = retryAfterMs(res.headers) ?? backoff;
            } else if (res.status < HTTP_SERVER_ERROR) {
                if (res.status === HTTP_FORBIDDEN) return { kind: 'refused', reason: 'provider-denied' };
                if (res.status === HTTP_NOT_FOUND) return { kind: 'refused', reason: 'not-found' };
                if (res.status >= 400) return { kind: 'refused', reason: 'bad-request' };
                if (!res.malformed) return { kind: 'ok', json: res.json };
                if (write) return { kind: 'ambiguous' };
            } else if (write) {
                return { kind: 'ambiguous' };
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
async function readJira(ctx, conn, op, request) {
    const answer = await jiraSend(ctx, conn, op, request);
    if (answer.kind === 'ok') return answer.json;
    if (answer.kind === 'unauthorized') {
        throw new Stop(EXIT_FAILED, 'refused', 'credential_rejected', 'jira: credential rejected by Jira after a fresh one was issued; report it.');
    }
    throw new Stop(
        EXIT_FAILED,
        'refused',
        answer.reason,
        answer.reason === 'not-found'
            ? 'jira: Jira answered 404: the issue does not exist or this connection cannot see it. Report it.'
            : `jira: Jira refused the request (${answer.reason}). Report it; do not work around it.`
    );
}

async function collect(ctx, conn, op, input) {
    const { field, maxPages, maxItems } = PAGES[op];
    let request = requestFor(op, input, conn.resource);
    const items = [];
    for (let page = 0; page < maxPages; page++) {
        const json = await readJira(ctx, conn, op, request);
        let next;
        try {
            items.push(...arrayOf(json, field));
            next = nextPath(op, json, request.path);
        } catch {
            throw new Stop(EXIT_FAILED, 'unavailable', 'malformed', 'jira: Jira answered with a page this helper cannot read.');
        }
        if (items.length > maxItems) return { items: items.slice(0, maxItems), truncated: true };
        if (next === null) return { items, truncated: false };
        if (items.length === maxItems) return { items, truncated: true };
        request = { method: 'GET', path: next };
    }
    return { items, truncated: true };
}

// ---- add-comment ----

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const safeDate = (text) => Date.parse(String(text).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));

/**
 * The comment this operation made, by its `bellows-operation` property only: its id, or null for "not
 * found" and for every read that failed or was malformed. No author, body or time match ever stands in.
 */
async function reconcile(ctx, conn, issue, operationKey, dispatchedAt) {
    try {
        const me = await jiraSend(ctx, conn, 'myself', requestFor('myself', {}, conn.resource), { once: true });
        if (me.kind !== 'ok' || typeof me.json?.accountId !== 'string') return null;
        const since = dispatchedAt ? safeDate(dispatchedAt) - RECONCILE_SKEW_MS : Number.NEGATIVE_INFINITY;
        if (Number.isNaN(since)) return null;
        for (let page = 0; page < RECONCILE_PAGES; page++) {
            const path = `${base(conn.resource)}/issue/${issueKey(issue)}/comment?startAt=${page * RECONCILE_PAGE}&maxResults=${RECONCILE_PAGE}&orderBy=-created`;
            const answer = await jiraSend(ctx, conn, 'listComments', { method: 'GET', path }, { once: true });
            if (answer.kind !== 'ok') return null;
            const comments = arrayOf(answer.json, 'comments');
            for (const comment of comments) {
                const created = safeDate(comment?.created);
                if (Number.isNaN(created) || typeof comment?.id !== 'string' || !COMMENT_ID.test(comment.id)) return null;
                if (created < since) return null;
                if (comment.author?.accountId !== me.json.accountId) continue;
                const property = await jiraSend(ctx, conn, 'listComments', { method: 'GET', path: `${base(conn.resource)}/comment/${comment.id}/properties/${OPERATION_PROPERTY}` }, { once: true });
                if (property.kind === 'refused' && property.reason === 'not-found') continue;
                if (property.kind !== 'ok') return null;
                if (property.json?.value?.key === operationKey) return comment.id;
            }
            if (comments.length < RECONCILE_PAGE) return null;
        }
        return null;
    } catch {
        return null;
    }
}

const done = (ctx, commentId) => ctx.deps.stdout(`${JSON.stringify({ commentId })}\n`);

/** The receipt's last word on a comment found by reconcile or posted: recorded where possible, printed regardless. */
async function succeed(ctx, receipt, commentId) {
    await moveReceipt(ctx, receipt, ['dispatched', 'unknown'], 'succeeded', { commentId });
    done(ctx, commentId);
    return EXIT_OK;
}

/** Reconcile a possibly-written comment; found is success, anything else is unknown and is never replayed. */
async function settle(ctx, conn, receipt, issue, operationKey, dispatchedAt) {
    const found = await reconcile(ctx, conn, issue, operationKey, dispatchedAt);
    if (found !== null) return succeed(ctx, receipt, found);
    if (receipt.status !== 'unknown') await moveReceipt(ctx, receipt, ['dispatched'], 'unknown');
    throw new Stop(
        EXIT_UNKNOWN,
        'outcome_unknown',
        'unknown',
        'jira: whether the comment was posted is unknown. It is not posted again; check the issue before any retry with another --key.'
    );
}

async function addComment(ctx, conn, issue, body, explicitKey) {
    try {
        issueKey(issue);
    } catch {
        throw bad('jira: that is not an issue key.');
    }
    if (body === '') throw bad('jira: the comment body is empty.');
    if (explicitKey !== undefined && !OPERATION_KEY.test(explicitKey)) throw bad('jira: --key is 1-128 characters of A-Z a-z 0-9 . _ : -.');
    await credentialFor(ctx, conn, REQUIRED_SCOPES.addComment);
    const operationKey = explicitKey ?? sha256(`${conn.id}|${issue}|${body}`);
    const receipt = await beginReceipt(ctx, conn, operationKey, sha256(`${issue}|${body}`));
    if (receipt.status === 'succeeded') {
        if (!receipt.result) throw new Stop(EXIT_FAILED, 'unavailable', 'malformed', 'jira: the board holds a succeeded receipt without a comment id.');
        done(ctx, receipt.result.commentId);
        return EXIT_OK;
    }
    if (receipt.status === 'failed') {
        throw new Stop(EXIT_FAILED, 'refused', 'failed_before', 'jira: this comment was refused earlier and nothing was posted; fix the cause and pass another --key to try again.');
    }
    if (receipt.status !== 'started') return settle(ctx, conn, receipt, issue, operationKey, receipt.dispatchedAt ?? null);

    const moved = await moveReceipt(ctx, receipt, ['started'], 'dispatched');
    if (moved.conflict) {
        throw new Stop(EXIT_UNKNOWN, 'in_progress', 'in_progress', 'jira: another invocation holds this comment; it is in progress and is not posted twice.');
    }
    if (moved.failed) throw new Stop(EXIT_FAILED, 'unavailable', 'receipt_unrecorded', 'jira: the board did not record the comment as started; nothing was posted.');
    const dispatched = moved.receipt;

    const request = requestFor('addComment', { key: issue, body, operationKey }, conn.resource);
    // A Stop past this point (deadline, broker) leaves the receipt dispatched; the next call reconciles it.
    const answer = await jiraSend(ctx, conn, 'addComment', request);
    if (answer.kind === 'ok') {
        const id = answer.json?.id;
        if (typeof id === 'string' && COMMENT_ID.test(id)) return succeed(ctx, dispatched, id);
        return settle(ctx, conn, dispatched, issue, operationKey, dispatched.dispatchedAt);
    }
    if (answer.kind === 'ambiguous') return settle(ctx, conn, dispatched, issue, operationKey, dispatched.dispatchedAt);
    await moveReceipt(ctx, dispatched, ['dispatched'], 'failed');
    if (answer.kind === 'unauthorized') {
        throw new Stop(EXIT_FAILED, 'refused', 'credential_rejected', 'jira: credential rejected by Jira after a fresh one was issued; nothing was posted. Report it.');
    }
    throw new Stop(EXIT_FAILED, 'refused', answer.reason, `jira: Jira refused the comment (${answer.reason}); nothing was posted. Report it.`);
}

// ---- The command line ----

const USAGE =
    'usage: jira.cjs issue KEY [--fields a,b] | search JQL [--fields a,b] [--max N] | comments KEY | comment KEY (--body-file PATH | --body TEXT) [--key K]   (each: [--site HOST])';
const FLAGS = { issue: ['fields', 'site'], search: ['fields', 'max', 'site'], comments: ['site'], comment: ['body-file', 'body', 'key', 'site'] };

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
    if (positional.length !== 1) throw bad(USAGE);
    return { command, target: positional[0], flags };
}

function bodyOf(ctx, flags) {
    if ((flags.body === undefined) === (flags['body-file'] === undefined)) throw bad('jira: pass exactly one of --body-file and --body.');
    if (flags.body !== undefined) return flags.body;
    try {
        return ctx.deps.readFile(flags['body-file']);
    } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw bad(`jira: no such file: ${flags['body-file']}`);
        throw bad(`jira: ${flags['body-file']} is unreadable (${error?.code ?? 'error'}).`);
    }
}

async function execute(ctx, argv) {
    const { command, target, flags } = parseArgs(argv);
    const fields = flags.fields === undefined ? undefined : flags.fields.split(',').filter(Boolean);
    const body = command === 'comment' ? bodyOf(ctx, flags) : undefined;
    const conn = await connectionFor(ctx, flags.site);
    const request = (op, input) => {
        try {
            return requestFor(op, input, conn.resource);
        } catch {
            throw bad('jira: that is not an issue key.');
        }
    };
    if (command === 'issue') {
        ctx.deps.stdout(`${JSON.stringify(await readJira(ctx, conn, 'getIssue', request('getIssue', { key: target, fields })))}\n`);
    } else if (command === 'search') {
        const max = flags.max === undefined ? undefined : Number(flags.max);
        if (max !== undefined && !Number.isInteger(max)) throw bad('jira: --max is a whole number.');
        const { items, truncated } = await collect(ctx, conn, 'searchIssues', { jql: target, fields, maxResults: max });
        ctx.deps.stdout(`${JSON.stringify({ issues: items, truncated })}\n`);
    } else if (command === 'comments') {
        request('listComments', { key: target });
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
            deps.stderr('jira: unexpected failure.\n');
            deps.stdout(`${JSON.stringify({ outcome: 'unavailable', reason: 'internal' })}\n`);
            return EXIT_FAILED;
        }
        deps.stdout(`${JSON.stringify({ outcome: error.outcome, reason: error.reason, ...error.extra })}\n`);
        deps.stderr(`${error.message}\n`);
        return error.code;
    }
}

/** The real process's dependencies; the broker and the pair helper are baked at fixed paths in both images. */
function defaultDeps(env = process.env) {
    const broker = require('/usr/local/bin/credential-broker.cjs');
    const { currentPair } = require('/usr/local/bin/attempt-pair.cjs');
    return {
        env,
        now: Date.now,
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        pair: currentPair,
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

module.exports = { run, requestFor, nextPath, defaultDeps, REQUIRED_SCOPES };
