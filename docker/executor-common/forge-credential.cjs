#!/usr/bin/env node
'use strict';
/*
 * The runner's forge tokens (docs/connections.md). No token rides the runner's env: this helper is
 * the git and gh front end of `credential-broker.cjs`, which asks the board's credential endpoint
 * for one with the attempt pair, caches it per host on memory-backed storage and renews it ahead of
 * its expiry, so a run that outlives a token's hour still pushes.
 *
 *   node forge-credential.cjs git get       git's credential protocol: the answer on stdout
 *   node forge-credential.cjs git erase     git found the credential rejected: drop that host's cache
 *   node forge-credential.cjs token [host]  the token alone on stdout (github.com by default, for the gh wrapper)
 *   node forge-credential.cjs hosts         the hosts it answers, one per line, for the entrypoint's git config
 *   node forge-credential.cjs clear         revoke the cached GitHub token and remove the cache, at the entrypoint's exit
 *
 * It answers https only, and only the hosts the task holds a credential for: github.com (the App's
 * installation token, as `x-access-token`) and each host RUNNER_FORGE_HOSTS names, set by the driver
 * for a GitLab task (the starting member's grant, as `oauth2`). Any other request is declined in
 * silence, with no board call: the pair is never sent on another host's behalf.
 *
 * Reads FACTORY_STATS_URL (the board) and the attempt pair through `attempt-pair.cjs`: the container's
 * RUNNER_JOB_ID and RUNNER_LEASE_TOKEN, with the lease the supervisor names now.
 * The token goes to stdout and nowhere else — stdout is the channel git and the wrapper read — and
 * never to stderr, which carries only guidance a person can act on. A refusal exits non-zero
 * (EXIT_WAITING while the task waits for the member to link GitLab again), and git then falls back
 * to no credential.
 *
 * One file, built into both executor images (driver/test/executor-images.test.ts).
 */
const broker = require('./credential-broker.cjs');

const { CACHE_DIR, RENEW_SKEW_MS, GITHUB_KEY } = broker;

const GITHUB_HOST = 'github.com';
/** The env the driver names a GitLab task's hosts in, comma-separated. */
const FORGE_HOSTS_ENV = 'RUNNER_FORGE_HOSTS';
const USERNAME = { github: 'x-access-token', gitlab: 'oauth2' };

/** github.com, then each valid host RUNNER_FORGE_HOSTS names, normalized and once each; an invalid entry is ignored. */
function configuredHosts(env) {
    const named = String(env[FORGE_HOSTS_ENV] ?? '')
        .split(',')
        .map((entry) => broker.normalizeHost(entry.trim()))
        .filter((host) => host !== null);
    return [...new Set([GITHUB_HOST, ...named])];
}

/** The broker key of a host this task holds a credential for, or null for any other. */
function hostKey(env, host) {
    const normalized = broker.normalizeHost(host);
    if (normalized === null || !configuredHosts(env).includes(normalized)) return null;
    return normalized === GITHUB_HOST ? GITHUB_KEY : broker.forgeKey(normalized);
}

/** The token for git and gh: the host's token, or null with its guidance already on stderr. */
async function obtain(deps, host = GITHUB_HOST) {
    const key = hostKey(deps.env, host);
    if (key === null) return null;
    const result = await broker.obtain(deps, key);
    return result.ok ? result.token : null;
}

/** git's request on stdin: `key=value` lines up to a blank one. The key of its host when it asks https, else null. */
function requestKey(env, input) {
    const fields = Object.fromEntries(
        input
            .split('\n')
            .filter((line) => line.includes('='))
            .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
    );
    return fields.protocol === 'https' ? hostKey(env, fields.host) : null;
}

async function main(argv, deps) {
    const [mode, operation] = argv;
    if (mode === 'clear') return broker.clear(deps);
    if (mode === 'hosts') {
        deps.stdout(`${configuredHosts(deps.env).join('\n')}\n`);
        return 0;
    }
    if (mode === 'token') {
        const key = hostKey(deps.env, operation ?? GITHUB_HOST);
        if (key === null) {
            deps.stderr('forge-credential: this task holds no credential for that host.');
            return 1;
        }
        const result = await broker.obtain(deps, key);
        if (!result.ok) return broker.exitCodeOf(result);
        deps.stdout(`${result.token}\n`);
        return 0;
    }
    if (mode === 'git') {
        const key = requestKey(deps.env, await deps.stdin());
        if (operation === 'erase') {
            if (key !== null && !broker.erase(deps, key)) {
                deps.stderr('forge-credential: the credential cache could not be confirmed cleared of a rejected credential.');
                return 1;
            }
            return 0;
        }
        if (operation !== 'get' || key === null) return 0;
        const result = await broker.obtain(deps, key);
        if (!result.ok) return broker.exitCodeOf(result);
        const username = key === GITHUB_KEY ? USERNAME.github : USERNAME.gitlab;
        deps.stdout(`username=${username}\npassword=${result.token}\n`);
        return 0;
    }
    deps.stderr('usage: forge-credential.cjs git <get|store|erase> | token [host] | hosts | clear');
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
        process.stdin.on('close', () => resolve(data));
    });

if (require.main === module) {
    main(process.argv.slice(2), {
        ...broker.defaultDeps(),
        stdin: readStdin,
        stdout: (text) => process.stdout.write(text),
    }).then(
        (code) => {
            process.exitCode = code;
        },
        () => {
            process.stderr.write('forge-credential: failed unexpectedly; git and gh run without a credential.\n');
            process.exitCode = 1;
        }
    );
}

module.exports = { main, obtain, configuredHosts, hostKey, CACHE_DIR, RENEW_SKEW_MS };
