// @ts-check
'use strict';

/*
 * The deterministic review COLLECTION: every supported feedback surface of a pull request in one
 * bounded, versioned JSON verdict — the state future review reconciliation reads, and the reply
 * planner validates against. One execFileSync per gh call, direct argv only: no shell, no
 * interpolation, no value can become a command. The credential rides gh's own env (GH_TOKEN or
 * GITHUB_TOKEN) and never appears in argv, in an error, or on stdout (issue #201).
 *
 * Environment:
 *   REPO  owner/name of the repository;
 *   PR    the pull request number;
 *   GH_TOKEN or GITHUB_TOKEN — required before any spawn (a tokenless gh would sit on an auth
 *         prompt instead of failing).
 *
 * The verdict is ONE JSON line: {version, schema, ref, general, reviews, inline, threads,
 * addressed, requestedReviewers, decision, pendingChecks, truncated, error}. Every section is
 * deduped by GitHub id, capped, and stable-sorted, so the same upstream state always produces the
 * same bytes. `addressed` is the sorted keys whose Factory reply marker any general or inline
 * comment carries, read before the caps — a thread reply is an inline comment too — so whether an
 * item was already answered never depends on which rows a section kept (issue #826).
 * REST carries the bulk (numeric ids, full bodies, diff hunks, --paginate); GraphQL carries what REST
 * does not expose: review-thread node ids, their resolved state, the PR's review decision and its
 * head commit. `pendingChecks` counts the head's check runs not yet completed (a review bot is
 * often one) from the first page of REST check-runs — `checks: read`, which the runner token holds.
 * Any gh failure is a TERMINAL refusal ({ok:false, ...}) — a partial collection is never the
 * answer, because the reply planner must trust that "absent from state" means "not on the PR".
 */

const { execFileSync } = require('node:child_process');

