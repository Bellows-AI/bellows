import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import {
    type PublishResult,
    type PublishStep,
    probeTreeFingerprint,
    publishCheckout,
    STALE_REVISION_REASON,
} from '../src/publish/publish.js';
import { git, hasGit, ROOT, SCRIPT_IDENTITY, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The publish over a real repository whose hooks would rewrite content (issue #825): a publish
 * bound to evidence ships exactly the content the evidence assessed. The checkout is written by the
 * agent's tool uid, so its hooks are not the driver's to run: the driver's git (`git-harden.cjs`,
 * the `git` of every supervised step, which the runner below goes through) runs none of them, so no
 * hook moves the content, bound or not. Real git throughout, offline: the remote is the fixture's
 * `file://` bare repo.
 */
/** The `git` every supervised step resolves to, run the way its shim is: a node script fronting the real git. */
const HARDENED_GIT = join(dirname(fileURLToPath(import.meta.url)), '../src/scripts/git-harden.cjs');

describe.skipIf(!hasGit())('a publish over repository hooks', () => {
    const fx = setupWorktreeFixture();
    const PR_URL = 'https://example.test/pull/1';
    const job = {
        id: ROOT,
        command: 'do the work',
        repo: 'example/factory',
        env: {},
    } as unknown as BoardJob;

    /** The task volume's `/task` is the fixture directory's `task` on this host. */
    const onHost = (literals: Record<string, string> = {}): Record<string, string> =>
        Object.fromEntries(
            Object.entries(literals).map(([name, value]) => [
                name,
                value.startsWith('/task/') ? join(fx.dir(), value) : value,
            ])
        );

    /** Runs a step the way a runner's transport does, against the fixture; `gh` is a stand-in. */
    const runStep = async (step: PublishStep): Promise<{ stdout: string }> => {
        if (step.entrypoint === 'gh') {
            if (step.args[1] === 'view') throw new Error('no pull requests found');
            return { stdout: step.args[1] === 'create' ? `${PR_URL}\n` : '' };
        }
        const hardened = step.entrypoint === 'git';
        const stdout = execFileSync(
            hardened ? process.execPath : step.entrypoint,
            hardened ? [HARDENED_GIT, ...step.args] : step.args,
            {
                cwd: step.inRepo ? fx.checkout() : fx.dir(),
                // No global or system config: a member's own core.hooksPath must not hide the hooks under test.
                env: {
                    ...process.env,
                    ...SCRIPT_IDENTITY,
                    GIT_CONFIG_GLOBAL: '/dev/null',
                    GIT_CONFIG_NOSYSTEM: '1',
                    ...(hardened ? { GIT_HARDEN_REAL: 'git' } : {}),
                    ...onHost(step.envLiterals),
                },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );
        return { stdout };
    };

    /** Installs a POSIX sh hook in the checkout's hooks directory . */
    const hook = (name: string, body: string): void => {
        const dir = join(git(fx.checkout(), 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'hooks');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    };
    const REWRITE = "printf 'hooked\\n' >> WORK.md";

    /** The synced worktree with the agent's work in it, and the fingerprint its evidence binds. */
    const work = async (): Promise<string> => {
        expect(fx.sync().ok).toBe(true);
        writeFileSync(join(fx.checkout(), 'WORK.md'), 'verified\n');
        const revision = await probeTreeFingerprint(job, runStep);
        expect(revision).toMatch(/^[0-9a-f]{40}:[0-9a-f]{64}$/);
        return revision!;
    };

    const publish = (revision?: string): Promise<PublishResult> =>
        publishCheckout(job, revision === undefined ? undefined : { revision }, runStep);

    /** The branches the bare remote holds beside its default. */
    const pushed = (): string[] =>
        git(fx.bare(), 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
            .split('\n')
            .filter((name) => name && name !== 'main');
    const shipped = (path: string): string => git(fx.bare(), 'show', `${pushed()[0]}:${path}`);

    it('publishes a bound revision with no hook installed: the pushed content is the verified one', async () => {
        const revision = await work();

        expect(await publish(revision)).toMatchObject({ ok: true, published: true });
        expect(shipped('WORK.md')).toBe('verified');
    });

    const ran = (name: string): string => join(fx.dir(), `${name}-ran`);
    /** A hook that writes the content a rewrite would and notes that it ran. */
    const rewriting = (name: string): void => hook(name, `: > '${ran(name)}'\n${REWRITE}\ngit add WORK.md`);

    it.each(['pre-commit', 'post-index-change', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-push'])(
        'never runs a %s hook of the checkout, bound or not: the verified content ships',
        async (name) => {
            const revision = await work();
            rewriting(name);

            expect(await publish(revision)).toMatchObject({ ok: true, published: true });

            expect(existsSync(ran(name))).toBe(false);
            expect(shipped('WORK.md')).toBe('verified');
        }
    );

    it('never runs the post-checkout hook of the branch switch', async () => {
        expect(fx.sync().ok).toBe(true);
        git(fx.checkout(), 'switch', '--detach');
        writeFileSync(join(fx.checkout(), 'WORK.md'), 'verified\n');
        const revision = (await probeTreeFingerprint(job, runStep))!;
        rewriting('post-checkout');

        expect(await publish(revision)).toMatchObject({ ok: true, published: true });

        expect(existsSync(ran('post-checkout'))).toBe(false);
        expect(shipped('WORK.md')).toBe('verified');
    });

    it('never runs a hook of an unbound publish either', async () => {
        await work();
        rewriting('pre-commit');

        expect(await publish()).toMatchObject({ ok: true, published: true });

        expect(existsSync(ran('pre-commit'))).toBe(false);
        expect(shipped('WORK.md')).toBe('verified');
    });

    it('publishes over an ignored artifact written after the revision, and never ships it', async () => {
        expect(fx.sync().ok).toBe(true);
        writeFileSync(join(fx.checkout(), '.gitignore'), 'dist/\n');
        writeFileSync(join(fx.checkout(), 'WORK.md'), 'verified\n');
        const revision = (await probeTreeFingerprint(job, runStep))!;
        mkdirSync(join(fx.checkout(), 'dist'));
        writeFileSync(join(fx.checkout(), 'dist', 'out.js'), 'generated\n');

        expect(await publish(revision)).toMatchObject({ ok: true, published: true });
        expect(git(fx.bare(), 'ls-tree', '--name-only', pushed()[0]!)).not.toContain('dist');
    });

    it('refuses a tracked edit made after the revision', async () => {
        const revision = await work();
        writeFileSync(join(fx.checkout(), 'WORK.md'), 'edited after the gates\n');

        expect(await publish(revision)).toMatchObject({ ok: false, stale: true, reason: STALE_REVISION_REASON });
        expect(pushed()).toEqual([]);
    });
});
