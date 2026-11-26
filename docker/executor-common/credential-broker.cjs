'use strict';
/*
 * The runner's client of the board's credential broker (docs/connections.md). No credential rides the
 * runner's env: this module asks the board with the attempt pair, caches the answer per attempt and
 * per key on memory-backed storage, and renews it ahead of its expiry, so a run that outlives a
 * token still works. Three keys exist: `github` (POST /api/jobs/:id/credentials/github), `forge:<host>`
 * (POST /api/jobs/:id/credentials/gitlab: the task's GitLab host, which the board derives from the
 * attempt's repository, served the starting member's grant) and `connection:<id>`
 * (POST /api/jobs/:id/credentials/connections/:id), the last reached only through the
 * `connectionCredential(id)` library export — no command prints a connection token.
 *
 * One wall-clock deadline covers every request, `Retry-After` wait and backoff of a call; a refusal
 * or a typed stop ends it at once; a malformed answer is a retry, never "no credential". A takeover's
 * LEASE_PENDING extends that deadline once to 120 s from the call's start (board-call.cjs) and, unmet,
 * ends `pending`: exit 1, retry shortly. A GitLab `409 FORGE_GRANT_REQUIRED` ends `waiting`
 * (EXIT_WAITING): the task waits until the member links GitLab again. `clear` revokes the cached GitHub
 * token through the board and then removes every entry; a GitLab entry is only removed, never revoked:
 * the member's grant is shared by every task they start.
 *
 * Callers pass `deps` (see `defaultDeps`) and receive `{ok:true, token, ...}` or `{ok:false, reason}`;
 * a token goes nowhere but the result, never to stderr, which carries guidance a person can act on.
 *
 * One file, built into both executor images (driver/test/executor-images.test.ts).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { currentPair } = require('./attempt-pair.cjs');
const { boardCall, createBudget, readPair, REQUEST_TIMEOUT_MS } = require('./board-call.cjs');

/** Memory-backed in both executors: docker `--tmpfs`, kubernetes `emptyDir: {medium: Memory}`; the agent container alone. */
const CACHE_DIR = '/run/factory-credentials';
const GITHUB_KEY = 'github';
const FORGE_KEY_PREFIX = 'forge:';
const CONNECTION_KEY_PREFIX = 'connection:';
/** Renewed this long before the credential's expiry, so no call starts on a dying token. */
const RENEW_SKEW_MS = 5 * 60 * 1000;
/** A token the board names no expiry for is cached for at most this long. */
const NULL_EXPIRY_CAP_MS = 10 * 60 * 1000;
/** All requests, waits and backoff of one call: an unreachable board must not hang a push. */
const DEADLINE_MS = 30_000;
/** `clear` revokes inside this: the entrypoint's exit stays inside the docker-stop and kubernetes grace periods. */
const REVOKE_DEADLINE_MS = 3000;
const EXIT_INTEGRATION_REQUIRED = 3;
/** The member who started the task must link their GitLab account again: the task waits for it. */
const EXIT_WAITING = 4;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HTTP_OK = 200;
const HTTP_REDIRECT = 300;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;
const MS_PER_SECOND = 1000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A host as git names it, lowercased: DNS labels, and an optional port of one to five digits. */
const HOST_PARTS =
    /^((?=.{1,253}(?::|$))[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::([0-9]{1,5}))?$/;
const DEFAULT_HTTPS_PORT = '443';
const FORGE_GRANT_REQUIRED = 'FORGE_GRANT_REQUIRED';

const connectionKey = (id) => `${CONNECTION_KEY_PREFIX}${id}`;

/**
 * A host lowercased with a default `:443` dropped and any other port kept, or null where it is not one (whitespace,
 * userinfo, a path, a trailing dot). The driver's `normalizeForgeHost` (driver/src/repo-ref.ts) is the rule;
 * driver/test/forge-host-normalization.test.ts pins this copy to it.
 */
function normalizeHost(host) {
    if (typeof host !== 'string') return null;
    const parts = HOST_PARTS.exec(host.toLowerCase());
    if (!parts) return null;
    const [, name, port] = parts;
    return port === undefined || port === DEFAULT_HTTPS_PORT ? name : `${name}:${port}`;
}

/** The key of a GitLab host's credential, or null for a value that names no host. */
const forgeKey = (host) => {
    const normalized = normalizeHost(host);
    return normalized === null ? null : `${FORGE_KEY_PREFIX}${normalized}`;
};

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
    waiting:
        'credential-broker: the GitLab account of the member who started this task needs linking again before the ' +
        'board issues a GitLab credential. The task waits until the member links their GitLab account again; ' +
        'git runs without a GitLab credential until then. Do not retry.',
    rate_limited: 'credential-broker: the board asked to wait longer than this call may; retry the step shortly.',
    pending:
        'credential-broker: this task was taken over and its new lease had not reached this container in time; ' +
        'git and gh run without a credential. Retry the step shortly.',
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

/** `Retry-After` in seconds, as milliseconds; null where absent or not a plain count. */
function retryAfterMs(headers) {
    const value = headers.get('retry-after');
    return value && /^\d{1,6}$/.test(value.trim()) ? Number(value) * MS_PER_SECOND : null;
}

/** The credential routes' answer: a credential, a stop, or a retry (after `Retry-After` where the board names one). */
const classifyFor = (key) => (answer) => {
    if (answer.status === HTTP_UNAUTHORIZED || answer.status === HTTP_FORBIDDEN) return { done: { stop: 'refused' } };
    if (answer.status === HTTP_CONFLICT) {
        if (key === GITHUB_KEY) return { done: { stop: 'no_app' } };
        if (key.startsWith(FORGE_KEY_PREFIX)) {
            if (answer.json?.code !== FORGE_GRANT_REQUIRED) return { retry: true };
            const connectUrl = typeof answer.json.connectUrl === 'string' ? answer.json.connectUrl : undefined;
            return { done: { stop: 'waiting', outcome: 'waiting', ...(connectUrl ? { connectUrl } : {}) } };
        }
        return { done: { stop: 'integration_required', outcome: answer.json?.outcome ?? null } };
    }
    if (answer.status === HTTP_TOO_MANY || answer.status >= HTTP_SERVER_ERROR) {
        return { retry: true, waitMs: retryAfterMs(answer.headers) };
    }
    if (answer.status < HTTP_OK || answer.status >= HTTP_REDIRECT) return { retry: true };
    const credential = credentialOf(answer.json);
    return credential ? { done: { credential } } : { retry: true };
};

const pathOf = (key) => {
    if (key === GITHUB_KEY) return '/credentials/github';
    if (key.startsWith(FORGE_KEY_PREFIX)) return '/credentials/gitlab';
    return `/credentials/connections/${key.slice(CONNECTION_KEY_PREFIX.length)}`;
};

const UNSETTLED = { no_pair: 'no_pair', rate_limited: 'rate_limited', deadline: 'unreachable', pending: 'pending' };

/** The credential for a key: the cached one while it has more than the skew left, else a renewed one. */
async function obtain(deps, key) {
    // Read on every call, and by `boardCall` on every try: an adopting claim rotates the lease under a container
    // whose env stays as it was, and a try made under the superseded lease is answered pending until the relayed
    // pair is read.
    const pair = await readPair(deps);
    if (!pair) return fail(deps, 'no_pair');
    const cached = readEntry(deps, pair, key);
    if (cached) {
        const { token, expiresAt, scopes, resource } = cached;
        return { ok: true, token, expiresAt, scopes, resource };
    }
    // A helper with its own wall-clock budget passes that budget (`deps.budget`), never a fresh one: a pending wait
    // spends from the one ceiling the helper's invocation has.
    const budget = deps.budget ?? createBudget({ now: deps.now, baseMs: DEADLINE_MS });
    const result = await boardCall(deps, budget, { method: 'POST', path: pathOf(key), classify: classifyFor(key) });
    if (!result.ok) return fail(deps, UNSETTLED[result.reason]);
    const answer = result.value;
    if (answer.stop) {
        const { stop, ...extra } = answer;
        return fail(deps, stop, extra.outcome === undefined ? {} : extra);
    }
    const { token, expiresAt, scopes, resource } = answer.credential;
    writeEntry(deps, result.pair, key, { token, expiresAt, scopes, resource });
    return answer.credential;
}

/**
 * A managed connection's credential, for a connection helper to hand its tool. A typed
 * stop is a result, never a throw; `exitCodeOf` maps it to the helper's exit status.
 */
function connectionCredential(id, deps = defaultDeps()) {
    if (typeof id !== 'string' || !ID.test(id)) return Promise.resolve(fail(deps, 'bad_request'));
    return obtain(deps, connectionKey(id));
}

const exitCodeOf = (result) => {
    if (result.ok) return 0;
    if (result.reason === 'waiting') return EXIT_WAITING;
    return result.reason === 'integration_required' ? EXIT_INTEGRATION_REQUIRED : 1;
};

/**
 * Drops the entries of one key, whichever pair wrote them: git found the credential rejected. True only when every
 * entry of the key is confirmed gone; a cache that cannot be listed, an entry that cannot be read or one that will
 * not go leaves a rejected credential possibly served again, which is false here and never a quiet success.
 */
function erase(deps, key) {
    const { names, unreadable } = listEntries(deps);
    let confirmed = !unreadable;
    for (const name of names) {
        const file = path.join(deps.dir, name);
        try {
            if (JSON.parse(fs.readFileSync(file, 'utf8')).key !== key) continue;
        } catch (error) {
            // Gone meanwhile: nothing to drop. Unreadable or malformed: not provably this key's, so unconfirmed.
            if (!(error && error.code === 'ENOENT')) confirmed = false;
            continue;
        }
        try {
            fs.rmSync(file, { force: true });
        } catch {
            confirmed = false;
        }
    }
    return confirmed;
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

/** One revoke of one token, within the revoke cap, never retried. Whatever the answer, the caller removes its entry. */
async function revoke(deps, token) {
    // A failure leaves the token to its own expiry; the entry is removed regardless.
    // The revoke route never answers pending, and teardown must not wait out a takeover: no window past the cap.
    await boardCall(deps, createBudget({ now: deps.now, baseMs: REVOKE_DEADLINE_MS, pendingWindowMs: REVOKE_DEADLINE_MS }), {
        method: 'POST',
        path: '/credentials/github/revoke',
        body: { token },
        classify: () => ({ done: true }),
        once: true,
    });
}

/**
 * The attempt's end: revokes each cached GitHub token once, through the board (the pair names the
 * attempt; possession of the token is the authority), then removes every entry. A GitLab entry is
 * removed with no call: its token is the member's own grant, shared with their other tasks. No cache
 * is no call; an unreadable entry is no call either, but it is still removed and reported (exit 1).
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
    for (const token of new Set(tokens)) await revoke(deps, token);
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
    forgeKey,
    normalizeHost,
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
    EXIT_WAITING,
};
