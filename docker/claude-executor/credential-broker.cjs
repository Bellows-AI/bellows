'use strict';
/*
 * The runner's client of the board's credential broker (docs/connections.md). No credential rides the
 * runner's env: this module asks the board with the attempt pair, caches the answer per attempt and
 * per key on memory-backed storage, and renews it ahead of its expiry, so a run that outlives a
 * token still works. Two keys exist today: `github` (POST /api/jobs/:id/credentials/github) and
 * `connection:<id>` (POST /api/jobs/:id/credentials/connections/:id), the latter reached only through
 * the `connectionCredential(id)` library export — no command prints a connection token.
 *
 * One wall-clock deadline covers every request, `Retry-After` wait and backoff of a call; a refusal
 * or a typed stop ends it at once; a malformed answer is a retry, never "no credential". `clear`
 * revokes the cached GitHub token through the board and then removes every entry.
 *
 * Callers pass `deps` (see `defaultDeps`) and receive `{ok:true, token, ...}` or `{ok:false, reason}`;
 * a token goes nowhere but the result, never to stderr, which carries guidance a person can act on.
 *
 * Kept byte-identical in both executor images (driver/test/executor-images.test.ts).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { currentPair } = require('./attempt-pair.cjs');

/** Memory-backed in both executors: docker `--tmpfs`, kubernetes `emptyDir: {medium: Memory}`; the agent container alone. */
const CACHE_DIR = '/run/factory-credentials';
const GITHUB_KEY = 'github';
/** Renewed this long before the credential's expiry, so no call starts on a dying token. */
const RENEW_SKEW_MS = 5 * 60 * 1000;
/** A token the board names no expiry for is cached for at most this long. */
const NULL_EXPIRY_CAP_MS = 10 * 60 * 1000;
/** All requests, waits and backoff of one call: an unreachable board must not hang a push. */
const DEADLINE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** `clear` revokes inside this: the entrypoint's exit stays inside the docker-stop and kubernetes grace periods. */
const REVOKE_DEADLINE_MS = 3000;
const BACKOFF_MS = 500;
const BACKOFF_MAX_MS = 4000;
const EXIT_INTEGRATION_REQUIRED = 3;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
const MS_PER_SECOND = 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const connectionKey = (id) => `connection:${id}`;

const GUIDANCE = {
    no_pair:
        'credential-broker: this container holds no attempt credential (FACTORY_STATS_URL, RUNNER_JOB_ID, ' +
        'RUNNER_LEASE_TOKEN), so there is no credential here.',
    refused:
        'credential-broker: the board refused this attempt a credential: the call carried a lease this attempt ' +
        'no longer holds, or its task is no longer authorized (its author left the organization). Each call ' +
        'reads the current pair: retry once, and if a fresh call is refused the same way, report it. A later ' +
        'turn may succeed.',
    no_app:
        'credential-broker: the board holds no GitHub App installation for this organization, so it issues no ' +
        'GitHub token. Ask an admin to install the App; git and gh run without a credential until then.',
    integration_required:
        'credential-broker: the connection needs the user to connect or reconnect it before the board issues a credential.',
    rate_limited: 'credential-broker: the board asked to wait longer than this call may; retry the step shortly.',
    unreachable:
        'credential-broker: the board did not issue a credential before its deadline. git and gh run without ' +
        'a credential; retry the step shortly.',
    bad_request: 'credential-broker: that is not a connection id.',
};

const fail = (deps, reason, extra = {}) => {
    deps.stderr(GUIDANCE[reason]);
    return { ok: false, reason, ...extra };
};

/** The attempt the entry belongs to and its key: an entry written under another pair or key is never read. */
const entryName = (pair, key) =>
    `${crypto.createHash('sha256').update(`${pair.jobId}|${pair.leaseToken}|${key}`).digest('hex')}.json`;

function readEntry(deps, pair, key) {
    try {
        const cached = JSON.parse(fs.readFileSync(path.join(deps.dir, entryName(pair, key)), 'utf8'));
        if (cached.key !== key || typeof cached.token !== 'string') return null;
        const expires = Date.parse(cached.cacheUntil);
        return Number.isFinite(expires) && deps.now() < expires - RENEW_SKEW_MS ? cached : null;
    } catch {
        return null;
    }
}

/**
 * Written whole or not at all, 0600, in a directory narrowed to 0700 where this user owns it (the
 * docker tmpfs is mounted so; a kubernetes emptyDir stays the kubelet's, mounted in this container
 * alone). A directory this user cannot write is no cache.
 */
