import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(root, 'scripts/release.sh');
const SKIP_CI = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]/i;

interface Fixture {
    env: NodeJS.ProcessEnv;
    remote: string;
    seed: string;
    work: string;
}

const dirs: string[] = [];
const live = new Set<{ kill: () => void; closed: Promise<void> }>();

/** SIGKILLs the child's whole process group (it leads its own): a backgrounded descendant would hold the pipes open. */
const killGroup = (pid: number | undefined): void => {
    if (pid === undefined) return;
    try {
        process.kill(-pid, 'SIGKILL');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
};

// The file's own teardown: kill and await every child still running, then remove the dirs they use.
afterEach(async () => {
    const pending = [...live];
    for (const child of pending) child.kill();
    await Promise.all(pending.map((child) => child.closed));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
    status: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Async on purpose: spawnSync blocks the worker's event loop, vitest yields only a microtask between
 * synchronous tests, and a loaded host then starves its 60 s RPC timer (same mechanism as biome.test.ts).
 * No inner timeout; the test budget and the teardown above bound it.
 */
function run(cwd: string, env: NodeJS.ProcessEnv, command: string, args: string[]): Promise<RunResult> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let markClosed = (): void => undefined;
        const entry = {
            kill: () => killGroup(child.pid),
            closed: new Promise<void>((r) => {
                markClosed = r;
            }),
        };
        live.add(entry);
        const settle = (status: number | null, extra = ''): void => {
            if (settled) return;
            settled = true;
            live.delete(entry);
            markClosed();
            resolve({ status, stdout, stderr: stderr + extra });
        };
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.on('error', (error) => settle(null, String(error)));
        child.on('close', (code) => settle(code));
    });
}

async function git(fixture: Fixture, cwd: string, ...args: string[]): Promise<string> {
    const result = await run(cwd, fixture.env, 'git', args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
}

/** The seed clone commits and pushes; the work clone then pulls, so it starts level with origin. */
async function publish(fixture: Fixture, files: Record<string, string | null>, message = 'change'): Promise<void> {
    for (const [name, contents] of Object.entries(files)) {
        if (contents === null) rmSync(join(fixture.seed, name));
        else writeFileSync(join(fixture.seed, name), contents);
    }
    await git(fixture, fixture.seed, 'add', '-A');
    await git(fixture, fixture.seed, 'commit', '-q', '-m', message);
    await git(fixture, fixture.seed, 'push', '-q', 'origin', 'HEAD:main');
}

async function setup(version: string | null = '0.0.2\n'): Promise<Fixture> {
    const dir = mkdtempSync(join(tmpdir(), 'release-'));
    dirs.push(dir);
    const gitconfig = join(dir, 'gitconfig');
    writeFileSync(
        gitconfig,
        [
            '[user]',
            '\tname = Release Test',
            '\temail = release@example.invalid',
            '[init]',
            '\tdefaultBranch = main',
            '[commit]',
            '\tgpgsign = false',
            '[tag]',
            '\tgpgsign = false',
            '',
        ].join('\n')
    );
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: dir,
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_NOSYSTEM: '1',
    };
    const fixture: Fixture = { env, remote: join(dir, 'remote.git'), seed: join(dir, 'seed'), work: join(dir, 'work') };
    await git(fixture, dir, 'init', '-q', '--bare', '-b', 'main', fixture.remote);
    await git(fixture, dir, 'clone', '-q', fixture.remote, fixture.seed);
    await publish(
        fixture,
        { 'README.md': 'release fixture\n', ...(version === null ? {} : { VERSION: version }) },
        'seed'
    );
    await git(fixture, dir, 'clone', '-q', fixture.remote, fixture.work);
    return fixture;
}

const release = (fixture: Fixture, ...args: string[]): Promise<RunResult> =>
    run(fixture.work, fixture.env, 'sh', [SCRIPT, ...args]);

async function snapshot(fixture: Fixture) {
    const read = (cwd: string, ...args: string[]) => git(fixture, cwd, ...args);
    let version: string | null = null;
    try {
        version = readFileSync(join(fixture.work, 'VERSION'), 'utf8');
    } catch {
        // A fixture with no VERSION at all.
    }
    return {
        head: await read(fixture.work, 'rev-parse', 'HEAD'),
        localTags: await read(fixture.work, 'tag', '--list'),
        remoteMain: await read(fixture.remote, 'rev-parse', 'main'),
        remoteTags: await read(fixture.remote, 'tag', '--list'),
        status: await read(fixture.work, 'status', '--porcelain'),
        version,
    };
}

