import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { SCRIPT_IDENTITY, git, hasGit, setupWorktreeFixture } from './fixtures/git-worktree-support.js';

/**
 * The checkpoint restore script (issue #775): a checkpoint taken by scripts/checkpoint.cjs from a worked
 * task tree, served chunk by chunk over a control endpoint, is rebuilt into a fresh directory by the
 * script FILE as the container runs it. Real git on a real partial clone.
 */
const SCRIPTS = join(import.meta.dirname, '..', 'src', 'scripts');
const CHUNK = 700;
const TOKEN = 'restore-token';

interface Verdict {
    ok: boolean;
    reason: string | null;
    kind?: string;
    restored?: boolean;
}

const run = promisify(execFile);

interface Transcripts {
    streams: {
        jobId: string;
        claimSeq: number;
        executor: string;
        session: string;
        bytes: number;
        chunks: { offset: number; length: number; sha256: string }[];
    }[];
    data: Map<string, Buffer>;
    corrupt?: string;
}

const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';

/** One raw transcript stream as the board lists it: its bytes cut into chunks, each with its digest. */
function transcriptStream(
    jobId: string,
    claimSeq: number,
    session: string,
    { bytes, from = 0 }: { bytes: Buffer; from?: number }
): Transcripts['streams'][number] {
    // The exporter keeps a file's byte offsets: a resumed session's later stream starts at `from`, where the
    // earlier attempt's bytes ended (scripts/claude-export.cjs: track.pos = stat.size).
    const chunks: Transcripts['streams'][number]['chunks'] = [];
    for (let at = 0; at < bytes.length; at += CHUNK) {
        const part = bytes.subarray(at, at + CHUNK);
        chunks.push({
            offset: from + at,
            length: part.length,
            sha256: createHash('sha256').update(part).digest('hex'),
        });
    }
    return { jobId, claimSeq, executor: 'claude-code', session, bytes: bytes.length, chunks };
}