function writeEntry(deps, pair, key, answer) {
    const file = path.join(deps.dir, entryName(pair, key));
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(deps.dir, { recursive: true, mode: DIR_MODE });
        try {
            fs.chmodSync(deps.dir, DIR_MODE);
        } catch {
            // Not ours to narrow; the file's own mode still holds.
        }
        const expires = answer.expiresAt === null ? Number.NaN : Date.parse(answer.expiresAt);
        const cacheUntil = new Date(Number.isFinite(expires) ? expires : deps.now() + NULL_EXPIRY_CAP_MS).toISOString();
        fs.writeFileSync(tmp, JSON.stringify({ key, ...answer, cacheUntil }), { mode: FILE_MODE });
        fs.renameSync(tmp, file);
    } catch {
        // Uncached is still correct: the next call asks the board again.
        fs.rmSync(tmp, { force: true });
    }
}

/** The board's answer's fields, or null when the body is not a credential. `expiresAt` is a string or null. */
function credentialOf(body) {
    if (!body || typeof body !== 'object' || typeof body.token !== 'string' || !body.token) return null;
    const expiresAt = body.expiresAt ?? null;
    if (expiresAt !== null && (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) return null;
    return {
        ok: true,
        token: body.token,
        expiresAt,
        scopes: Array.isArray(body.scopes) ? body.scopes.filter((s) => typeof s === 'string') : [],
        resource: body.resource ?? null,
    };
}

const urlOf = (deps, pair, key) => {
    const base = `${deps.env.FACTORY_STATS_URL.replace(/\/+$/, '')}/api/jobs/${pair.jobId}/credentials`;
    return key === GITHUB_KEY ? `${base}/github` : `${base}/connections/${key.slice('connection:'.length)}`;
};

const pairHeaders = (pair) => ({ 'x-factory-job-id': pair.jobId, 'x-factory-job-lease-token': pair.leaseToken });

/** `Retry-After` in seconds, as milliseconds; null where absent or not a plain count. */
function retryAfterMs(response) {
    const value = response.headers.get('retry-after');
    return value && /^\d{1,6}$/.test(value.trim()) ? Number(value) * MS_PER_SECOND : null;
}

/** One ask of the board: a credential, a stop, or `{retry, waitMs}`. */
async function ask(deps, pair, key, remainingMs) {
    let response;
    try {
        response = await deps.fetch(urlOf(deps, pair, key), {
            method: 'POST',
            headers: pairHeaders(pair),
            signal: deps.signal(Math.min(REQUEST_TIMEOUT_MS, remainingMs)),
        });
    } catch {
        return { retry: true };
    }
    if (response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN) return { stop: 'refused' };
    if (response.status === HTTP_CONFLICT) {
        if (key === GITHUB_KEY) return { stop: 'no_app' };
        const body = await response.json().catch(() => ({}));
        return { stop: 'integration_required', outcome: body?.outcome ?? null };
    }
    if (response.status === HTTP_TOO_MANY || response.status >= HTTP_SERVER_ERROR) {
        return { retry: true, waitMs: retryAfterMs(response) };
    }
    if (!response.ok) return { retry: true };
    const credential = credentialOf(await response.json().catch(() => null));
    return credential ? { credential } : { retry: true };
}

/** The credential for a key: the cached one while it has more than the skew left, else a renewed one. */
async function obtain(deps, key) {
    const { env } = deps;
    // Read on every call: an adopting claim rotates the lease under a container whose env stays as it was.
    if (!env.FACTORY_STATS_URL) return fail(deps, 'no_pair');
    const pair = await deps.pair(env);
    if (!pair.jobId || !pair.leaseToken) return fail(deps, 'no_pair');
    const cached = readEntry(deps, pair, key);
    if (cached) {
        const { token, expiresAt, scopes, resource } = cached;
        return { ok: true, token, expiresAt, scopes, resource };
    }
    // A helper with its own wall-clock budget (BEL-61) passes the part it has left, never a fresh one.
    const deadline = deps.now() + (deps.deadlineMs ?? DEADLINE_MS);
    let backoff = BACKOFF_MS;
    while (deps.now() < deadline) {
        const answer = await ask(deps, pair, key, deadline - deps.now());
        if (answer.credential) {
            const { token, expiresAt, scopes, resource } = answer.credential;
            writeEntry(deps, pair, key, { token, expiresAt, scopes, resource });
            return answer.credential;
        }
        if (answer.stop) return fail(deps, answer.stop, answer.outcome === undefined ? {} : { outcome: answer.outcome });
        const wait = answer.waitMs ?? backoff;
        if (answer.waitMs !== null && answer.waitMs !== undefined && deps.now() + wait >= deadline) {
            return fail(deps, 'rate_limited');
        }
        if (deps.now() + wait >= deadline) break;
        await deps.sleep(wait);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
    return fail(deps, 'unreachable');
}

/**
 * A managed connection's credential, for a connection helper (BEL-61) to hand its tool. A typed
 * stop is a result, never a throw; `exitCodeOf` maps it to the helper's exit status.
 */
function connectionCredential(id, deps = defaultDeps()) {
    if (typeof id !== 'string' || !ID.test(id)) return Promise.resolve(fail(deps, 'bad_request'));
    return obtain(deps, connectionKey(id));
}

const exitCodeOf = (result) => {
    if (result.ok) return 0;
    return result.reason === 'integration_required' ? EXIT_INTEGRATION_REQUIRED : 1;
};

/** Drops the entries of one key, whichever pair wrote them: git found the credential rejected. */
function erase(deps, key) {
    for (const name of listEntries(deps).names) {
        const file = path.join(deps.dir, name);
        try {
            if (JSON.parse(fs.readFileSync(file, 'utf8')).key !== key) continue;
        } catch {
            // Unreadable: not provably this key's, so left for `clear`.
            continue;
        }
        fs.rmSync(file, { force: true });
    }
}

/** The directory's file names; ENOENT/ENOTDIR is an absent cache, anything else an unreadable one. */
function listEntries(deps) {
    try {
        return { names: fs.readdirSync(deps.dir), unreadable: false };
    } catch (error) {
        const absent = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
        return { names: [], unreadable: !absent };
    }
}

/** One revoke of one token, within the revoke cap. Whatever the answer, the caller removes its entry. */
async function revoke(deps, pair, token) {
    try {
        await deps.fetch(`${deps.env.FACTORY_STATS_URL.replace(/\/+$/, '')}/api/jobs/${pair.jobId}/credentials/github/revoke`, {
            method: 'POST',
            headers: { ...pairHeaders(pair), 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
            signal: deps.signal(REVOKE_DEADLINE_MS),
        });
    } catch {
        // The token then lives until its own expiry; the entry is removed regardless.
    }
}

/**
 * The attempt's end: revokes each cached GitHub token once, through the board (the pair names the
 * attempt; possession of the token is the authority), then removes every entry. No cache is no
 * call; an unreadable entry is no call either, but it is still removed and reported (exit 1).
 */
async function clear(deps) {
    const { names, unreadable: unreadableDir } = listEntries(deps);
    let unreadable = unreadableDir;
    const tokens = [];
    for (const name of names) {
        try {
            const entry = JSON.parse(fs.readFileSync(path.join(deps.dir, name), 'utf8'));
            if (entry.key === GITHUB_KEY && typeof entry.token === 'string') tokens.push(entry.token);
        } catch (error) {
            if (!(error && error.code === 'ENOENT')) unreadable = true;
        }
    }
    const pair = tokens.length && deps.env.FACTORY_STATS_URL ? await deps.pair(deps.env) : null;
    if (pair?.jobId && pair.leaseToken) {
        for (const token of new Set(tokens)) await revoke(deps, pair, token);
    }
    for (const name of names) fs.rmSync(path.join(deps.dir, name), { force: true });
    if (unreadable) {
        deps.stderr('credential-broker: the credential cache was unreadable; it was removed and nothing was revoked.');
        return 1;
    }
    return 0;
}

/** The real process's dependencies. */
function defaultDeps(env = process.env) {
    return {
        env,
        pair: currentPair,
        dir: CACHE_DIR,
        now: Date.now,
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        signal: (ms) => AbortSignal.timeout(ms),
        stderr: (line) => process.stderr.write(`${line}\n`),
    };
}

module.exports = {
    obtain,
    connectionCredential,
    connectionKey,
    clear,
    erase,
    exitCodeOf,
    defaultDeps,
    GITHUB_KEY,
    CACHE_DIR,
    RENEW_SKEW_MS,
    NULL_EXPIRY_CAP_MS,
    DEADLINE_MS,
    REQUEST_TIMEOUT_MS,
    REVOKE_DEADLINE_MS,
    EXIT_INTEGRATION_REQUIRED,
};