const VERSION = 1;
const SCHEMA = 'review-collect/v1';
const TRUNCATED_MARKER = ' […truncated by the board] ';
const BODY_MAX = 2000;
const DIFF_HUNK_MAX = 500;
const ERROR_MAX = 300;
const GENERAL_LIMIT = 50;
const INLINE_LIMIT = 50;
const REVIEWS_LIMIT = 20;
const THREADS_LIMIT = 100;
const THREAD_COMMENTS_LIMIT = 10;
const TOTAL_OUTPUT_BYTES = 262144;
const GH_OUTPUT_MAX_BUFFER_BYTES = 16777216;
const ADDRESSED_MARKER = /<!-- factory-review-reconcile addressed (\S+) -->/g;

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewDecision
      headRefOid
      reviewThreads(first: ${THREADS_LIMIT}) {
        totalCount
        nodes {
          id isResolved isOutdated path line
          comments(first: ${THREAD_COMMENTS_LIMIT}) {
            totalCount
            nodes { id databaseId author { login } body createdAt }
          }
        }
      }
    }
  }
}`;

/**
 * @typedef {{ owner: string, repo: string, number: number }} Ref
 * @typedef {{ bodies: number, diffHunks: number, threads: number }} Counts
 * @typedef {{ sections: string[], bodies: number, diffHunks: number, threads: number, total: boolean }} Truncation
 */

/** @param {unknown} v */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {unknown} v */
const str = (v) => (typeof v === 'string' ? v : null);
/** @param {any} o a parsed GitHub row */
const login = (o) => (o && typeof o.user === 'object' && o.user !== null ? str(o.user.login) : null);
/** @param {any} o */
const present = (o) => o && typeof o === 'object' && o !== null;

/**
 * @param {string | undefined} repo
 * @param {string | undefined} pr
 * @returns {Ref | null}
 */
function validateRef(repo, pr) {
    const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(/** @type {string} */ (repo));
    if (!m || !/^\d{1,9}$/.test(/** @type {string} */ (pr))) return null;
    return { owner: m[1], repo: m[2], number: Number(pr) };
}

/**
 * @param {string} text
 * @param {number} max
 * @param {Counts} counts
 * @param {'bodies' | 'diffHunks'} key
 * @returns {string}
 */
function truncated(text, max, counts, key) {
    const chars = [...text];
    if (chars.length <= max) return text;
    counts[key] += 1;
    return `${chars.slice(0, max).join('')}${TRUNCATED_MARKER}`;
}

/**
 * Cap + dedupe by GitHub id; a capped section records its name so the answer says so.
 * @param {any[]} rows
 * @param {{ map: (row: any) => any, limit: number, ts: Truncation, name: string }} options
 */
function section(rows, { map, limit, ts, name }) {
    const seen = new Set();
    const out = [];
    for (const row of rows) {
        const item = map(row);
        if (!item || item.id === null || item.id === undefined) continue;
        const key = String(item.id);
        if (seen.has(key)) continue;
        seen.add(key);
        if (out.length >= limit) {
            if (!ts.sections.includes(name)) ts.sections.push(name);
            break;
        }
        out.push(item);
    }
    return out;
}

/**
 * @param {any} a
 * @param {any} b
 */
const byId = (a, b) => a.id - b.id || String(a.id).localeCompare(String(b.id));

/**
 * @param {any} a
 * @param {any} b
 */
const sortThread = (a, b) => {
    const da = a.comments[0] && a.comments[0].databaseId !== null ? a.comments[0].databaseId : null;
    const db = b.comments[0] && b.comments[0].databaseId !== null ? b.comments[0].databaseId : null;
    if (da === null && db === null) return a.id.localeCompare(b.id);
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db || a.id.localeCompare(b.id);
};

/**
 * @param {any} a
 * @param {any} b
 */
const sortComment = (a, b) => {
    if (a.databaseId === null && b.databaseId === null) return a.id.localeCompare(b.id);
    if (a.databaseId === null) return 1;
    if (b.databaseId === null) return -1;
    return a.databaseId - b.databaseId || a.id.localeCompare(b.id);
};

/**
 * @param {any} row
 * @param {Counts} counts
 */
const asComment = (row, counts) => ({
    id: num(row && row.id),
    author: login(row),
    body: truncated(str(row && row.body) ?? '', BODY_MAX, counts, 'bodies'),
    createdAt: str(row && row.created_at),
    path: null,
    line: null,
    diffHunk: null,
    inReplyToId: null,
    reviewId: null,
});

/**
 * @param {any} row
 * @param {Counts} counts
 */
const asLine = (row, counts) => ({
    id: num(row && row.id),
    author: login(row),
    body: truncated(str(row && row.body) ?? '', BODY_MAX, counts, 'bodies'),
    createdAt: str(row && row.created_at),
    path: str(row && row.path),
    line: num(row && row.line),
    diffHunk: truncated(str(row && row.diff_hunk) ?? '', DIFF_HUNK_MAX, counts, 'diffHunks'),
    inReplyToId: num(row && row.in_reply_to_id),
    reviewId: num(row && row.pull_request_review_id),
});

/**
 * @param {any} row
 * @param {Counts} counts
 */
const asReview = (row, counts) => ({
    id: num(row && row.id),
    author: login(row),
    state: str(row && row.state),
    body: truncated(str(row && row.body) ?? '', BODY_MAX, counts, 'bodies'),
    createdAt: str(row && row.submitted_at),
    commitId: str(row && row.commit_id),
});

/**
 * Every key a Factory reply marker names in `rows`' full bodies.
 * @param {any[]} rows
 * @returns {Set<string>}
 */
function addressedKeys(rows) {
    /** @type {Set<string>} */
    const keys = new Set();
    for (const row of rows) {
        for (const match of (str(row && row.body) ?? '').matchAll(ADDRESSED_MARKER)) keys.add(match[1]);
    }
    return keys;
}

/**
 * REST-backed sections: general PR comments, reviews, and inline (diff) comments.
 * @param {Ref} ref
 * @param {Truncation} ts
 * @param {Counts} counts
 */
function fetchRestSections(ref, ts, counts) {
    const pulls = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const issues = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`;

    const generalRows = JSON.parse(gh(['api', `${issues}/comments`, '--paginate']));
    const general = section(generalRows, {
        map: (row) => asComment(row, counts),
        limit: GENERAL_LIMIT,
        ts,
        name: 'general',
    });
    const reviews = section(JSON.parse(gh(['api', `${pulls}/reviews`, '--paginate'])), {
        map: (row) => asReview(row, counts),
        limit: REVIEWS_LIMIT,
        ts,
        name: 'reviews',
    });
    const inlineRows = JSON.parse(gh(['api', `${pulls}/comments`, '--paginate']));
    const inline = section(inlineRows, {
        map: (row) => asLine(row, counts),
        limit: INLINE_LIMIT,
        ts,
        name: 'inline',
    });
    const addressed = [...new Set([...addressedKeys(generalRows), ...addressedKeys(inlineRows)])].sort();
    return { general, reviews, inline, addressed };
}