describe.skipIf(!hasGit())('the checkpoint restore script', () => {
    const fx = setupWorktreeFixture();
    let server: Server | null = null;
    afterEach(() => {
        server?.close();
        server = null;
    });

    /** A task with every kind of change the checkpoint must carry, and one it must not. */
    function workedTree(): void {
        fx.pushToOrigin('gone.txt', 'to be deleted\n', 'a file the task deletes');
        expect(fx.sync()).toMatchObject({ ok: true });
        writeFileSync(join(fx.checkout(), '.gitignore'), 'node_modules/\n');
        git(fx.checkout(), 'add', '.gitignore');
        fx.commitIn(fx.checkout(), 'feature.txt', 'committed work\n', 'the task commit');
        writeFileSync(join(fx.checkout(), 'README.md'), '# edited\n');
        rmSync(join(fx.checkout(), 'gone.txt'));
        writeFileSync(join(fx.checkout(), 'untracked.txt'), 'never added\n');
        mkdirSync(join(fx.checkout(), 'node_modules'));
        writeFileSync(join(fx.checkout(), 'node_modules', 'dep.js'), 'ignored\n');
    }

    /** The checkpoint script's stream — header line, then the bundle — and the pointer the board would hold. */
    function checkpointStream(extra: Record<string, string> = {}) {
        const outDir = join(fx.dir(), 'checkpoint');
        const out = spawnSync('node', ['--no-warnings', join(SCRIPTS, 'checkpoint.cjs')], {
            env: {
                ...process.env,
                ...SCRIPT_IDENTITY,
                CHECKOUT: fx.checkout(),
                BRANCH: fx.branch(),
                OUT_DIR: outDir,
                ...extra,
            },
            encoding: 'utf8',
        });
        const verdict = JSON.parse(out.stdout.trim().split('\n').pop()!) as {
            headerFile: string;
            parts: { path: string }[];
        };
        const header = readFileSync(verdict.headerFile, 'utf8');
        const stream = Buffer.concat([
            Buffer.from(`${JSON.stringify(JSON.parse(header))}\n`),
            ...verdict.parts.map((part) => readFileSync(part.path)),
        ]);
        const chunks: { offset: number; length: number; sha256: string }[] = [];
        for (let offset = 0; offset < stream.length; offset += CHUNK) {
            const bytes = stream.subarray(offset, offset + CHUNK);
            chunks.push({ offset, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
        return { stream, chunks };
    }

    /** The control endpoint of a supervisor: `GET /checkpoint/restore?offset=` answers one chunk as JSON. */
    async function serve(
        stream: Buffer,
        { corrupt = false, transcripts = null }: { corrupt?: boolean; transcripts?: Transcripts | null } = {}
    ): Promise<{ url: string; asked: () => number }> {
        let asked = 0;
        server = createServer((request, reply) => {
            asked += 1;
            const url = new URL(request.url ?? '', 'http://x');
            const path = url.pathname;
            if (request.headers.authorization !== `Bearer ${TOKEN}`) {
                reply.writeHead(401).end('{}');
                return;
            }
            if (transcripts && path === '/checkpoint/transcripts') {
                reply
                    .writeHead(200, { 'content-type': 'application/json' })
                    .end(JSON.stringify({ streams: transcripts.streams }));
                return;
            }
            if (transcripts && path === '/checkpoint/transcripts/chunk') {
                const q = url.searchParams;
                const key = `${q.get('jobId')}/${q.get('claimSeq')}/${q.get('session')}`;
                const whole = transcripts.data.get(key);
                const first = transcripts.streams.find((s) => `${s.jobId}/${s.claimSeq}/${s.session}` === key)
                    ?.chunks[0]?.offset;
                const offset = Number(q.get('offset')) - (first ?? 0);
                if (!whole || offset < 0 || offset >= whole.length) {
                    reply.writeHead(404).end('{}');
                    return;
                }
                const bytes = Buffer.from(whole.subarray(offset, offset + CHUNK));
                const sha256 = createHash('sha256').update(bytes).digest('hex');
                if (transcripts.corrupt === key) bytes[0] = (bytes[0] ?? 0) ^ 0xff;
                reply
                    .writeHead(200, { 'content-type': 'application/json' })
                    .end(JSON.stringify({ bytes: bytes.toString('base64'), sha256 }));
                return;
            }
            if (path !== '/checkpoint/restore') {
                reply.writeHead(401).end('{}');
                return;
            }
            const offset = Number(url.searchParams.get('offset'));
            const bytes = Buffer.from(stream.subarray(offset, offset + CHUNK));
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            if (corrupt && offset > 0) bytes[0] = (bytes[0] ?? 0) ^ 0xff;
            reply
                .writeHead(200, { 'content-type': 'application/json' })
                .end(JSON.stringify({ bytes: bytes.toString('base64'), sha256 }));
        });
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        const address = server.address() as { port: number };
        return { url: `http://127.0.0.1:${address.port}`, asked: () => asked };
    }

    const restoreDir = () => join(fx.dir(), 'replacement');
    const restoredTree = () => join(restoreDir(), 'factory');

    async function restore(
        chunks: { offset: number; length: number; sha256: string }[],
        url: string,
        env: Record<string, string> = {}
    ): Promise<Verdict> {
        mkdirSync(restoreDir(), { recursive: true });
        const { stdout } = await run('node', ['--no-warnings', join(SCRIPTS, 'checkpoint-restore.cjs')], {
            env: {
                ...process.env,
                ...SCRIPT_IDENTITY,
                CHECKOUT: restoredTree(),
                REMOTE: `file://${fx.bare()}`,
                BRANCH: fx.branch(),
                CHUNKS: JSON.stringify(chunks),
                RESTORE_URL: url,
                RESTORE_TOKEN: TOKEN,
                ...env,
            },
            encoding: 'utf8',
        });
        return JSON.parse(stdout.trim().split('\n').pop()!) as Verdict;
    }

    const status = (cwd: string) => git(cwd, 'status', '--porcelain');

    it('rebuilds the tree: commits, the edit, the deletion and the untracked file; not the ignored directory', async () => {
        workedTree();
        const head = git(fx.checkout(), 'rev-parse', 'HEAD');
        const before = status(fx.checkout());
        const { stream, chunks } = checkpointStream();
        const { url } = await serve(stream);

        const verdict = await restore(chunks, url);

        expect(verdict).toEqual({ ok: true, reason: null, restored: true });
        expect(git(restoredTree(), 'rev-parse', 'HEAD')).toBe(head);
        expect(git(restoredTree(), 'branch', '--show-current')).toBe(fx.branch());
        // Every uncommitted change is back, unstaged — the stated limit of a restore.
        expect(status(restoredTree())).toBe(before);
        expect(readFileSync(join(restoredTree(), 'README.md'), 'utf8')).toBe('# edited\n');
        expect(readFileSync(join(restoredTree(), 'untracked.txt'), 'utf8')).toBe('never added\n');
        expect(existsSync(join(restoredTree(), 'gone.txt'))).toBe(false);
        expect(existsSync(join(restoredTree(), 'node_modules'))).toBe(false);
        expect(readdirSync(restoreDir())).toEqual(['factory']);
    });

    it('leaves the factory state namespace ignored, as the startup sync does', async () => {
        workedTree();
        const { stream, chunks } = checkpointStream();
        const { url } = await serve(stream);
        await restore(chunks, url);

        mkdirSync(join(restoredTree(), '.factory'));
        writeFileSync(join(restoredTree(), '.factory', 'state.json'), '{}\n');

        expect(status(restoredTree())).not.toContain('.factory');
    });

    it('answers ok and fetches nothing when the tree is already there: a restore that landed is not redone', async () => {
        workedTree();
        const { stream, chunks } = checkpointStream();
        const { url, asked } = await serve(stream);
        await restore(chunks, url);
        const calls = asked();

        const again = await restore(chunks, url);

        expect(again).toEqual({ ok: true, reason: null, restored: false });
        expect(asked()).toBe(calls);
    });

    it('answers ok and fetches nothing for a tree that is there when no checkpoint is owed (empty chunks)', async () => {
        workedTree();
        const { stream, chunks } = checkpointStream();
        const { url } = await serve(stream);
        await restore(chunks, url);

        expect(await restore([], url)).toEqual({ ok: true, reason: null, restored: false });
    });

    it('is checkpoint_unrestorable when no tree is there and no checkpoint is given', async () => {
        workedTree();
        const { stream } = checkpointStream();
        const { url } = await serve(stream);

        // `absent`: the volume is confirmed to hold no tree, the one answer that may let the driver drop it.
        expect(await restore([], url)).toMatchObject({ ok: false, kind: 'checkpoint_unrestorable', absent: true });
        expect(existsSync(restoredTree())).toBe(false);
    });

    it('is checkpoint_unrestorable when the checkpoint was truncated at its cap', async () => {
        workedTree();
        const { stream, chunks } = checkpointStream({ CAP_BYTES: '1' });
        const { url } = await serve(stream);

        const verdict = await restore(chunks, url);

        expect(verdict).toMatchObject({ ok: false, kind: 'checkpoint_unrestorable' });
        // A refused checkpoint says nothing about the volume: never `absent`.
        expect(verdict).not.toHaveProperty('absent');
        expect(existsSync(restoredTree())).toBe(false);
    });

    it('is checkpoint_unrestorable when a commit the bundle builds on is gone from the remote', async () => {
        workedTree();
        git(fx.checkout(), 'push', '--quiet', 'origin', fx.branch());
        const { stream, chunks } = checkpointStream();
        const { url } = await serve(stream);
        // A force-push / deleted branch: the pushed commit leaves the remote for good.
        git(fx.bare(), 'update-ref', '-d', `refs/heads/${fx.branch()}`);
        git(fx.bare(), 'reflog', 'expire', '--expire=now', '--all');
        git(fx.bare(), 'gc', '--quiet', '--prune=now');

        const verdict = await restore(chunks, url);

        expect(verdict).toMatchObject({ ok: false, kind: 'checkpoint_unrestorable' });
        expect(existsSync(restoredTree())).toBe(false);
        expect(readdirSync(restoreDir())).toEqual([]);
    });

    it('fails without a kind, and builds nothing, when a chunk does not match its sha256', async () => {
        workedTree();
        const { stream, chunks } = checkpointStream();
        expect(chunks.length).toBeGreaterThan(1);
        const { url } = await serve(stream, { corrupt: true });

        const verdict = await restore(chunks, url, { CHUNKS: JSON.stringify(chunks) });

        expect(verdict.ok).toBe(false);
        expect(verdict.kind).toBeUndefined();
        expect(existsSync(restoredTree())).toBe(false);
        expect(readdirSync(restoreDir())).toEqual([]);
    });

    it('fails without a kind when the control endpoint refuses the token', async () => {
        workedTree();
        const { stream, chunks } = checkpointStream();
        const { url } = await serve(stream);

        const verdict = await restore(chunks, url, { RESTORE_TOKEN: 'wrong' });

        expect(verdict.ok).toBe(false);
        expect(verdict.kind).toBeUndefined();
    });
    describe('the Claude sessions of the thread', () => {
        // A multi-line JSONL whose lines straddle chunk edges, and a session that two attempts wrote in turn.
        const jsonl = (label: string, lines: number) =>
            Buffer.from(
                Array.from({ length: lines }, (_, i) => JSON.stringify({ label, i, pad: 'x'.repeat(90) })).join('\n') +
                    '\n'
            );
        const sessionsDir = () => join(fx.dir(), 'transcripts', 'projects', '-task-factory');

        function thread(): { transcripts: Transcripts; original: Record<string, Buffer> } {
            const alpha = jsonl('alpha', 40);
            const beta = jsonl('beta', 25);
            const cut = 3_000;
            const streams = [
                transcriptStream(JOB_A, 1, 'alpha', { bytes: alpha.subarray(0, cut) }),
                transcriptStream(JOB_A, 2, 'alpha', { bytes: alpha.subarray(cut), from: cut }),
                transcriptStream(JOB_B, 1, 'beta', { bytes: beta }),
            ];
            const data = new Map<string, Buffer>([
                [`${JOB_A}/1/alpha`, alpha.subarray(0, cut)],
                [`${JOB_A}/2/alpha`, alpha.subarray(cut)],
                [`${JOB_B}/1/beta`, beta],
            ]);
            return { transcripts: { streams, data }, original: { alpha, beta } };
        }

        async function restoreSessions(transcripts: Transcripts) {
            workedTree();
            const { stream, chunks } = checkpointStream();
            const { url } = await serve(stream, { transcripts });
            return restore(chunks, url, { SESSIONS_DIR: sessionsDir() });
        }

        it('rebuilds every session file byte for byte, a session written by two attempts joined in order', async () => {
            const { transcripts, original } = thread();

            const verdict = await restoreSessions(transcripts);

            expect(verdict).toMatchObject({ ok: true, restored: true });
            expect(readFileSync(join(sessionsDir(), 'alpha.jsonl')).equals(original.alpha!)).toBe(true);
            expect(readFileSync(join(sessionsDir(), 'beta.jsonl')).equals(original.beta!)).toBe(true);
            expect(readdirSync(sessionsDir()).sort()).toEqual(['alpha.jsonl', 'beta.jsonl']);
        });

        // A limit, not a goal (docs/workspace.md): the stream identity carries no parent session, so a subagent
        // transcript the exporter found under <session>/subagents/ is restored beside the sessions.
        it('restores a subagent transcript as a session file of its own, beside the sessions', async () => {
            const { transcripts, original } = thread();
            const agent = jsonl('agent', 4);
            const verdict = await restoreSessions({
                ...transcripts,
                streams: [...transcripts.streams, transcriptStream(JOB_B, 1, 'agent-a1b2c3', { bytes: agent })],
                data: new Map([...transcripts.data, [`${JOB_B}/1/agent-a1b2c3`, agent]]),
            });

            expect(verdict).toMatchObject({ ok: true });
            expect(readFileSync(join(sessionsDir(), 'agent-a1b2c3.jsonl')).equals(agent)).toBe(true);
            expect(readFileSync(join(sessionsDir(), 'alpha.jsonl')).equals(original.alpha!)).toBe(true);
        });

        it('is checkpoint_unrestorable when a resumed stream does not start where the previous one ended', async () => {
            const { transcripts } = thread();
            const streams = transcripts.streams.map((s, i) =>
                i === 1 ? { ...s, chunks: s.chunks.map((c) => ({ ...c, offset: c.offset + 1 })) } : s
            );

            expect(await restoreSessions({ ...transcripts, streams })).toMatchObject({
                ok: false,
                kind: 'checkpoint_unrestorable',
            });
        });

        // The exporter writes a stream from offset 0 when it counts the file as fresh (a new inode after any
        // restore onto a new volume), so a later stream may re-cover bytes an earlier one held.
        it.each([
            ['from offset 0, covering the whole earlier stream', 0],
            ['from the middle of the earlier stream', 1_500],
        ])('joins a later stream that starts %s, writing each chunk at its own offset', async (_name, from) => {
            const { original } = thread();
            const cut = 3_000;
            const alpha = original.alpha!;
            const streams = [
                transcriptStream(JOB_A, 1, 'alpha', { bytes: alpha.subarray(0, cut) }),
                transcriptStream(JOB_A, 2, 'alpha', { bytes: alpha.subarray(from), from }),
            ];
            const data = new Map([
                [`${JOB_A}/1/alpha`, alpha.subarray(0, cut)],
                [`${JOB_A}/2/alpha`, alpha.subarray(from)],
            ]);

            const verdict = await restoreSessions({ streams, data });

            expect(verdict).toMatchObject({ ok: true, restored: true });
            expect(readFileSync(join(sessionsDir(), 'alpha.jsonl')).equals(alpha)).toBe(true);
        });

        it('is checkpoint_unrestorable when overlapping streams disagree on the bytes they share', async () => {
            const { original } = thread();
            const cut = 3_000;
            const alpha = original.alpha!;
            const other = Buffer.from(alpha);
            other[10] = (other[10] ?? 0) ^ 0xff;
            const streams = [
                transcriptStream(JOB_A, 1, 'alpha', { bytes: alpha.subarray(0, cut) }),
                transcriptStream(JOB_A, 2, 'alpha', { bytes: other }),
            ];
            const data = new Map([
                [`${JOB_A}/1/alpha`, alpha.subarray(0, cut)],
                [`${JOB_A}/2/alpha`, other],
            ]);

            expect(await restoreSessions({ streams, data })).toMatchObject({
                ok: false,
                kind: 'checkpoint_unrestorable',
            });
        });

        it('restores no sessions when the driver names no directory for them', async () => {
            const { transcripts } = thread();
            workedTree();
            const { stream, chunks } = checkpointStream();
            const { url } = await serve(stream, { transcripts });

            expect(await restore(chunks, url)).toMatchObject({ ok: true });
            expect(existsSync(sessionsDir())).toBe(false);
        });

        it('is checkpoint_unrestorable, and builds nothing, when a transcript chunk does not match its sha256', async () => {
            const { transcripts } = thread();

            const verdict = await restoreSessions({ ...transcripts, corrupt: `${JOB_B}/1/beta` });

            expect(verdict).toMatchObject({ ok: false, kind: 'checkpoint_unrestorable' });
            expect(existsSync(restoredTree())).toBe(false);
            expect(readdirSync(restoreDir())).toEqual([]);
        });

        it.each([
            ['has a gap', (s: Transcripts['streams'][number]) => ({ ...s, chunks: s.chunks.slice(1) })],
            ['is shorter than the board says', (s: Transcripts['streams'][number]) => ({ ...s, bytes: s.bytes + 1 })],
        ])('is checkpoint_unrestorable when a stream %s', async (_name, mutate) => {
            const { transcripts } = thread();
            const streams = transcripts.streams.map((s, i) => (i === 2 ? mutate(s) : s));

            const verdict = await restoreSessions({ ...transcripts, streams });

            expect(verdict).toMatchObject({ ok: false, kind: 'checkpoint_unrestorable' });
            expect(existsSync(restoredTree())).toBe(false);
            expect(existsSync(join(sessionsDir(), 'beta.jsonl'))).toBe(false);
            expect(readdirSync(sessionsDir())).toEqual([]);
        });

        it('refuses a session name that is not a plain file name', async () => {
            const { transcripts } = thread();
            const bad = transcriptStream(JOB_B, 2, '../escape', { bytes: Buffer.from('{}\n') });
            transcripts.streams.push(bad);
            transcripts.data.set(`${JOB_B}/2/../escape`, Buffer.from('{}\n'));

            const verdict = await restoreSessions(transcripts);

            expect(verdict).toMatchObject({ ok: false, kind: 'checkpoint_unrestorable' });
            expect(existsSync(join(fx.dir(), 'transcripts', 'escape.jsonl'))).toBe(false);
        });
    });

    describe('the OpenCode database', () => {
        const dbSource = () => join(fx.dir(), 'source-opencode.db');
        const dbTarget = () => join(fx.dir(), 'data', 'opencode', 'opencode.db');

        function seedDb() {
            const db = new DatabaseSync(dbSource());
            db.exec('create table session(id text primary key, title text)');
            db.exec("insert into session values ('ses_1', 'first'), ('ses_2', 'second')");
            db.close();
        }

        it('writes the snapshot to the data dir atomically, a stale WAL beside the old file removed', async () => {
            workedTree();
            seedDb();
            const { stream, chunks } = checkpointStream({ OPENCODE_DB: dbSource() });
            const { url } = await serve(stream);
            mkdirSync(join(fx.dir(), 'data', 'opencode'), { recursive: true });
            writeFileSync(`${dbTarget()}-wal`, 'stale write-ahead log');
            writeFileSync(`${dbTarget()}-shm`, 'stale shared memory');

            const verdict = await restore(chunks, url, { OPENCODE_DB: dbTarget() });

            expect(verdict).toMatchObject({ ok: true, restored: true });
            const db = new DatabaseSync(dbTarget(), { readOnly: true });
            expect(db.prepare('select id from session order by id').all()).toEqual([{ id: 'ses_1' }, { id: 'ses_2' }]);
            db.close();
            expect(readdirSync(join(fx.dir(), 'data', 'opencode'))).toEqual(['opencode.db']);
        });

        it('leaves a database alone when the checkpoint carries none, and when the driver names none', async () => {
            workedTree();
            const { stream, chunks } = checkpointStream();
            const { url } = await serve(stream);

            await restore(chunks, url, { OPENCODE_DB: dbTarget() });
            expect(existsSync(dbTarget())).toBe(false);

            rmSync(restoreDir(), { recursive: true, force: true });
            seedDb();
            const withDb = checkpointStream({ OPENCODE_DB: dbSource() });
            server?.close();
            const { url: second } = await serve(withDb.stream);
            await restore(withDb.chunks, second);
            expect(existsSync(dbTarget())).toBe(false);
        });
    });
});
