import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    closeSync,
    constants,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFactsCache } from '../src/workspace/facts.js';

/** Lets the cache's single-flight refresh promise settle: the reads are real subprocesses, so the loop must reach the timer phase, not just the microtask queue. */
const settle = async () => {
    while (cache.get(dir, dirname(dir)).sizeBytes === null) await new Promise((r) => setTimeout(r, 5));
};

const gitIn = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@f.io', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
        cwd,
        encoding: 'utf8',
    });

/** A fresh one-commit checkout inside a fresh member root. */
function memberCheckout(prefix: string): { member: string; checkout: string } {
    const member = mkdtempSync(join(tmpdir(), prefix));
    const checkout = join(member, 'web');
    gitIn(member, ['init', '-q', '-b', 'main', checkout]);
    writeFileSync(join(checkout, 'file.txt'), 'one\n');
    gitIn(checkout, ['add', '.']);
    gitIn(checkout, ['commit', '-q', '-m', 'victim secret headline']);
    return { member, checkout };
}

/** Polls a fresh cache until its refresh lands, or gives up: a refused read stays all-null. */
async function factsOf(dir: string, root: string) {
    const fresh = createFactsCache();
    fresh.get(dir, root);
    for (let i = 0; i < 100; i += 1) await new Promise((r) => setTimeout(r, 5));
    return fresh.get(dir, root);
}

/**
 * The facts cache against a real git checkout — the branch and commit reads are one `git log`, and
 * faking git here would test the fake. The suite builds one bare-fixture checkout of its own, the
 * same way workspace.reconcile.test.ts does, with every identity pinned on the command line so the
 * runner's global git config cannot leak in.
 */

let dir = '';
let cache: ReturnType<typeof createFactsCache>;

beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-facts-'));
    const run = (args: string[], cwd?: string) =>
        execFileSync('git', ['-c', 'user.email=t@f.io', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
            cwd,
        });
    run(['init', '-b', 'main', dir]);
    writeFileSync(join(dir, 'file.txt'), 'one\n');
    run(['add', '.'], dir);
    run(['commit', '-m', 'first'], dir);
    cache = createFactsCache();
});

afterAll(() => {
    execFileSync('rm', ['-rf', '--', dir]);
});

