import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READ_TRANSPORT } from '@factory-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createOriginPlanReader } from '../src/github/local-origin-plan.js';

/*
 * The offline board's plan source (issue #799, #777): the `none` arm has no App client, so it
 * fetches a repository's `.bellows.yaml` from its git origin at `<base>/<owner>/<name>.git` — the
 * same shape the driver clones from — through the same validation production uses. These tests
 * stand real `file://` bare repositories in a temp dir as the origin.
 */
const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    for (const server of servers.splice(0)) server.close();
});

const git = (args: string[], cwd?: string) =>
    execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();

const tempDir = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    roots.push(dir);
    return dir;
};

/** A bare origin for `owner/name` under a fresh base dir, with one commit per entry of `commits` on `branch`. */
function mirror(repo: string, commits: (string | null)[], branch = 'main') {
    const dir = tempDir('origins-');
    const bare = join(dir, `${repo}.git`);
    mkdirSync(bare, { recursive: true });
    git(['init', '-q', '--bare', '-b', branch, bare]);
    const tree = tempDir('seed-');
    git(['init', '-q', '-b', branch, tree]);
    for (const bellows of commits) {
        if (bellows !== null) {
            writeFileSync(join(tree, '.bellows.yaml'), bellows);
            git(['add', '.bellows.yaml'], tree);
        }
        git(['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'c'], tree);
    }
    git(['push', '-q', bare, `${branch}:${branch}`], tree);
    return { base: `file://${dir}`, tip: git(['rev-parse', 'HEAD'], tree) };
}

/** A reader over `base` whose scratch dirs land in a directory the test can inspect afterwards. */
function readerOver(base: string, options: { timeoutMs?: number; gitBin?: string } = {}) {
    const tmpRoot = tempDir('plan-tmp-');
    const leftovers = () => readdirSync(tmpRoot).filter((entry) => entry.startsWith('factory-plan-'));
    return { reader: createOriginPlanReader(base, { tmpRoot, ...options }), leftovers };
}

/** An origin that accepts a connection and never answers: the shape of a hung network path. */
async function silentOrigin(): Promise<string> {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `git://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A `git` that stalls on `stallOn`'s subcommand and runs everything else for real. */
function slowGit(stallOn: string): string {
    const bin = join(tempDir('slow-git-'), 'git');
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do [ "$a" = ${stallOn} ] && exec sleep 30; done\nexec git "$@"\n`);
    chmodSync(bin, 0o755);
    return bin;
}

/** A `git` that, on `stallOn`, forks a stalled child (a transport helper's shape) and records its pid. */
function forkingGit(stallOn: string, pidFile: string): string {
    const bin = join(tempDir('fork-git-'), 'git');
    writeFileSync(
        bin,
        `#!/bin/sh\nfor a in "$@"; do if [ "$a" = ${stallOn} ]; then sleep 30 & echo $! > ${pidFile}; wait; fi; done\nexec git "$@"\n`
    );
    chmodSync(bin, 0o755);
    return bin;
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

const SERVICE = 'services:\n  - name: stub-svc\n    image: factory-jobs-smoke-svc\n';
const MALFORMED = 'services:\n  - name: db\n    image: postgres\n    ports: ["5432:5432"]\n';

describe('the origin plan reader', () => {
    it('reads the plan at a named branch, pinned to its revision', async () => {
        const { base, tip } = mirror('acme/web', [null, SERVICE]);

        const plan = await readerOver(base).reader.read('acme/web', 'main');

        expect(plan).toMatchObject({ revision: tip, error: null });
        expect(plan.services.map((service) => service.name)).toEqual(['stub-svc']);
    });

    it('reads the origin default branch when the thread has no base branch', async () => {
        const { base, tip } = mirror('acme/web', [SERVICE], 'trunk');

        expect(await readerOver(base).reader.read('acme/web', null)).toMatchObject({ revision: tip, error: null });
    });

    it('answers a malformed file with the refusal production gives', async () => {
        const { base } = mirror('acme/web', [MALFORMED]);

        const plan = await readerOver(base).reader.read('acme/web', 'main');

        expect(plan.error).toContain('.bellows.yaml');
        expect(plan.services).toEqual([]);
    });

    it('refuses a file over the size the App path refuses', async () => {
        const { base } = mirror('acme/web', [`${SERVICE}# ${'x'.repeat(70_000)}\n`]);

        expect((await readerOver(base).reader.read('acme/web', 'main')).error).toContain(
            '.bellows.yaml is larger than 65536 bytes'
        );
    });

    it('answers no plan, with the revision, for a reachable repository without the file', async () => {
        const { base, tip } = mirror('acme/web', [null]);

        expect(await readerOver(base).reader.read('acme/web', 'main')).toMatchObject({
            revision: tip,
            error: null,
            services: [],
            config: null,
        });
    });

    it('answers a confirmed missing branch as a refusal value, not a throw', async () => {
        const { base } = mirror('acme/web', [SERVICE]);

        expect(await readerOver(base).reader.read('acme/web', 'release')).toMatchObject({
            revision: null,
            services: [],
            error: expect.stringContaining('acme/web'),
        });
    });

    it('refuses a revision expression as a branch name instead of resolving it', async () => {
        const { base } = mirror('acme/web', [SERVICE, null]);

        expect(await readerOver(base).reader.read('acme/web', 'main~1')).toMatchObject({
            revision: null,
            services: [],
            error: expect.stringContaining('acme/web'),
        });
    });

    it('rejects as an outage for a repository the origin does not have, never "no plan"', async () => {
        const { base } = mirror('acme/web', [SERVICE]);

        for (const branch of ['main', null]) {
            await expect(readerOver(base).reader.read('acme/other', branch)).rejects.toMatchObject({
                kind: READ_TRANSPORT,
            });
        }
    });

    it('rejects as an outage when the origin accepts and never answers, within the deadline', async () => {
        const { reader } = readerOver(await silentOrigin(), { timeoutMs: 700 });

        const started = Date.now();
        await expect(reader.read('acme/web', 'main')).rejects.toMatchObject({ kind: READ_TRANSPORT });

        expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('carries the same deadline through the reads after the fetch', async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const { reader, leftovers } = readerOver(base, { timeoutMs: 1_500, gitBin: slowGit('for-each-ref') });

        const started = Date.now();
        await expect(reader.read('acme/web', 'main')).rejects.toMatchObject({ kind: READ_TRANSPORT });

        expect(Date.now() - started).toBeLessThan(10_000);
        expect(leftovers()).toEqual([]);
    });

    it('kills the whole git process group at the deadline, so no transport child outlives the read', async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const pidFile = join(tempDir('pid-'), 'child');
        // `init` is the read's first git call, so the child exists long before the deadline even on a loaded host.
        const { reader } = readerOver(base, { timeoutMs: 5_000, gitBin: forkingGit('init', pidFile) });

        const settled = reader.read('acme/web', 'main').catch((e: unknown) => e);
        await expect
            .poll(() => readFileSync(pidFile, { encoding: 'utf8', flag: 'a+' }).trim(), { timeout: 5_000 })
            .not.toBe('');
        expect(await settled).toMatchObject({ kind: READ_TRANSPORT });

        const child = Number(readFileSync(pidFile, 'utf8').trim());
        await expect.poll(() => alive(child), { timeout: 2_000 }).toBe(false);
    }, 15_000);

    it('leaves no scratch directory behind: success, missing branch, outage and timeout', async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const { reader, leftovers } = readerOver(base);
        await reader.read('acme/web', 'main');
        await reader.read('acme/web', 'release');
        await expect(reader.read('acme/other', 'main')).rejects.toMatchObject({ kind: READ_TRANSPORT });
        expect(leftovers()).toEqual([]);

        const hung = readerOver(await silentOrigin(), { timeoutMs: 500 });
        await expect(hung.reader.read('acme/web', 'main')).rejects.toMatchObject({ kind: READ_TRANSPORT });
        expect(hung.leftovers()).toEqual([]);
    });

    it("fetches the plan blob only, leaving the repository's other blobs behind", async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const bare = join(base.replace('file://', ''), 'acme/web.git');
        git(['config', 'uploadpack.allowFilter', 'true'], bare);
        git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], bare);
        const tree = tempDir('seed-big-');
        git(['clone', '-q', bare, tree]);
        writeFileSync(join(tree, 'big.bin'), 'x'.repeat(100_000));
        git(['add', 'big.bin'], tree);
        git(['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'big'], tree);
        git(['push', '-q', 'origin', 'HEAD:main'], tree);
        // At `cat-file` time the scratch repository lists what it lacks (`?<oid>`): the unrelated blob.
        const missing = join(tempDir('missing-'), 'missing');
        const bin = join(tempDir('spy-git-'), 'git');
        writeFileSync(
            bin,
            `#!/bin/sh\nif [ "$3" = cat-file ]; then git --git-dir "$2" rev-list --objects --missing=print --all > ${missing}; fi\nexec git "$@"\n`
        );
        chmodSync(bin, 0o755);

        const plan = await readerOver(base, { gitBin: bin }).reader.read('acme/web', 'main');

        expect(plan.error).toBeNull();
        expect(plan.services.map((service) => service.name)).toEqual(['stub-svc']);
        expect(readFileSync(missing, 'utf8')).toMatch(/^\?/m);
    });

    it('refuses a bad label without spawning git', async () => {
        // A binary that cannot start would make any spawned git an outage; the label is refused as a value first.
        const { reader } = readerOver('file:///nowhere', { gitBin: '/nonexistent/git' });

        for (const repo of ['../acme/web', 'acme/../acme/web', 'acme', '/etc/passwd']) {
            expect((await reader.read(repo, 'main')).error).toContain(repo);
        }
    });
});
