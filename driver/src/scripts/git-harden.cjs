'use strict';

// The hardened `git` every driver-side step runs (the shim the task supervisor puts first on its
// children's PATH). A checkout is written by the agent's tool uid, so its `.git/config`,
// `.git/hooks`, `.git/info/attributes`, `.gitattributes` and hook directory are not the driver's
// own: git run as the supervisor's uid must not execute anything they name.
//
// Each call is `git <hardening> <the caller's argv>`:
//   - a fixed set of execution-capable settings is pinned on the command line, which outranks every
//     config file: the trusted (system/global) value when one exists, otherwise an inert one;
//     `core.hooksPath` and `core.fsmonitor` are pinned off whatever the trusted config says;
//   - the same families that take any name (`filter.*`, `diff.*`, `merge.*`, `pager.*`, `trailer.*`)
//     are pinned for every name the checkout's own config files (local, worktree and
//     whatever they include) define, so a name only the checkout knows is never run;
//   - every credential helper the checkout names is dropped, the trusted ones kept, so a helper that
//     the checkout wrote never receives the token a push carries;
//   - `--no-pager`, `--no-ext-diff` and `--no-textconv` close the diff drivers a setting cannot
//     blank, and the editor, pager and protocol environment is pinned.
// The caller's own `-c` follow the hardening, so the driver can still choose its credential helper.
// A config the shim cannot read is a refused call (exit 126), never an unhardened one.
//
// Not covered, by design: a driver named in `.gitattributes` and defined in the TRUSTED config
// (git-lfs) still runs, and a config write landing between the one read of the config this makes
// and the real git's own read goes unseen.

const { spawnSync } = require('node:child_process');

const REFUSED_EXIT = 126;
/** The scopes git reports for config the driver's own image and home define. */
const TRUSTED_SCOPES = new Set(['system', 'global']);
/** The scopes whose files the tool uid can write: the checkout's own config. */
const CHECKOUT_SCOPES = new Set(['local', 'worktree']);
const DIFF_COMMANDS = new Set(['diff', 'log', 'show']);
const PROTOCOLS = 'https:http:git:file';
const CONFIG_MAX_BUFFER = 67_108_864;

/** Pinned whatever the trusted config says. */
const PINNED = [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', '/dev/null'],
];
/** Pinned to the trusted value when there is one, else to this. */
const INERT = [
    ['core.pager', 'cat'],
    ['core.editor', 'true'],
    ['sequence.editor', 'true'],
    ['core.sshCommand', 'false'],
    ['core.askPass', ''],
    ['core.gitProxy', ''],
    ['gpg.program', ''],
    ['gpg.openpgp.program', ''],
    ['gpg.x509.program', ''],
    ['gpg.ssh.program', ''],
    ['gpg.ssh.defaultKeyCommand', ''],
    ['commit.gpgSign', 'false'],
    ['tag.gpgSign', 'false'],
    ['push.gpgSign', 'false'],
];
/**
 * The families that take any name: section -> variable -> the inert value a variable falls back to
 * when the trusted config does not set it. Only a variable the checkout itself defines is pinned: an
 * empty `filter.<name>.process` is a filter that fails, which would also silence a trusted `clean`.
 */
const FAMILIES = {
    filter: { clean: '', smudge: '', process: '', required: 'false' },
    // A checkout-defined driver pinned to `true` yields an empty diff: fail-closed, and `--no-ext-diff` rarely lets it run.
    diff: { command: 'true', textconv: 'cat' },
    merge: { driver: 'false' },
    trailer: { cmd: '', command: '' },
};
/**
 * Settings no command line outranks: git takes the FIRST `remote.<name>.uploadpack` it reads (a `-c`
 * comes last, and git only warns), and a `remote.<name>.vcs` names the remote helper to run. A
 * checkout that sets one is refused outright; nobody has a reason to.
 */
const REFUSED = /^remote\..+\.(receivepack|uploadpack|vcs)$/;
const CREDENTIAL_HELPER = /^credential\.(?:.+\.)?helper$/;

/** `git config --list -z --show-scope` output as `{ scope, key, value }` entries. */
function parseList(buffer) {
    const fields = buffer.toString('utf8').split('\0');
    const entries = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
        const [key, ...rest] = fields[i + 1].split('\n');
        entries.push({ scope: fields[i], key, value: rest.join('\n') });
    }
    return entries;
}

/** The last trusted value of `key`, or undefined. Keys compare as git prints them: lower-cased but for the subsection. */
function trustedValue(entries, key) {
    let found;
    for (const entry of entries) {
        if (TRUSTED_SCOPES.has(entry.scope) && entry.key.toLowerCase() === key.toLowerCase()) found = entry.value;
    }
    return found;
}

/** The keys of the checkout's own config that make a call refused, in the order read. */
function refusalsOf(entries) {
    return entries.filter((e) => CHECKOUT_SCOPES.has(e.scope) && REFUSED.test(e.key.toLowerCase())).map((e) => e.key);
}

