'use strict';
/*
 * The runner's one path to a lease-gated board route (docs/connections.md). Every helper that presents the
 * attempt pair — the credential broker, the Jira, Linear and task-title helpers — asks the board through
 * `boardCall`, the only code in the runner that puts `x-factory-job-lease-token` on a request
 * (driver/test/board-call.test.ts guards that). Each try re-reads the pair (`attempt-pair.cjs`): an adopting
 * claim rotates the lease under a container whose env stays as it was.
 *
 * One wall-clock budget, created once at the helper's start (`createBudget`), covers every pair read,
 * request, body read and wait. The helper's `classify` turns an answer into `{ done: value }` (a verdict,
 * success or refusal) or `{ retry: true, waitMs? }`; a wire failure — a throw, an abort, a cut-off or oversize
 * body — is a retry. `boardCall` resolves on every path, never rejects:
 * `{ ok: true, value, pair }` or `{ ok: false, reason: 'no_pair' | 'deadline' | 'rate_limited' }`.
 *
 * One file, built into both executor images (driver/test/executor-images.test.ts); skills require it at
 * `/usr/local/bin/board-call.cjs`.
 */

/** The pair read never waits longer than `attempt-pair.cjs`'s own deadline. */
const PAIR_DEADLINE_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const BODY_CAP_BYTES = 64 * 1024;
const BACKOFF_MS = 500;
const BACKOFF_MAX_MS = 4000;

/** One absolute deadline for a helper invocation: every nested board call spends from the same one. */
function createBudget({ now, baseMs, start = now() }) {
    const end = start + baseMs;
    return { start, end, remaining: () => end - now() };
}

/** The body as text, read to its end; past the cap, or cut off, it throws (a wire failure). */
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

/** The pair as it is now, or null where this container holds none. Read for a request, or for a key that must follow it (a cache). */
async function readPair(deps, deadlineMs = PAIR_DEADLINE_MS) {
    if (!deps.env.FACTORY_STATS_URL) return null;
    const pair = await deps.pair(deps.env, { deadlineMs });
    return pair.jobId && pair.leaseToken ? pair : null;
}

/** One request with the pair: `{ status, headers, json }`, json undefined where the body is not JSON. Throws on the wire. */
async function request(deps, pair, call, timeoutMs) {
    const headers = { ...call.headers, 'x-factory-job-id': pair.jobId, 'x-factory-job-lease-token': pair.leaseToken };
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    const signal = deps.signal ? deps.signal(timeoutMs) : AbortSignal.timeout(timeoutMs);
    const response = await deps.fetch(`${deps.env.FACTORY_STATS_URL.replace(/\/+$/, '')}/api/jobs/${pair.jobId}${call.path}`, {
        method: call.method,
        headers,
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        redirect: 'manual',
        signal,
    });
    const text = await readText(response);
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return { status: response.status, headers: response.headers, json };
}

/**
 * `call`: `{ method, path (under /api/jobs/:id), body? (sent as JSON), headers? (beside the pair), classify, once?,
 * requestTimeoutMs?, backoffMs?, backoffMaxMs? }`.
 * `once` makes one request whatever the answer (a best-effort revoke). A wait the board hints that the budget
 * cannot cover ends `rate_limited`; backoff the budget cannot cover ends `deadline`.
 */
async function boardCall(deps, budget, call) {
    let backoff = call.backoffMs ?? BACKOFF_MS;
    while (budget.remaining() > 0) {
        const pair = await readPair(deps, Math.max(1, Math.min(PAIR_DEADLINE_MS, budget.remaining())));
        if (!pair) return { ok: false, reason: 'no_pair' };
        const left = budget.remaining();
        if (left <= 0) break;
        let answer = null;
        try {
            answer = await request(deps, pair, call, Math.max(1, Math.min(call.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, left)));
        } catch {
            // A wire failure: no answer, tried again inside the budget.
        }
        const verdict = answer ? call.classify(answer) : { retry: true };
        if ('done' in verdict) return { ok: true, value: verdict.done, pair };
        if (call.once) break;
        const hinted = verdict.waitMs ?? null;
        const wait = hinted ?? backoff;
        if (wait >= budget.remaining()) return { ok: false, reason: hinted === null ? 'deadline' : 'rate_limited', lastWaitMs: wait };
        await deps.sleep(wait);
        backoff = Math.min(backoff * 2, call.backoffMaxMs ?? BACKOFF_MAX_MS);
    }
    return { ok: false, reason: 'deadline' };
}

module.exports = { boardCall, createBudget, readPair, PAIR_DEADLINE_MS, REQUEST_TIMEOUT_MS, BODY_CAP_BYTES };