/** @param {Ref} ref */
function fetchRequestedReviewers(ref) {
    const pulls = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
    const requested = JSON.parse(gh(['api', `${pulls}/requested_reviewers`]));
    const users = (present(requested) && Array.isArray(requested.users) ? requested.users : [])
        .map(/** @param {any} u */ (u) => str(u && u.login))
        .filter(/** @param {any} u */ (u) => u !== null);
    const teams = (present(requested) && Array.isArray(requested.teams) ? requested.teams : [])
        .map(/** @param {any} t */ (t) => str(t && t.name))
        .filter(/** @param {any} t */ (t) => t !== null);
    return { users, teams };
}

/** @param {Ref} ref */
function fetchThreadsGql(ref) {
    return JSON.parse(
        gh([
            'api',
            'graphql',
            '-f',
            `query=${THREADS_QUERY}`,
            '-f',
            `owner=${ref.owner}`,
            '-f',
            `repo=${ref.repo}`,
            '-F',
            `number=${ref.number}`,
        ])
    );
}

/**
 * One review thread's comments, capped and recorded in `ts`/`counts` when truncated.
 * @param {any} node
 * @param {Truncation} _ts
 * @param {Counts} counts
 */
function threadComments(node, _ts, counts) {
    const comments = (node.comments && Array.isArray(node.comments.nodes) ? node.comments.nodes : [])
        .filter(/** @param {any} c */ (c) => c && typeof c.id === 'string')
        .map(
            /** @param {any} c */ (c) => ({
                id: c.id,
                databaseId: num(c.databaseId),
                author: c.author && c.author !== null ? str(c.author.login) : null,
                body: truncated(str(c.body) ?? '', BODY_MAX, counts, 'bodies'),
                createdAt: str(c.createdAt),
            })
        )
        .sort(sortComment);
    const totalComments = num(node.comments && node.comments.totalCount);
    if (comments.length > THREAD_COMMENTS_LIMIT || (totalComments !== null && totalComments > comments.length)) {
        if (comments.length > THREAD_COMMENTS_LIMIT) comments.length = THREAD_COMMENTS_LIMIT;
        counts.threads += 1;
    }
    return comments;
}

/**
 * Cap the thread list to THREADS_LIMIT, recording the truncation in `ts` when it bites.
 * @param {any[]} threads
 * @param {number | null} totalThreads
 * @param {Truncation} ts
 */
function capThreads(threads, totalThreads, ts) {
    if (threads.length > THREADS_LIMIT || (totalThreads !== null && totalThreads > threads.length)) {
        if (threads.length > THREADS_LIMIT) threads.length = THREADS_LIMIT;
        ts.sections.push('threads');
    }
}

/**
 * Review threads, the PR's review decision and its head commit, read via GraphQL.
 * @param {Ref} ref
 * @param {Truncation} ts
 * @param {Counts} counts
 */
