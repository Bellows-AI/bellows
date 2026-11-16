#!/usr/bin/env node
'use strict';
/*
 * The runner's task-title helper (docs/connections.md): `task-title.cjs "<title>"` names the task the agent
 * is working on, through the board's `POST /api/jobs/:id/agent-title` on the attempt pair
 * (docker/executor-common/attempt-pair.cjs, re-read on every request by docker/executor-common/board-call.cjs, the
 * runner's one board-call path). The title rides argv only, never env.
 * The board normalizes it and refuses to replace a title a person set.
 *
 * One absolute wall-clock deadline, computed once, covers every request, body read, retry and wait. stdout is
 * always one JSON line. Exit codes: 0 the board answered 200 (its JSON is printed, `updated` says whether the
 * title changed); 1 the board refused (bad title, refused or finished attempt, change limit, conflict);
 * 2 no attempt credential or bad usage, no request made; 4 UNKNOWN: the board could not be reached or its
 * answer could not be read inside the deadline, so nothing is known about the title (never "unchanged").
 */

const DEADLINE_MS = 10_000;
const BACKOFF_MS = 250;
const BACKOFF_MAX_MS = 2_000;
const MS_PER_SECOND = 1_000;
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

/** The agent-title route's answer: the board's JSON, a final verdict, or a retry (after `Retry-After` where named). */
function classify(res) {
    if (res.status === HTTP_OK) {
        if (res.json && typeof res.json === 'object' && typeof res.json.updated === 'boolean') return { done: res.json };
        return { done: unknown('malformed') };
    }
    if (HTTP_REFUSED.has(res.status)) {
        const code = res.json && typeof res.json.code === 'string' ? res.json.code : 'refused';
        const message = res.json && typeof res.json.error === 'string' ? res.json.error : 'the board refused the title';
        return { done: new Stop(EXIT_REFUSED, 'refused', code, `task-title: ${message}`) };
    }
    if (!HTTP_RETRY(res.status)) return { done: unknown(`status_${res.status}`) };
    return { retry: true, waitMs: retryAfterMs(res.headers) };
}

/** The title through the one board-call path; a wire failure is tried again inside the deadline, a verdict is final. */
async function send(deps, budget, title) {
    const result = await deps.board.boardCall(deps, budget, {
        method: 'POST',
        path: '/agent-title',
        body: { title },
        headers: { accept: 'application/json' },
        classify,
        requestTimeoutMs: deps.deadlineMs,
        backoffMs: BACKOFF_MS,
        backoffMaxMs: BACKOFF_MAX_MS,
    });
    if (!result.ok) throw result.reason === 'no_pair' ? new Stop(EXIT_USAGE, 'no_pair', 'no_pair', NO_PAIR) : unknown('deadline');
    if (result.value instanceof Stop) throw result.value;
    return result.value;
}

/** Runs the helper; returns the exit code. The only place output is written. */
async function run(argv, deps) {
    const budget = deps.board.createBudget({ now: deps.now, baseMs: deps.deadlineMs });
    try {
        if (argv.length !== 1 || argv[0].trim() === '') throw new Stop(EXIT_USAGE, 'usage', 'usage', USAGE);
        const answer = await send(deps, budget, argv[0]);
        deps.stdout(`${JSON.stringify(answer)}\n`);
        return EXIT_OK;
    } catch (error) {
        const stop = error instanceof Stop ? error : unknown('error');
        deps.stdout(`${JSON.stringify({ outcome: stop.outcome, reason: stop.reason, ...stop.extra })}\n`);
        deps.stderr(`${stop.message}\n`);
        return stop.code;
    }
}

/** The real process's dependencies; the pair helper and the board call are baked at fixed paths in both images. */
function defaultDeps(env = process.env) {
    const { currentPair } = require('/usr/local/bin/attempt-pair.cjs');
    return {
        env,
        board: require('/usr/local/bin/board-call.cjs'),
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
