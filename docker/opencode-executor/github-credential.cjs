#!/usr/bin/env node
'use strict';
/*
 * The runner's GitHub token (docs/connections.md). No token rides the runner's env: this helper
 * asks the board's credential endpoint for one with the attempt pair, caches it on memory-backed
 * storage, and renews it ahead of its expiry, so a run that outlives a token's hour still pushes.
 *
 *   node github-credential.cjs git get     git's credential protocol: the answer on stdout
 *   node github-credential.cjs git erase   git found the credential rejected: drop the cache
 *   node github-credential.cjs token       the token alone on stdout, for the gh wrapper
 *   node github-credential.cjs clear       remove the cache, at the entrypoint's exit
 *
 * Reads FACTORY_STATS_URL (the board) and the attempt pair through `attempt-pair.cjs`: the container's
 * RUNNER_JOB_ID and RUNNER_LEASE_TOKEN, with the lease the supervisor names now (#1045).
 * The token goes to stdout and nowhere else — stdout is the channel git and the wrapper read — and
 * never to stderr, which carries only guidance a person can act on. A refusal exits non-zero, and
 * git then falls back to no credential.
 *
 * Kept byte-identical in both executor images (driver/test/executor-images.test.ts).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { currentPair } = require('./attempt-pair.cjs');

/** Memory-backed in both executors: docker `--tmpfs`, kubernetes `emptyDir: {medium: Memory}`. */
const CACHE_DIR = '/run/factory-github';
const CACHE_FILE = 'token.json';
/** Renewed this long before GitHub's `expires_at`, so no git or gh call starts on a dying token. */
const RENEW_SKEW_MS = 5 * 60 * 1000;
/** Asks of the board, at most, before giving up: an unreachable board must not hang a push. */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_SERVER_ERROR = 500;
const HTTP_TOO_MANY = 429;

const GUIDANCE = {
    pair:
        'github-credential: this container holds no attempt credential (FACTORY_STATS_URL, RUNNER_JOB_ID, ' +
        'RUNNER_LEASE_TOKEN), so there is no GitHub token here.',
    refused:
        'github-credential: the board refused this attempt a GitHub token: the call carried a lease this attempt ' +
        'no longer holds, or its task is no longer authorized (its author left the organization). Each call ' +
        'reads the current pair: retry once, and if a fresh call is refused the same way, report it. A later ' +
        'turn may succeed.',
    noApp:
        'github-credential: the board holds no GitHub App installation for this organization, so it issues no ' +
        'GitHub token. Ask an admin to install the App; git and gh run without a credential until then.',
    unreachable:
        'github-credential: the board did not issue a GitHub token after several tries. git and gh run without ' +
        'a credential; retry the step shortly.',
};

/** The attempt the cache belongs to: a cache written under another pair is never read. */
const attemptOf = (pair) => crypto.createHash('sha256').update(`${pair.jobId}|${pair.leaseToken}`).digest('hex');

function readCache(deps, pair) {
    try {
        const cached = JSON.parse(fs.readFileSync(path.join(deps.dir, CACHE_FILE), 'utf8'));
        if (cached.attempt !== attemptOf(pair) || typeof cached.token !== 'string') return null;
        const expires = Date.parse(cached.expiresAt);
        return Number.isFinite(expires) && deps.now() < expires - RENEW_SKEW_MS ? cached.token : null;
    } catch {
        return null;
    }
}

/**
 * Written whole or not at all, 0600, in a directory narrowed to 0700 where this user owns it (the
 * docker tmpfs is mounted so; a kubernetes emptyDir stays the kubelet's, mounted in this container
 * alone). A directory this user cannot write is no cache.
 */
function writeCache(deps, pair, token, expiresAt) {
    try {
        fs.mkdirSync(deps.dir, { recursive: true, mode: DIR_MODE });
        try {
            fs.chmodSync(deps.dir, DIR_MODE);
        } catch {
            // Not ours to narrow; the file's own mode still holds.
        }
        const file = path.join(deps.dir, CACHE_FILE);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ token, expiresAt, attempt: attemptOf(pair) }), {
            mode: FILE_MODE,
        });
        fs.renameSync(tmp, file);
    } catch {
        // Uncached is still correct: the next call asks the board again.
    }
}