describe('the facts cache', () => {
    it('measures a real checkout once the refresh settles', async () => {
        const facts = cache.get(dir, dirname(dir));
        // Cold: nothing has been measured yet, and none of it is awaited.
        expect(facts.sizeBytes).toBeNull();
        await settle();
        const measured = cache.get(dir, dirname(dir));
        expect(measured.sizeBytes).toBeGreaterThan(0);
        expect(measured.branch).toBe('main');
        expect(measured.lastCommit?.headline).toBe('first');
        // The commit and instant `git log` prints, which is what the payload carried before. The
        // instant, not the string: newer git spells a UTC `%cI` as `Z`, older as `+00:00`.
        const [sha, at] = gitIn(dir, ['log', '-1', '--format=%H%x00%cI']).trim().split('\0');
        expect(measured.lastCommit?.sha).toBe(sha);
        expect(Date.parse(measured.lastCommit?.at ?? '')).toBe(Date.parse(at ?? ''));
    });

    it("keeps the committer's own offset, as `%cI` does", async () => {
        const { member, checkout } = memberCheckout('factory-offset-');
        execFileSync(
            'git',
            ['-c', 'user.email=t@f.io', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'later'],
            {
                cwd: checkout,
                env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-02T03:04:05-0730' },
            }
        );
        const facts = await factsOf(checkout, member);
        expect(facts.lastCommit?.at).toBe('2026-01-02T03:04:05-07:30');
        expect(facts.lastCommit?.headline).toBe('later');
    });

    it('forgets a directory it is told to invalidate', async () => {
        cache.get(dir, dirname(dir));
        await settle();
        expect(cache.get(dir, dirname(dir)).sizeBytes).toBeGreaterThan(0);

        cache.invalidate(dir);
        const cold = cache.get(dir, dirname(dir));
        // A deleted tree's facts must not survive it: the next get is a cold entry, so a
        // re-cloned checkout can never briefly show its predecessor's size or commit.
        expect(cold).toEqual({ branch: null, lastCommit: null, sizeBytes: null });
    });

    // Issue #734: the per-repo package cache is a size reading only — no git, and null until measured.
    it('measures a size-only directory, null while cold or absent', async () => {
        const sized = createFactsCache();
        const root = dirname(dir);
        expect(sized.sizeOf(dir, root)).toBeNull();
        while (sized.sizeOf(dir, root) === null) await new Promise((r) => setTimeout(r, 5));
        expect(sized.sizeOf(dir, root)).toBeGreaterThan(0);

        const missing = join(dir, 'no-such-cache');
        sized.sizeOf(missing, root);
        for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(sized.sizeOf(missing, root)).toBeNull();
    });

    it('measures a cache directory as soon as it appears, not a size TTL later', async () => {
        const sized = createFactsCache();
        const late = join(dir, 'late-cache');
        sized.sizeOf(late, dir);
        for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(sized.sizeOf(late, dir)).toBeNull();

        // A run creates the cache: the absent reading must not be held for the five-minute TTL.
        mkdirSync(late);
        writeFileSync(join(late, 'pkg'), 'x'.repeat(4096));
        for (let i = 0; i < 400 && sized.sizeOf(late, dir) === null; i += 1) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(sized.sizeOf(late, dir)).toBeGreaterThan(0);
    });

    // The cache path runs through directories a member's agent can write: a symlink there must
    // never make the board (which sees every org's tree) measure a directory outside the member's.
    it.each([
        ['an intermediate component', (member: string, victim: string) => symlinkSync(victim, join(member, '.cache'))],
        [
            'the final component',
            (member: string, victim: string) => {
                mkdirSync(join(member, '.cache', 'acme'), { recursive: true });
                symlinkSync(join(victim, 'acme', 'web'), join(member, '.cache', 'acme', 'web'));
            },
        ],
    ])('never measures through a symlink in %s that leaves the member tree', async (_where, plant) => {
        const member = mkdtempSync(join(tmpdir(), 'factory-member-'));
        const victim = mkdtempSync(join(tmpdir(), 'factory-victim-'));
        mkdirSync(join(victim, 'acme', 'web'), { recursive: true });
        writeFileSync(join(victim, 'acme', 'web', 'blob'), 'v'.repeat(65_536));
        plant(member, victim);
        const cacheDir = join(member, '.cache', 'acme', 'web');

        const sized = createFactsCache();
        sized.sizeOf(cacheDir, member);
        for (let i = 0; i < 100; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(sized.sizeOf(cacheDir, member)).toBeNull();
    });
});

/**
 * A member's agent writes its own checkout — `.git/config` included — and the board, which sees
 * every org's tree, reads it on every poll. Nothing the checkout says may run code on the board or
 * point the read at another member's tree.
 */
describe('the facts cache against a hostile checkout', () => {
    it('never runs a program the checkout config names (gpg.program behind log.showSignature)', async () => {
        const { member, checkout } = memberCheckout('factory-hostile-');
        const marker = join(member, 'PWNED');
        const evil = join(member, 'evil.sh');
        writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
        chmodSync(evil, 0o755);
        // A signed-looking HEAD: the signature header alone is what makes `git log` call gpg.
        const raw = gitIn(checkout, ['cat-file', 'commit', 'HEAD']).replace(
            /^(committer .*)$/m,
            '$1\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n fake\n -----END PGP SIGNATURE-----'
        );
        writeFileSync(join(member, 'commit.txt'), raw);
        const forged = gitIn(checkout, ['hash-object', '-t', 'commit', '-w', join(member, 'commit.txt')]).trim();
        gitIn(checkout, ['update-ref', 'refs/heads/main', forged]);
        gitIn(checkout, ['config', 'log.showSignature', 'true']);
        gitIn(checkout, ['config', 'gpg.program', evil]);

        const facts = await factsOf(checkout, member);

        expect(existsSync(marker)).toBe(false);
        expect(facts.lastCommit?.sha).toBe(forged);
        expect(facts.lastCommit?.headline).toBe('victim secret headline');
    });

    // A missing HEAD object in a promisor repository makes git lazily fetch it — and the fetch
    // execs whatever transport program the checkout's config names.
    it.each([
        [
            'an upload-pack program',
            (evil: string, origin: string) => [
                ['remote.origin.url', origin],
                ['remote.origin.uploadpack', evil],
            ],
        ],
        [
            'an ssh command',
            (evil: string) => [
                ['remote.origin.url', 'ssh://example.invalid/x'],
                ['core.sshCommand', evil],
            ],
        ],
    ])('never lazily fetches a missing object through %s', async (_how, settings) => {
        const { member, checkout } = memberCheckout('factory-lazy-');
        const origin = memberCheckout('factory-lazy-origin-').checkout;
        const marker = join(member, 'PWNED');
        const evil = join(member, 'evil.sh');
        writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
        chmodSync(evil, 0o755);
        gitIn(checkout, ['config', 'core.repositoryformatversion', '1']);
        gitIn(checkout, ['config', 'extensions.partialClone', 'origin']);
        gitIn(checkout, ['config', 'remote.origin.promisor', 'true']);
        for (const [key, value] of settings(evil, origin)) gitIn(checkout, ['config', key ?? '', value ?? '']);
        writeFileSync(join(checkout, '.git', 'refs', 'heads', 'main'), `${'ab'.repeat(20)}\n`);

        await factsOf(checkout, member);

        expect(existsSync(marker)).toBe(false);
    });

    it.each([
        [
            'the checkout directory itself',
            (attacker: string, victim: string) => symlinkSync(victim, join(attacker, 'web')),
        ],
        [
            'its .git directory',
            (attacker: string, victim: string) => {
                mkdirSync(join(attacker, 'web'));
                symlinkSync(join(victim, '.git'), join(attacker, 'web', '.git'));
            },
        ],
        [
            'a commondir file in its .git',
            (attacker: string, victim: string) => {
                const own = join(attacker, 'web');
                gitIn(attacker, ['init', '-q', '-b', 'main', own]);
                writeFileSync(join(own, '.git', 'commondir'), `${join(victim, '.git')}\n`);
            },
        ],
        [
            'a symlinked loose object',
            (attacker: string, victim: string) => {
                const own = join(attacker, 'web');
                gitIn(attacker, ['init', '-q', '-b', 'main', own]);
                const sha = gitIn(victim, ['rev-parse', 'HEAD']).trim();
                mkdirSync(join(own, '.git', 'objects', sha.slice(0, 2)), { recursive: true });
                symlinkSync(
                    join(victim, '.git', 'objects', sha.slice(0, 2), sha.slice(2)),
                    join(own, '.git', 'objects', sha.slice(0, 2), sha.slice(2))
                );
                writeFileSync(join(own, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
            },
        ],
        [
            'a symlinked refs directory',
            (attacker: string, victim: string) => {
                const own = join(attacker, 'web');
                gitIn(attacker, ['init', '-q', '-b', 'main', own]);
                execFileSync('rm', ['-rf', join(own, '.git', 'refs')]);
                symlinkSync(join(victim, '.git', 'refs'), join(own, '.git', 'refs'));
                writeFileSync(
                    join(own, '.git', 'objects', 'info', 'alternates'),
                    `${join(victim, '.git', 'objects')}\n`
                );
            },
        ],
    ])("never reads another member's checkout through %s", async (_how, plant) => {
        const { checkout: victim } = memberCheckout('factory-victim-');
        const attacker = mkdtempSync(join(tmpdir(), 'factory-attacker-'));
        plant(attacker, victim);

        const facts = await factsOf(join(attacker, 'web'), attacker);

        expect(facts.lastCommit).toBeNull();
        expect(JSON.stringify(facts)).not.toContain('victim secret headline');
    });

    // A FIFO config blocks every git that opens it: the timeout must reap the whole read, not only
    // its shell, or each poll would strand another blocked git on the board.
    it('leaves no blocked reader behind when a hostile config stalls the read', async () => {
        const { checkout, member } = memberCheckout('factory-fifo-');
        execFileSync('rm', [join(checkout, '.git', 'config')]);
        execFileSync('mkfifo', [join(checkout, '.git', 'config')]);
        const fresh = createFactsCache(Date.now, { headTimeoutMs: 200 });

        fresh.get(checkout, member);
        await new Promise((r) => setTimeout(r, 1200));

        // A writer's non-blocking open succeeds only while some process is blocked reading.
        const probe = () =>
            closeSync(openSync(join(checkout, '.git', 'config'), constants.O_WRONLY | constants.O_NONBLOCK));
        expect(probe).toThrow(/ENXIO/);
    });

    // Out of descriptors, spawn emits `error` on the next tick with no stdout: an unlistened error
    // event would take the whole board down. A read that cannot start is simply unmeasured.
    it('answers unmeasured, never throws, when the read cannot be spawned', async () => {
        const { checkout, member } = memberCheckout('factory-nospawn-');
        const path = process.env.PATH;
        process.env.PATH = '/nonexistent';
        try {
            const fresh = createFactsCache(Date.now, { headTimeoutMs: 200 });
            fresh.get(checkout, member);
            for (let i = 0; i < 40; i += 1) await new Promise((r) => setTimeout(r, 5));
            expect(fresh.get(checkout, member)).toEqual({ branch: null, lastCommit: null, sizeBytes: null });
        } finally {
            process.env.PATH = path;
        }
    });
});