function fetchThreads(ref, ts, counts) {
    const gql = fetchThreadsGql(ref);
    const pr = gql && gql.data && gql.data.repository && gql.data.repository.pullRequest;
    const nodes = pr && pr.reviewThreads && Array.isArray(pr.reviewThreads.nodes) ? pr.reviewThreads.nodes : [];

    const threads = nodes
        .filter(/** @param {any} node */ (node) => node && typeof node.id === 'string')
        .map(
            /** @param {any} node */ (node) => ({
                id: node.id,
                isResolved: node.isResolved === true,
                isOutdated: node.isOutdated === true,
                path: str(node.path),
                line: num(node.line),
                comments: threadComments(node, ts, counts),
            })
        );

    const totalThreads = pr && pr.reviewThreads ? num(pr.reviewThreads.totalCount) : null;
    capThreads(threads, totalThreads, ts);
    if (counts.threads > 0) ts.sections.push('thread-comments');
    return { threads, decision: pr ? str(pr.reviewDecision) : null, headOid: pr ? str(pr.headRefOid) : null };
}

/**
 * How many of the head commit's check runs are not yet completed; 0 without a head.
 * @param {Ref} ref
 * @param {string | null} headOid
 */
function fetchPendingChecks(ref, headOid) {
    if (!headOid || !/^[0-9a-f]{40}$/.test(headOid)) return 0;
    const runs = JSON.parse(
        gh(['api', `repos/${ref.owner}/${ref.repo}/commits/${headOid}/check-runs?filter=latest&per_page=100`])
    );
    const list = present(runs) && Array.isArray(runs.check_runs) ? runs.check_runs : [];
    return list.filter(/** @param {any} r */ (r) => r && r.status !== 'completed').length;
}

/**
 * Bound the serialized verdict to TOTAL_OUTPUT_BYTES, collapsing to a `total` truncation.
 * @param {object} out
 * @param {Ref} ref
 */
function boundOutput(out, ref) {
    const serialized = JSON.stringify(out);
    if (Buffer.byteLength(serialized, 'utf8') <= TOTAL_OUTPUT_BYTES) return serialized;
    return JSON.stringify({
        version: VERSION,
        schema: SCHEMA,
        ref,
        truncated: { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: true },
        error: null,
    });
}

function collect() {
    const ref = validateRef(process.env.REPO, process.env.PR);
    if (!ref) return refusal('invalid REPO/PR: expected owner/name and a pull request number', null);
    if (!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()) {
        return refusal('missing credential: GH_TOKEN or GITHUB_TOKEN must be set', ref);
    }

    /** @type {Truncation} */
    const ts = { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: false };
    const counts = { bodies: 0, diffHunks: 0, threads: 0 };

    const { general, reviews, inline, addressed } = fetchRestSections(ref, ts, counts);
    const { users, teams } = fetchRequestedReviewers(ref);
    const { threads, decision, headOid } = fetchThreads(ref, ts, counts);
    const pendingChecks = fetchPendingChecks(ref, headOid);
    ts.bodies = counts.bodies;
    ts.diffHunks = counts.diffHunks;
    ts.threads = counts.threads;

    general.sort(byId);
    reviews.sort(byId);
    inline.sort(byId);
    threads.sort(sortThread);
    users.sort();
    teams.sort();

    const out = {
        version: VERSION,
        schema: SCHEMA,
        ref,
        general,
        reviews,
        inline,
        threads,
        addressed,
        requestedReviewers: { users, teams },
        decision,
        pendingChecks,
        truncated: ts,
        error: null,
    };

    return boundOutput(out, ref);
}

/** @param {string[]} args */
function gh(args) {
    return execFileSync('gh', args, {
        env: process.env,
        encoding: 'utf8',
        maxBuffer: GH_OUTPUT_MAX_BUFFER_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/**
 * @param {unknown} error
 * @param {Ref | null} ref
 */
function refusal(error, ref) {
    const text = String(error);
    const bounded = text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX)}${TRUNCATED_MARKER}` : text;
    return JSON.stringify({ ok: false, version: VERSION, schema: SCHEMA, ref, error: bounded });
}

try {
    const out = collect();
    if (typeof out === 'string') process.stdout.write(`${out}\n`);
} catch (/** @type {any} */ e) {
    const ref = validateRef(process.env.REPO, process.env.PR);
    const message = (e && e.stderr && String(e.stderr)) || (e && e.message && String(e.message)) || String(e);
    process.stdout.write(`${refusal(message, ref)}\n`);
}
