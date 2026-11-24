import { execFileSync } from 'node:child_process';
import {
    chmodSync,
    closeSync,
    createReadStream,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    constants as fsConstants,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubRepo, READ_TRANSPORT, type RepoRef } from '@factory-ai/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOriginPlanReader } from '../src/github/local-origin-plan.js';

/*
 * The offline board's plan source: the `none` arm has no App client, so it
 * fetches a repository's `.bellows.yaml` from its git origin at `<base>/<owner>/<name>.git` — the
 * same shape the driver clones from — through the same validation production uses. These tests
 * stand real `file://` bare repositories in a temp dir as the origin.
 */
const roots: string[] = [];
const servers: Server[] = [];
const fifos: string[] = [];
afterEach(() => {
    vi.restoreAllMocks();
    // A reader still blocked in open(2) on a FIFO nobody wrote to is released by a read-write open.
    for (const path of fifos.splice(0)) closeSync(openSync(path, fsConstants.O_RDWR));
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

/** A bare origin for `path` on `host` under `dir`, with one commit per entry of `commits` on `branch`. */
function seedOrigin(dir: string, host: string, path: string, commits: (string | null)[], branch = 'main') {
    const bare = join(dir, host, `${path}.git`);
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

/** A github.com origin for the owner/name `repo` under a fresh base dir. */
const mirror = (repo: string, commits: (string | null)[], branch = 'main') =>
    seedOrigin(tempDir('origins-'), 'github.com', repo, commits, branch);

const gh = (path: string) => githubRepo(path);
const gl = (path: string): RepoRef => ({ forge: 'gitlab', host: 'gl.example', path });

/** A reader over `base` whose scratch dirs land in a directory the test can inspect afterwards. */
function readerOver(base: string, options: { timeoutMs?: number; gitBin?: string } = {}) {
    const tmpRoot = tempDir('plan-tmp-');
    const leftovers = () => readdirSync(tmpRoot).filter((entry) => entry.startsWith('factory-plan-'));
    return { reader: createOriginPlanReader(base, { tmpRoot, ...options }), leftovers };
}

/** An origin that accepts a connection and never answers: the shape of a hung network path. */
async function silentOrigin(): Promise<{ url: string; connected: Promise<void> }> {
    let connect!: () => void;
    const connected = new Promise<void>((resolve) => {
        connect = resolve;
    });
    const server = createServer(() => connect());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `git://127.0.0.1:${(server.address() as { port: number }).port}`, connected };
}

/**
 * A named pipe the test reads. `drain()` resolves with everything written once every writer has closed
 * it, and is the test's event for "the stub reached this step" (or, for a held descriptor, "it died").
 */
function fifo() {
    const path = join(tempDir('fifo-'), 'pipe');
    execFileSync('mkfifo', [path]);
    fifos.push(path);
    return {
        path,
        drain: () =>
            new Promise<string>((resolve, reject) => {
                const chunks: string[] = [];
                createReadStream(path, { encoding: 'utf8' })
                    .on('data', (chunk) => chunks.push(String(chunk)))
                    .on('end', () => resolve(chunks.join('')))
                    .on('error', reject);
            }),
    };
}

/** A `git` whose `ls-remote` writes `noise` bytes and then `line` to stderr and exits 128; everything else is real. */
function refusingGit(line: string, noise = 0): string {
    const bin = join(tempDir('refusing-git-'), 'git');
    writeFileSync(
        bin,
        `#!/bin/sh\nif [ "$1" = ls-remote ]; then head -c ${noise} /dev/zero | tr '\\0' x >&2; printf '\\n%s\\n\\n' '${line}' >&2; exit 128; fi\nexec git "$@"\n`
    );
    chmodSync(bin, 0o755);
    return bin;
}

/** The read deadline, handed to the reader as a signal the test aborts; any other timeout stays real. */
const DEADLINE_MS = 424_242;
function controlledDeadline() {
    const controller = new AbortController();
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((ms) => (ms === DEADLINE_MS ? controller.signal : real(ms)));
    return { spy, expire: () => controller.abort(new DOMException('deadline', 'TimeoutError')) };
}

/** A `git` that stalls on `stallOn`'s subcommand, writing to `startedPipe` first, and runs everything else for real. */
function slowGit(stallOn: string, startedPipe: string): string {
    const bin = join(tempDir('slow-git-'), 'git');
    writeFileSync(
        bin,
        `#!/bin/sh\nfor a in "$@"; do if [ "$a" = ${stallOn} ]; then echo started > ${startedPipe}; exec sleep 30; fi; done\nexec git "$@"\n`
    );
    chmodSync(bin, 0o755);
    return bin;
}

/**
 * A `git` that, on `stallOn`, forks a stalled child (a transport helper's shape). The child announces its
 * pid on `pidPipe` only after it holds `lifelinePipe` open for writing, and `sleep` keeps that descriptor
 * until it dies, so the lifeline's EOF is the death of the child.
 */
function forkingGit(stallOn: string, pidPipe: string, lifelinePipe: string): string {
    const bin = join(tempDir('fork-git-'), 'git');
    writeFileSync(
        bin,
        `#!/bin/sh\nfor a in "$@"; do if [ "$a" = ${stallOn} ]; then sh -c 'exec 3>${lifelinePipe}; echo $$ > ${pidPipe}; exec sleep 30' & wait; fi; done\nexec git "$@"\n`
    );
    chmodSync(bin, 0o755);
    return bin;
}

/** Gone from the process table; an exited orphan awaiting its new parent's wait(2) is a zombie and has ended. */
const gone = (pid: number) => {
    try {
        return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
            .trim()
            .startsWith('Z');
    } catch {
        return true;
    }
};

const SERVICE = 'services:\n  - name: stub-svc\n    image: factory-jobs-smoke-svc\n';
const MALFORMED = 'services:\n  - name: db\n    image: postgres\n    ports: ["5432:5432"]\n';

describe('the origin plan reader', () => {
    it('reads the plan at a named branch, pinned to its revision', async () => {
        const { base, tip } = mirror('acme/web', [null, SERVICE]);

        const plan = await readerOver(base).reader.read(gh('acme/web'), 'main');

        expect(plan).toMatchObject({ revision: tip, error: null });
        expect(plan.services.map((service) => service.name)).toEqual(['stub-svc']);
    });

    it('reads the origin default branch when the thread has no base branch', async () => {
        const { base, tip } = mirror('acme/web', [SERVICE], 'trunk');

        expect(await readerOver(base).reader.read(gh('acme/web'), null)).toMatchObject({ revision: tip, error: null });
    });

    it('answers a malformed file with the refusal production gives', async () => {
        const { base } = mirror('acme/web', [MALFORMED]);

        const plan = await readerOver(base).reader.read(gh('acme/web'), 'main');

        expect(plan.error).toContain('.bellows.yaml');
        expect(plan.services).toEqual([]);
    });

    it('refuses a file over the size the App path refuses', async () => {
        const { base } = mirror('acme/web', [`${SERVICE}# ${'x'.repeat(70_000)}\n`]);

        expect((await readerOver(base).reader.read(gh('acme/web'), 'main')).error).toContain(
            '.bellows.yaml is larger than 65536 bytes'
        );
    });

    it('answers no plan, with the revision, for a reachable repository without the file', async () => {
        const { base, tip } = mirror('acme/web', [null]);

        expect(await readerOver(base).reader.read(gh('acme/web'), 'main')).toMatchObject({
            revision: tip,
            error: null,
            services: [],
            config: null,
        });
    });

    it('answers a confirmed missing branch as a refusal value, not a throw', async () => {
        const { base } = mirror('acme/web', [SERVICE]);

        expect(await readerOver(base).reader.read(gh('acme/web'), 'release')).toMatchObject({
            revision: null,
            services: [],
            error: expect.stringContaining('acme/web'),
        });
    });

    it('refuses a revision expression as a branch name instead of resolving it', async () => {
        const { base } = mirror('acme/web', [SERVICE, null]);

        expect(await readerOver(base).reader.read(gh('acme/web'), 'main~1')).toMatchObject({
            revision: null,
            services: [],
            error: expect.stringContaining('acme/web'),
        });
    });

    it('rejects as an outage for a repository the origin does not have, never "no plan"', async () => {
        const { base } = mirror('acme/web', [SERVICE]);

        for (const branch of ['main', null]) {
            await expect(readerOver(base).reader.read(gh('acme/other'), branch)).rejects.toMatchObject({
                kind: READ_TRANSPORT,
            });
        }
    });

    it("names git's last stderr line in the outage, so a refused connection says so", async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const fatal = 'fatal: unable to connect to 127.0.0.1';

        for (const branch of ['main', null]) {
            const read = readerOver(base, { gitBin: refusingGit(fatal) }).reader.read(gh('acme/web'), branch);
            await expect(read).rejects.toMatchObject({ kind: READ_TRANSPORT });
            await expect(read).rejects.toThrow(`git ls-remote: exited 128: ${fatal}`);
        }
    });

    it('keeps only a bounded tail of a huge stderr', async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const fatal = 'fatal: unable to connect to 127.0.0.1';

        const huge = await readerOver(base, { gitBin: refusingGit(fatal, 1 << 20) })
            .reader.read(gh('acme/web'), 'main')
            .catch((e: Error) => e);
        expect((huge as Error).message).toContain(fatal);
        expect((huge as Error).message.length).toBeLessThan(400);

        // One megabyte with no line break at all still yields a bounded message.
        const unbroken = await readerOver(base, { gitBin: refusingGit('', 1 << 20) })
            .reader.read(gh('acme/web'), 'main')
            .catch((e: Error) => e);
        expect((unbroken as Error).message).toMatch(/^git ls-remote: exited 128/);
        expect((unbroken as Error).message.length).toBeLessThan(400);
    });

    it('rejects as an outage when the origin accepts and never answers, within the deadline', async () => {
        const { expire, spy } = controlledDeadline();
        const origin = await silentOrigin();
        const { reader } = readerOver(origin.url, { timeoutMs: DEADLINE_MS });

        const settled = reader.read(gh('acme/web'), 'main').then(
            () => null,
            (e: unknown) => e
        );
        await origin.connected;
        expire();

        expect(await settled).toMatchObject({ kind: READ_TRANSPORT });
        expect(spy).toHaveBeenCalledWith(DEADLINE_MS);
    });

    it('carries the same deadline through the reads after the fetch', async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const { expire, spy } = controlledDeadline();
        const stalled = fifo();
        const { reader, leftovers } = readerOver(base, {
            timeoutMs: DEADLINE_MS,
            gitBin: slowGit('for-each-ref', stalled.path),
        });

        const settled = reader.read(gh('acme/web'), 'main').then(
            () => null,
            (e: unknown) => e
        );
        // The earlier git calls (init, ls-remote, fetch) ran for real: the deadline is still open at the stall.
        await stalled.drain();
        expire();

        expect(await settled).toMatchObject({ kind: READ_TRANSPORT });
        expect(spy).toHaveBeenCalledWith(DEADLINE_MS);
        expect(leftovers()).toEqual([]);
    });

    it('kills the whole git process group at the deadline, so no transport child outlives the read', async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const { expire, spy } = controlledDeadline();
        const pidPipe = fifo();
        const lifeline = fifo();
        // `init` is the read's first git call. The deadline is the test's to fire, after the child is running.
        const { reader } = readerOver(base, {
            timeoutMs: DEADLINE_MS,
            gitBin: forkingGit('init', pidPipe.path, lifeline.path),
        });
        const childGone = lifeline.drain(); // listening before the abort, so the EOF cannot be missed

        const settled = reader.read(gh('acme/web'), 'main').then(
            () => null,
            (e: unknown) => e
        );
        const child = Number((await pidPipe.drain()).trim());
        expect(child).toBeGreaterThan(0);
        expect(gone(child)).toBe(false);
        expire();

        expect(await settled).toMatchObject({ kind: READ_TRANSPORT });
        expect(spy).toHaveBeenCalledWith(DEADLINE_MS);
        // The child alone holds the lifeline's write end, so its EOF is the child's exit: a group kill that missed it
        // leaves `sleep 30` holding the pipe and the 15 s hang guard fails the test. The process table is not polled,
        // since reaping an exited child is the reparenting init's to do, on no schedule the test owns.
        await childGone;
    }, 15_000);

    it('leaves no scratch directory behind: success, missing branch, outage and timeout', async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const { reader, leftovers } = readerOver(base);
        await reader.read(gh('acme/web'), 'main');
        await reader.read(gh('acme/web'), 'release');
        await expect(reader.read(gh('acme/other'), 'main')).rejects.toMatchObject({ kind: READ_TRANSPORT });
        expect(leftovers()).toEqual([]);

        const hung = readerOver((await silentOrigin()).url, { timeoutMs: 500 });
        await expect(hung.reader.read(gh('acme/web'), 'main')).rejects.toMatchObject({ kind: READ_TRANSPORT });
        expect(hung.leftovers()).toEqual([]);
    });

    it("fetches the plan blob only, leaving the repository's other blobs behind", async () => {
        const { base } = mirror('acme/web', [SERVICE]);
        const bare = join(base.replace('file://', ''), 'github.com/acme/web.git');
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

        const plan = await readerOver(base, { gitBin: bin }).reader.read(gh('acme/web'), 'main');

        expect(plan.error).toBeNull();
        expect(plan.services.map((service) => service.name)).toEqual(['stub-svc']);
        expect(readFileSync(missing, 'utf8')).toMatch(/^\?/m);
    });

    it("reads the plan from the ref's host", async () => {
        const dir = tempDir('origins-');
        const { tip: tipA } = seedOrigin(dir, 'github.com', 'o/n', [SERVICE]);
        const { base, tip: tipB } = seedOrigin(dir, 'gl.example', 'o/n', [MALFORMED]);
        const { reader } = readerOver(base);

        expect(await reader.read(gh('o/n'), 'main')).toMatchObject({ revision: tipA, error: null });
        const gitlab = await reader.read(gl('o/n'), 'main');
        expect(gitlab.revision).toBe(tipB);
        expect(gitlab.error).toContain('.bellows.yaml');
    });

    it('reads a nested path', async () => {
        const { base, tip } = seedOrigin(tempDir('origins-'), 'gl.example', 'g/sub/p', [SERVICE]);

        expect(await readerOver(base).reader.read(gl('g/sub/p'), 'main')).toMatchObject({ revision: tip, error: null });
    });

    it.each<RepoRef>([
        gl('../acme/web'),
        gl('acme/../web'),
        gl('g/./p'),
        { forge: 'gitlab', host: '..', path: 'o/n' },
        { forge: 'gitlab', host: '.', path: 'o/n' },
        { forge: 'gitlab', host: 'a/b', path: 'o/n' },
    ])('refuses %j without spawning git', async (ref) => {
        // A binary that cannot start would make any spawned git an outage; the ref is refused as a value first.
        const { reader, leftovers } = readerOver('file:///nowhere', { gitBin: '/nonexistent/git' });

        expect((await reader.read(ref, 'main')).error).toContain(ref.path);
        expect(leftovers()).toEqual([]);
    });
});