/** The `-c` pair that pins one variable the checkout defines of a family that takes any name, or null. */
function familyPair(entry) {
    const first = entry.key.indexOf('.');
    const last = entry.key.lastIndexOf('.');
    const section = entry.key.slice(0, first).toLowerCase();
    if (section === 'pager' && first === last) return [entry.key, 'false'];
    // Any value here, even an empty one, silences `diff --submodule=diff`, so it is pinned only where the
    // checkout sets it; `--no-ext-diff` and the dropped GIT_EXTERNAL_DIFF cover the rest.
    if (entry.key.toLowerCase() === 'diff.external') return [entry.key, 'true'];
    if (!Object.hasOwn(FAMILIES, section) || last <= first) return null;
    const variable = entry.key.slice(last + 1).toLowerCase();
    return Object.hasOwn(FAMILIES[section], variable) ? [entry.key, FAMILIES[section][variable]] : null;
}

/**
 * The `-c` pairs that harden one call, given the config it would read. Pure: `entries` is
 * the parsed `git config --list --includes --show-scope`.
 */
function hardeningPairs(entries) {
    const pairs = [];
    for (const [key, inert] of INERT) pairs.push([key, trustedValue(entries, key) ?? inert]);
    pairs.push(...PINNED);

    // Credential helpers: reset, then the trusted ones back, in their own order.
    pairs.push(['credential.helper', '']);
    for (const entry of entries) {
        if (TRUSTED_SCOPES.has(entry.scope) && CREDENTIAL_HELPER.test(entry.key.toLowerCase())) {
            pairs.push([entry.key, entry.value]);
        }
    }

    // The families that take any name: every variable the checkout's own config defines.
    const named = new Map();
    for (const entry of entries) {
        const pair = CHECKOUT_SCOPES.has(entry.scope) ? familyPair(entry) : null;
        if (pair) named.set(pair[0], pair[1]);
    }
    for (const [name, inert] of named) pairs.push([name, trustedValue(entries, name) ?? inert]);
    return pairs;
}

/**
 * Splits the caller's argv at its subcommand: the global options before it (what the config read
 * must repeat, so it reads the same repository) and the subcommand's index.
 */
function globalOptions(args) {
    const repeated = [];
    let i = 0;
    for (; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree') {
            repeated.push(arg, args[i + 1] ?? '');
            i += 1;
        } else if (arg === '-c' || arg === '--namespace' || arg === '--exec-path') {
            i += 1;
        } else if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
            repeated.push(arg);
        } else if (!arg.startsWith('-')) {
            break;
        }
    }
    return { repeated, index: i };
}

/** `git`'s own environment pinned: editors, pager, external diff, and the protocols a remote may speak. */
function hardenedEnv(env) {
    // `core.gitProxy` is first-match-wins across the config files, so the checkout's beats a `-c`; the
    // environment variable outranks every file, and an empty one means no proxy.
    const next = { ...env, GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_PAGER: 'cat', GIT_PROXY_COMMAND: '' };
    delete next.GIT_EXTERNAL_DIFF;
    delete next.GIT_SSH;
    delete next.GIT_SSH_COMMAND;
    if (next.GIT_ALLOW_PROTOCOL === undefined) next.GIT_ALLOW_PROTOCOL = PROTOCOLS;
    return next;
}

/**
 * The hardened argv and environment for one call of `git` with `args`, or throws when the config
 * the call would read cannot be read.
 */
function harden(realGit, args, options) {
    const env = options.env;
    const { repeated, index } = globalOptions(args);
    const listed = spawnSync(realGit, [...repeated, 'config', '--list', '--includes', '--show-scope', '-z'], {
        cwd: options.cwd,
        env,
        maxBuffer: CONFIG_MAX_BUFFER,
    });
    if (listed.error || listed.status !== 0) {
        throw new Error(
            `git config could not be read: ${listed.error?.message ?? listed.stderr?.toString('utf8').trim()}`
        );
    }
    const entries = parseList(listed.stdout);
    const refused = refusalsOf(entries);
    if (refused.length > 0)
        throw new Error(`the checkout's config sets ${refused.join(', ')}, which names a command to run`);
    const prefix = ['--no-pager'];
    for (const [key, value] of hardeningPairs(entries)) prefix.push('-c', `${key}=${value}`);
    const hardened = [...prefix, ...args];
    if (DIFF_COMMANDS.has(args[index])) hardened.splice(prefix.length + index + 1, 0, '--no-ext-diff', '--no-textconv');
    return { argv: hardened, env: hardenedEnv(env) };
}

/** The shim: `git-harden.cjs` copied as `git`, `GIT_HARDEN_REAL` naming the git it fronts. */
function main() {
    const real = process.env.GIT_HARDEN_REAL;
    if (!real) {
        process.stderr.write('git: the hardened git has no real git to run\n');
        return REFUSED_EXIT;
    }
    const env = { ...process.env };
    delete env.GIT_HARDEN_REAL;
    let plan;
    try {
        plan = harden(real, process.argv.slice(2), { cwd: process.cwd(), env });
    } catch (error) {
        process.stderr.write(`git: refused, ${error.message}\n`);
        return REFUSED_EXIT;
    }
    const ran = spawnSync(real, plan.argv, { env: plan.env, stdio: 'inherit' });
    if (ran.error) {
        process.stderr.write(`git: ${ran.error.message}\n`);
        return REFUSED_EXIT;
    }
    if (ran.signal) process.kill(process.pid, ran.signal);
    return ran.status ?? REFUSED_EXIT;
}

module.exports = { harden, hardeningPairs, refusalsOf, parseList, globalOptions, hardenedEnv, REFUSED_EXIT };

if (require.main === module) process.exitCode = main();
