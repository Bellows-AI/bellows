#!/usr/bin/env node
'use strict';
/*
 * The runner's task-title helper (docs/connections.md): `task-title.cjs "<title>"` names the task the agent
 * is working on, through the board's `POST /api/jobs/:id/agent-title` on the attempt pair
 * (docker/executor-common/attempt-pair.cjs, re-read on every request). The title rides argv only, never env.
 * The board normalizes it and refuses to replace a title a person set.
 *
 * One absolute wall-clock deadline, computed once, covers every request, body read, retry and wait. stdout is
 * always one JSON line. Exit codes: 0 the board answered 200 (its JSON is printed, `updated` says whether the
 * title changed); 1 the board refused (bad title, refused or finished attempt, change limit, conflict);
 * 2 no attempt credential or bad usage, no request made; 4 UNKNOWN: the board could not be reached or its
 * answer could not be read inside the deadline, so nothing is known about the title (never "unchanged").
 */

const DEADLINE_MS = 10_000;
const PAIR_DEADLINE_MS = 2_000;
const BACKOFF_MS = 250;
const BACKOFF_MAX_MS = 2_000;
const MS_PER_SECOND = 1_000;
const BODY_CAP_BYTES = 64 * 1024;
const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_UNKNOWN = 4;
const HTTP_OK = 200;
const HTTP_REFUSED = new Set([400, 403, 409, 429]);
const HTTP_RETRY = (status) => status >= 500 || status === 408;

const USAGE = 'task-title: usage: task-title.cjs "<concise title, up to 120 characters>"';
const NO_PAIR = 'task-title: this container holds no attempt credential, so the board cannot be asked. Do not retry.';
const UNKNOWN = 'task-title: the board did not confirm the title; it may or may not have changed. Continue the task; retry once later if the title still matters.';

class Stop extends Error {
    constructor(code, outcome, reason, message, extra = {}) {
        super(message);
        this.code = code;
        this.outcome = outcome;
        this.reason = reason;
        this.extra = extra;
    }
}

const unknown = (reason) => new Stop(EXIT_UNKNOWN, 'unknown', reason, UNKNOWN);

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

/** One request inside the deadline: {status, headers, json}; json is undefined where the body is not JSON. Throws on any wire failure. */
async function wire(deps, end, url, init) {
    const left = end - deps.now();
    if (left <= 0) throw unknown('deadline');
    const response = await deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(left) });
    const text = await readText(response);
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return { status: response.status, headers: response.headers, json };
}

async function send(deps, end, title) {
    const { env } = deps;
    let backoff = BACKOFF_MS;
    while (end - deps.now() > 0) {
        const pair = await deps.pair(env, { deadlineMs: Math.max(1, Math.min(PAIR_DEADLINE_MS, end - deps.now())) });
        if (!env.FACTORY_STATS_URL || !pair.jobId || !pair.leaseToken) throw new Stop(EXIT_USAGE, 'no_pair', 'no_pair', NO_PAIR);
        const url = `${env.FACTORY_STATS_URL.replace(/\/+$/, '')}/api/jobs/${pair.jobId}/agent-title`;
        const headers = {
            'x-factory-job-id': pair.jobId,
            'x-factory-job-lease-token': pair.leaseToken,
            accept: 'application/json',
            'content-type': 'application/json',
        };
        let wait = backoff;
        try {
            const res = await wire(deps, end, url, { method: 'POST', headers, body: JSON.stringify({ title }) });
            if (res.status === HTTP_OK) {
                if (res.json && typeof res.json === 'object' && typeof res.json.updated === 'boolean') return res.json;
                throw unknown('malformed');
            }
            if (HTTP_REFUSED.has(res.status)) {
                const code = res.json && typeof res.json.code === 'string' ? res.json.code : 'refused';
                const message = res.json && typeof res.json.error === 'string' ? res.json.error : 'the board refused the title';
                throw new Stop(EXIT_REFUSED, 'refused', code, `task-title: ${message}`);
            }
            if (!HTTP_RETRY(res.status)) throw unknown(`status_${res.status}`);
            const hinted = retryAfterMs(res.headers);
            if (hinted !== null) wait = hinted;
        } catch (error) {
            // A wire failure (reset, cut-off body, timeout) is tried again inside the deadline; a verdict is final.
            if (error instanceof Stop) throw error;
        }
        if (wait >= end - deps.now()) break;
        await deps.sleep(wait);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
    throw unknown('deadline');
}

/** Runs the helper; returns the exit code. The only place output is written. */
async function run(argv, deps) {
    const end = deps.now() + deps.deadlineMs;
    try {
        if (argv.length !== 1 || argv[0].trim() === '') throw new Stop(EXIT_USAGE, 'usage', 'usage', USAGE);
        const answer = await send(deps, end, argv[0]);
        deps.stdout(`${JSON.stringify(answer)}\n`);
        return EXIT_OK;
    } catch (error) {
        const stop = error instanceof Stop ? error : unknown('error');
        deps.stdout(`${JSON.stringify({ outcome: stop.outcome, reason: stop.reason, ...stop.extra })}\n`);
        deps.stderr(`${stop.message}\n`);
        return stop.code;
    }
}

/** The real process's dependencies; the pair helper is baked at a fixed path in both images. */
function defaultDeps(env = process.env) {
    const { currentPair } = require('/usr/local/bin/attempt-pair.cjs');
    return {
        env,
        now: Date.now,
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        pair: currentPair,
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

module.exports = { run, defaultDeps };