async function expectRefusal(fixture: Fixture, reason: RegExp, ...args: string[]): Promise<void> {
    const before = await snapshot(fixture);
    const result = await release(fixture, ...args);
    expect(result.status, result.stdout).not.toBe(0);
    expect(result.stderr).toMatch(reason);
    expect(await snapshot(fixture)).toEqual(before);
}

describe('npm run release', () => {
    it("keeps the worker's event loop running while git runs", async () => {
        const fixture = await setup();
        const realGit = execFileSync('which', ['git'], { env: process.env, encoding: 'utf8' }).trim();
        const shims = join(dirs[0] as string, 'shims');
        const barrier = join(shims, 'barrier');
        const log = join(shims, 'log');
        mkdirSync(shims);
        const shim = join(shims, 'git');
        // Waits up to 2 s for the barrier a timer on this worker creates, records whether it saw it, then runs real git.
        writeFileSync(
            shim,
            `#!/bin/sh\ni=0\nwhile [ ! -e "$PROBE_BARRIER" ] && [ $i -lt 40 ]; do sleep 0.05; i=$((i+1)); done\n` +
                `if [ -e "$PROBE_BARRIER" ]; then echo seen >> "$PROBE_LOG"; else echo late >> "$PROBE_LOG"; fi\nexec "${realGit}" "$@"\n`
        );
        chmodSync(shim, 0o755);
        fixture.env = { ...fixture.env, PATH: `${shims}:${process.env.PATH}`, PROBE_BARRIER: barrier, PROBE_LOG: log };
        setTimeout(() => writeFileSync(barrier, ''), 0);
        const result = await release(fixture);
        expect(result.status, result.stderr).toBe(0);
        const seen = readFileSync(log, 'utf8').trim().split('\n');
        expect(seen.length).toBeGreaterThan(0);
        expect(new Set(seen)).toEqual(new Set(['seen']));
        expect(existsSync(barrier)).toBe(true);
    });
    it('tears down a child whose backgrounded descendant holds the pipes open', async () => {
        const running = run(tmpdir(), process.env, 'sh', ['-c', 'sleep 60 & wait']);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const pending = [...live];
        for (const child of pending) child.kill();
        const bound = new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 3_000));
        const closed = Promise.all(pending.map((child) => child.closed)).then(() => 'closed' as const);
        expect(await Promise.race([closed, bound])).toBe('closed');
        expect((await running).status).toBeNull();
    });

    it('is wired to scripts/release.sh', () => {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
        expect(pkg.scripts.release).toBe('sh scripts/release.sh');
    });

    it('cuts X.Y.(Z+1) as one version-only commit, tagged and pushed together', async () => {
        const fixture = await setup();
        const orig = await git(fixture, fixture.work, 'rev-parse', 'HEAD');
        const result = await release(fixture);
        expect(result.status, result.stderr).toBe(0);

        const head = await git(fixture, fixture.work, 'rev-parse', 'HEAD');
        expect(readFileSync(join(fixture.work, 'VERSION'), 'utf8')).toBe('0.0.3\n');
        expect(await git(fixture, fixture.work, 'rev-list', '--count', `${orig}..HEAD`)).toBe('1');
        expect(await git(fixture, fixture.work, 'show', '--name-only', '--format=', 'HEAD')).toBe('VERSION');
        expect(await git(fixture, fixture.work, 'rev-parse', 'v0.0.3^{commit}')).toBe(head);
        expect(await git(fixture, fixture.remote, 'rev-parse', 'main')).toBe(head);
        expect(await git(fixture, fixture.remote, 'rev-parse', 'v0.0.3^{commit}')).toBe(head);
        // GitHub skips every push workflow for a commit carrying one, the tag's release included.
        expect(await git(fixture, fixture.work, 'log', '-1', '--format=%B')).not.toMatch(SKIP_CI);
        expect(await git(fixture, fixture.work, 'status', '--porcelain')).toBe('');
    });

    it('increments only the patch component', async () => {
        const fixture = await setup('1.9.9\n');
        expect((await release(fixture)).status).toBe(0);
        expect(readFileSync(join(fixture.work, 'VERSION'), 'utf8')).toBe('1.9.10\n');
        expect(await git(fixture, fixture.remote, 'tag', '--list')).toBe('v1.9.10');
    });

    it('refuses a re-run on an already-released HEAD', async () => {
        const fixture = await setup();
        expect((await release(fixture)).status).toBe(0);
        await expectRefusal(fixture, /already released/);
        expect(await git(fixture, fixture.remote, 'tag', '--list')).toBe('v0.0.3');
    });

    it.each<[string, (fixture: Fixture) => void | Promise<void>, RegExp]>([
        ['a modified tracked file', (f) => writeFileSync(join(f.work, 'README.md'), 'edited\n'), /not clean/],
        ['an untracked file', (f) => writeFileSync(join(f.work, 'stray.txt'), 'stray\n'), /not clean/],
        ['a checkout behind origin', (f) => publish(f, { 'README.md': 'moved on\n' }), /origin\/main/],
        [
            'a checkout ahead of origin',
            async (f) => {
                writeFileSync(join(f.work, 'README.md'), 'unpushed\n');
                await git(f, f.work, 'commit', '-q', '-am', 'unpushed');
            },
            /origin\/main/,
        ],
        ['a branch other than main', (f) => git(f, f.work, 'switch', '-q', '-c', 'feature'), /not on main/],
        [
            'the next tag already existing locally',
            async (f) => {
                // A tag on HEAD would trip the already-released guard first; put it on another commit.
                await git(f, f.work, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
                await git(f, f.work, 'tag', 'v0.0.3');
                await git(f, f.work, 'reset', '-q', '--hard', 'origin/main');
            },
            /v0\.0\.3 already exists/,
        ],
        [
            'the next tag existing only on the remote',
            async (f) => {
                await git(f, f.seed, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
                await git(f, f.seed, 'tag', 'v0.0.3');
                await git(f, f.seed, 'push', '-q', 'origin', 'v0.0.3');
            },
            /v0\.0\.3 already exists/,
        ],
    ])('refuses %s', async (_label, arrange, reason) => {
        const fixture = await setup();
        await arrange(fixture);
        await expectRefusal(fixture, reason);
    });

    it.each<[string, string | null]>([
        ['a leading v', 'v0.0.2\n'],
        ['two components', '0.0\n'],
        ['a prerelease', '0.0.2-rc.1\n'],
        ['a leading zero', '0.01.2\n'],
        ['two lines', '0.0.2\n0.0.3\n'],
        ['an empty file', ''],
        ['no file at all', null],
    ])('refuses a VERSION with %s', async (_label, contents) => {
        await expectRefusal(await setup(contents), /VERSION/);
    });

    it('lands nothing when the remote rejects either ref, and undoes its own commit and tag', async () => {
        const fixture = await setup();
        const hook = join(fixture.remote, 'hooks/update');
        writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\nexit 0\n');
        chmodSync(hook, 0o755);
        await expectRefusal(fixture, /push/);
    });

    it('refuses an unknown argument', async () => {
        await expectRefusal(await setup(), /usage/, '--beta');
    });

    it('cuts the final release over a HEAD that carries only a release candidate', async () => {
        const fixture = await setup();
        expect((await release(fixture, '--rc')).status).toBe(0);
        const result = await release(fixture);
        expect(result.status, result.stderr).toBe(0);
        expect((await git(fixture, fixture.remote, 'tag', '--list')).split('\n')).toEqual(['v0.0.3', 'v0.0.3-rc']);
    });
});

