#!/usr/bin/env node
'use strict';
/*
 * The runner's GitHub token (docs/connections.md). No token rides the runner's env: this helper is
 * the git and gh front end of `credential-broker.cjs`, which asks the board's credential endpoint
 * for one with the attempt pair, caches it on memory-backed storage and renews it ahead of its
 * expiry, so a run that outlives a token's hour still pushes.
 *
 *   node github-credential.cjs git get     git's credential protocol: the answer on stdout
 *   node github-credential.cjs git erase   git found the credential rejected: drop the cache
 *   node github-credential.cjs token       the token alone on stdout, for the gh wrapper
 *   node github-credential.cjs clear       revoke the cached token and remove the cache, at the entrypoint's exit
 *
 * Reads FACTORY_STATS_URL (the board) and the attempt pair through `attempt-pair.cjs`: the container's
 * RUNNER_JOB_ID and RUNNER_LEASE_TOKEN, with the lease the supervisor names now (#1045).
 * The token goes to stdout and nowhere else — stdout is the channel git and the wrapper read — and
 * never to stderr, which carries only guidance a person can act on. A refusal exits non-zero, and
 * git then falls back to no credential.
 *
 * Kept byte-identical in both executor images (driver/test/executor-images.test.ts).
 */
const broker = require('./credential-broker.cjs');

const { CACHE_DIR, RENEW_SKEW_MS, GITHUB_KEY } = broker;

/** The token for git and gh: the broker's answer, or null with its guidance already on stderr. */
async function obtain(deps) {
    const result = await broker.obtain(deps, GITHUB_KEY);
    return result.ok ? result.token : null;
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
    if (mode === 'clear') return broker.clear(deps);
    if (mode === 'token') {
        const token = await obtain(deps);
        if (!token) return 1;
        deps.stdout(`${token}\n`);
        return 0;
    }
    if (mode === 'git') {
        const input = await deps.stdin();
        if (operation === 'erase') {
            broker.erase(deps, GITHUB_KEY);
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
            process.stderr.write('github-credential: failed unexpectedly; git and gh run without a credential.\n');
            process.exitCode = 1;
        }
    );
}

module.exports = { main, obtain, CACHE_DIR, RENEW_SKEW_MS };