function clearCache(deps) {
    fs.rmSync(path.join(deps.dir, CACHE_FILE), { force: true });
}

/** One ask of the board: a token, a refusal to stop on, or null to retry. */
async function ask(deps, pair) {
    const { env } = deps;
    const url = `${env.FACTORY_STATS_URL.replace(/\/+$/, '')}/api/jobs/${pair.jobId}/credentials/github`;
    let response;
    try {
        response = await deps.fetch(url, {
            method: 'POST',
            headers: { 'x-factory-job-id': pair.jobId, 'x-factory-job-lease-token': pair.leaseToken },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        return null;
    }
    if (response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN) return { stop: 'refused' };
    if (response.status === HTTP_CONFLICT) return { stop: 'noApp' };
    if (response.status >= HTTP_SERVER_ERROR || response.status === HTTP_TOO_MANY || !response.ok) return null;
    const body = await response.json().catch(() => ({}));
    if (typeof body.token !== 'string' || !body.token) return null;
    return { token: body.token, expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : '' };
}

/** The attempt's token: the cached one while it has more than the skew left, else a renewed one. */
async function obtain(deps) {
    const { env } = deps;
    // Read on every call: an adopting claim rotates the lease under a container whose env stays as it was.
    const pair = await deps.pair(env);
    if (!env.FACTORY_STATS_URL || !pair.jobId || !pair.leaseToken) {
        deps.stderr(GUIDANCE.pair);
        return null;
    }
    const cached = readCache(deps, pair);
    if (cached) return cached;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const answer = await ask(deps, pair);
        if (answer?.token) {
            writeCache(deps, pair, answer.token, answer.expiresAt);
            return answer.token;
        }
        if (answer?.stop) {
            deps.stderr(GUIDANCE[answer.stop]);
            return null;
        }
        if (attempt < MAX_ATTEMPTS) await deps.sleep(BACKOFF_MS * 2 ** (attempt - 1));
    }
    deps.stderr(GUIDANCE.unreachable);
    return null;
}

/** git's request on stdin: `key=value` lines up to a blank one. Only https://github.com is answered. */
function asksForGithub(input) {
    const fields = Object.fromEntries(
        input
            .split('\n')
            .filter((line) => line.includes('='))
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
    return fields.protocol === 'https' && fields.host === 'github.com';
}

async function main(argv, deps) {
    const [mode, operation] = argv;
    if (mode === 'clear') {
        clearCache(deps);
        return 0;
    }
    if (mode === 'token') {
        const token = await obtain(deps);
        if (!token) return 1;
        deps.stdout(`${token}\n`);
        return 0;
    }
    if (mode === 'git') {
        const input = await deps.stdin();
        if (operation === 'erase') {
            clearCache(deps);
            return 0;
        }
        if (operation !== 'get' || !asksForGithub(input)) return 0;
        const token = await obtain(deps);
        if (!token) return 1;
        deps.stdout(`username=x-access-token\npassword=${token}\n`);
        return 0;
    }
    deps.stderr('usage: github-credential.cjs git <get|store|erase> | token | clear');
    return 2;
}

const readStdin = () =>
    new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', () => resolve(data));
    });

if (require.main === module) {
    main(process.argv.slice(2), {
        env: process.env,
        pair: currentPair,
        dir: CACHE_DIR,
        now: Date.now,
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        stdin: readStdin,
        stdout: (text) => process.stdout.write(text),
        stderr: (line) => process.stderr.write(`${line}\n`),
    }).then(
        (code) => {
            process.exitCode = code;
        },
        () => {
            process.stderr.write('github-credential: failed unexpectedly; git and gh run without a credential.\n');
            process.exitCode = 1;
        }
    );
}

module.exports = { main, obtain, CACHE_DIR, RENEW_SKEW_MS, MAX_ATTEMPTS };
