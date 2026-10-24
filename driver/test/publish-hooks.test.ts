import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import {
    PUBLISH_MOVED_REASON,
    type PublishResult,
    type PublishStep,
    probeTreeFingerprint,
    publishCheckout,
    STALE_REVISION_REASON,
} from '../src/publish/publish.js';
import { git, hasGit, ROOT, SCRIPT_IDENTITY, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The publish over a real repository whose hooks rewrite content (issue #825): a publish bound to
 * evidence ships exactly the content the evidence assessed — a repository hook that moves it is
 * refused stale, nothing pushed — while hooks that move nothing still run, and an unbound publish
 * binds nothing. Real git throughout, offline: the remote is the fixture's `file://` bare repo.
 */
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
        const stdout = execFileSync(step.entrypoint, step.args, {
            cwd: step.inRepo ? fx.checkout() : fx.dir(),
            // No global or system config: a member's own core.hooksPath must not hide the hooks under test.
            env: {
                ...process.env,
                ...SCRIPT_IDENTITY,
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_CONFIG_NOSYSTEM: '1',
                ...onHost(step.envLiterals),
            },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
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

    it('refuses as stale a bound publish whose pre-commit hook rewrote a staged file, pushing nothing', async () => {
        const revision = await work();
        hook('pre-commit', `${REWRITE}\ngit add WORK.md`);

        expect(await publish(revision)).toMatchObject({ ok: false, stale: true, reason: PUBLISH_MOVED_REASON });
        expect(pushed()).toEqual([]);
    });

    it('refuses as stale a bound publish whose post-checkout hook rewrote the tree on the branch switch', async () => {
        expect(fx.sync().ok).toBe(true);
        git(fx.checkout(), 'switch', '--detach');
        writeFileSync(join(fx.checkout(), 'WORK.md'), 'verified\n');
        const revision = (await probeTreeFingerprint(job, runStep))!;
        hook('post-checkout', REWRITE);

        expect(await publish(revision)).toMatchObject({ ok: false, stale: true, reason: PUBLISH_MOVED_REASON });
        expect(pushed()).toEqual([]);
    });

    it('never ships content a post-index-change hook staged: it is refused, or the verified content ships', async () => {
        const revision = await work();
        const guard = '"$(git rev-parse --git-common-dir)/index-hooked"';
        hook('post-index-change', `[ -e ${guard} ] && exit 0\n: > ${guard}\n${REWRITE}\ngit add WORK.md`);

        const result = await publish(revision);

        if (result.ok) expect(shipped('WORK.md')).toBe('verified');
        else expect([result.stale, pushed()]).toEqual([true, []]);
    });

    it('publishes a bound revision whose pre-commit hook runs and changes nothing', async () => {
        const revision = await work();
        const marker = join(fx.dir(), 'pre-commit-ran');
        hook('pre-commit', `: > '${marker}'`);

        expect(await publish(revision)).toMatchObject({ ok: true, published: true });
        expect(existsSync(marker)).toBe(true);
        expect(shipped('WORK.md')).toBe('verified');
    });

    it('binds nothing when unbound: the hook’s rewrite ships', async () => {
        await work();
        hook('pre-commit', `${REWRITE}\ngit add WORK.md`);

        expect(await publish()).toMatchObject({ ok: true, published: true });
        expect(shipped('WORK.md')).toBe('verified\nhooked');
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