describe('npm run release -- --rc', () => {
    it('tags HEAD vX.Y.(Z+1)-rc and pushes only the tag: no commit, VERSION untouched', async () => {
        const fixture = await setup();
        const orig = await git(fixture, fixture.work, 'rev-parse', 'HEAD');
        const result = await release(fixture, '--rc');
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('released v0.0.3-rc');
        expect(await git(fixture, fixture.work, 'rev-parse', 'HEAD')).toBe(orig);
        expect(readFileSync(join(fixture.work, 'VERSION'), 'utf8')).toBe('0.0.2\n');
        expect(await git(fixture, fixture.remote, 'rev-parse', 'main')).toBe(orig);
        expect(await git(fixture, fixture.remote, 'rev-parse', 'v0.0.3-rc^{commit}')).toBe(orig);
        expect(await git(fixture, fixture.remote, 'cat-file', '-t', 'v0.0.3-rc')).toBe('tag');
        expect(await git(fixture, fixture.work, 'status', '--porcelain')).toBe('');
    });

    it('numbers each later candidate -rc-2, -rc-3, after the highest one on either side', async () => {
        const fixture = await setup();
        expect((await release(fixture, '--rc')).status).toBe(0);
        await publish(fixture, { 'README.md': 'second\n' });
        await git(fixture, fixture.work, 'pull', '-q', 'origin', 'main');
        expect((await release(fixture, '--rc')).status).toBe(0);
        // A candidate cut elsewhere and present only on the remote still counts.
        await git(fixture, fixture.seed, 'pull', '-q', 'origin', 'main');
        await git(fixture, fixture.seed, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
        await git(fixture, fixture.seed, 'tag', 'v0.0.3-rc-9');
        await git(fixture, fixture.seed, 'push', '-q', 'origin', 'v0.0.3-rc-9');
        await publish(fixture, { 'README.md': 'third\n' });
        await git(fixture, fixture.work, 'pull', '-q', 'origin', 'main');
        const result = await release(fixture, '--rc');
        expect(result.status, result.stderr).toBe(0);
        expect((await git(fixture, fixture.remote, 'tag', '--list')).split('\n').sort()).toEqual(
            ['v0.0.3-rc', 'v0.0.3-rc-10', 'v0.0.3-rc-2', 'v0.0.3-rc-9'].sort()
        );
    });

    it('ignores candidates of another version and tags that only share the prefix', async () => {
        const fixture = await setup();
        await git(fixture, fixture.seed, 'commit', '-q', '--allow-empty', '-m', 'elsewhere');
        await git(fixture, fixture.seed, 'tag', 'v0.0.2-rc-5');
        await git(fixture, fixture.seed, 'tag', 'v0.0.3-rcx');
        await git(fixture, fixture.seed, 'push', '-q', 'origin', '--tags');
        expect((await release(fixture, '--rc')).status).toBe(0);
        expect((await git(fixture, fixture.remote, 'tag', '--list', 'v0.0.3-rc*')).split('\n').sort()).toEqual(
            ['v0.0.3-rc', 'v0.0.3-rcx'].sort()
        );
    });

    it.each(['[skip ci]', '[ci skip]', '[no ci]', '[skip actions]', '[actions skip]'])(
        'refuses a HEAD whose message carries %s, which would make GitHub skip the release workflow',
        async (marker) => {
            const fixture = await setup();
            await publish(fixture, { 'README.md': 'docs only\n' }, `Fix typo ${marker}`);
            await git(fixture, fixture.work, 'pull', '-q');
            await expectRefusal(fixture, /skip/, '--rc');
        }
    );

    it('refuses a HEAD that already carries a candidate', async () => {
        const fixture = await setup();
        expect((await release(fixture, '--rc')).status).toBe(0);
        await expectRefusal(fixture, /already released/, '--rc');
    });

    it.each<[string, (fixture: Fixture) => void | Promise<void>, RegExp]>([
        ['a modified tracked file', (f) => writeFileSync(join(f.work, 'README.md'), 'edited\n'), /not clean/],
        ['a checkout behind origin', (f) => publish(f, { 'README.md': 'moved on\n' }), /origin\/main/],
        ['a branch other than main', (f) => git(f, f.work, 'switch', '-q', '-c', 'feature'), /not on main/],
    ])('refuses %s', async (_label, arrange, reason) => {
        const fixture = await setup();
        await arrange(fixture);
        await expectRefusal(fixture, reason, '--rc');
    });

    it('lands nothing when the remote rejects the tag, and deletes its local tag', async () => {
        const fixture = await setup();
        const hook = join(fixture.remote, 'hooks/update');
        writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\nexit 0\n');
        chmodSync(hook, 0o755);
        await expectRefusal(fixture, /push/, '--rc');
    });
});
