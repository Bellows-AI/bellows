import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * A repository-free OpenCode task: the checkpoint script snapshots the session database alone (header with a null
 * tip, no bundle) and the restore script installs it back. Real node:sqlite, the script FILES as the container runs them.
 */
const SCRIPTS = join(import.meta.dirname, '..', 'src', 'scripts');
const CHUNK = 700;
const TOKEN = 'treeless-token';
const run = promisify(execFile);

interface Chunk {
    offset: number;
    length: number;
    sha256: string;
}
interface Verdict {
    ok: boolean;
    reason?: string | null;
    state?: string;
    kind?: string;
    transient?: boolean;
    restored?: boolean;
    headerFile?: string;
    parts?: { path: string; bytes: number }[];
}

let dir = '';
let server: Server | null = null;
beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'treeless-'));
});
afterEach(() => {
    server?.close();
    server = null;
    rmSync(dir, { recursive: true, force: true });
});

/** A WAL-mode database with a write no checkpoint has folded into the main file. */
function walDatabase(file: string): DatabaseSync {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('ses_1');");
    return db;
}

const checkpoint = (env: Record<string, string>): Verdict => {
    const out = spawnSync('node', ['--no-warnings', join(SCRIPTS, 'checkpoint.cjs')], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
    return JSON.parse(out.stdout.trim().split('\n').pop() ?? '{}') as Verdict;
};

const dbPath = () => join(dir, 'opencode', 'opencode.db');
const outDir = () => join(dir, 'checkpoint');

/** The stream the supervisor uploads for a verdict: the header line, then each part. */
function streamOf(verdict: Verdict): { stream: Buffer; chunks: Chunk[] } {
    const header = JSON.stringify(JSON.parse(readFileSync(verdict.headerFile!, 'utf8')));
    const stream = Buffer.concat([Buffer.from(`${header}\n`), ...verdict.parts!.map((p) => readFileSync(p.path))]);
    return { stream, chunks: chunksOf(stream) };
}
function chunksOf(stream: Buffer): Chunk[] {
    const chunks: Chunk[] = [];
    for (let offset = 0; offset < stream.length; offset += CHUNK) {
        const bytes = stream.subarray(offset, offset + CHUNK);
        chunks.push({ offset, length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return chunks;
}

async function serve(stream: Buffer, status = 200): Promise<string> {
    server = createServer((request, reply) => {
        const url = new URL(request.url ?? '', 'http://x');
        if (request.headers.authorization !== `Bearer ${TOKEN}` || url.pathname !== '/checkpoint/restore') {
            reply.writeHead(401).end('{}');
            return;
        }
        if (status !== 200) {
            reply.writeHead(status).end('{}');
            return;
        }
        const bytes = stream.subarray(Number(url.searchParams.get('offset')), undefined).subarray(0, CHUNK);
        reply.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
                bytes: bytes.toString('base64'),
                sha256: createHash('sha256').update(bytes).digest('hex'),
            })
        );
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const restore = async (chunks: Chunk[], url: string): Promise<Verdict> => {
    const { stdout } = await run('node', ['--no-warnings', join(SCRIPTS, 'checkpoint-restore.cjs')], {
        env: {
            ...process.env,
            OPENCODE_DB: dbPath(),
            CHUNKS: JSON.stringify(chunks),
            RESTORE_URL: url,
            RESTORE_TOKEN: TOKEN,
        },
        encoding: 'utf8',
    });
    return JSON.parse(stdout.trim().split('\n').pop()!) as Verdict;
};

const sessions = (file: string): string[] => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        return db
            .prepare('SELECT id FROM session')
            .all()
            .map((row) => String(row.id));
    } finally {
        db.close();
    }
};

describe('the checkpoint script without a checkout', () => {
    it('snapshots only the database, WAL write included, under a header with no tip', () => {
        mkdirSync(join(dir, 'opencode'));
        const db = walDatabase(dbPath());
        db.exec("INSERT INTO session VALUES ('ses_wal')");
        const verdict = checkpoint({ OPENCODE_DB: dbPath(), OUT_DIR: outDir() });
        db.close();

        expect(verdict).toMatchObject({ ok: true, state: 'complete' });
        const header = JSON.parse(readFileSync(verdict.headerFile!, 'utf8')) as Record<string, unknown>;
        expect(header).toMatchObject({ version: 1, tip: null, bundleBytes: 0, truncated: false });
        expect(verdict.parts?.map((p) => p.path)).toEqual([join(outDir(), 'opencode.db')]);
        expect(sessions(verdict.parts![0]!.path)).toEqual(['ses_1', 'ses_wal']);
    });

    it('answers none with no database file', () => {
        expect(checkpoint({ OPENCODE_DB: dbPath(), OUT_DIR: outDir() })).toEqual({ ok: true, state: 'none' });
        expect(checkpoint({ OUT_DIR: outDir() })).toEqual({ ok: true, state: 'none' });
    });

    it('cuts a database above the cap: the header alone, truncated', () => {
        mkdirSync(join(dir, 'opencode'));
        walDatabase(dbPath()).close();
        const verdict = checkpoint({ OPENCODE_DB: dbPath(), OUT_DIR: outDir(), CAP_BYTES: '10' });
        expect(verdict).toMatchObject({ ok: true, state: 'truncated', cause: 'checkpoint_cap', parts: [] });
    });
});

describe('the restore script without a checkout', () => {
    async function taken(): Promise<{ stream: Buffer; chunks: Chunk[]; original: Buffer }> {
        mkdirSync(join(dir, 'opencode'));
        walDatabase(dbPath()).close();
        const verdict = checkpoint({ OPENCODE_DB: dbPath(), OUT_DIR: outDir() });
        const original = readFileSync(verdict.parts![0]!.path);
        rmSync(join(dir, 'opencode'), { recursive: true });
        return { ...streamOf(verdict), original };
    }

    it('round trip: the database comes back byte for byte, stale sidecars removed', async () => {
        const { stream, chunks, original } = await taken();
        mkdirSync(join(dir, 'opencode'));
        const url = await serve(stream);
        // A stale sidecar without its database: the install must not leave it to corrupt the new file.
        writeFileSync(`${dbPath()}-wal`, 'stale');
        writeFileSync(`${dbPath()}-shm`, 'stale');

        expect(await restore(chunks, url)).toMatchObject({ ok: true, restored: true });
        expect(readFileSync(dbPath()).equals(original)).toBe(true);
        expect(existsSync(`${dbPath()}-wal`)).toBe(false);
        expect(existsSync(`${dbPath()}-shm`)).toBe(false);
        expect(readdirSync(join(dir, 'opencode'))).toEqual(['opencode.db']);
        expect(sessions(dbPath())).toEqual(['ses_1']);
    });

    it('keeps a database already on the volume untouched', async () => {
        const { stream, chunks } = await taken();
        mkdirSync(join(dir, 'opencode'));
        writeFileSync(dbPath(), 'newer than the checkpoint');
        const url = await serve(stream);

        expect(await restore(chunks, url)).toMatchObject({ ok: true, restored: false });
        expect(readFileSync(dbPath(), 'utf8')).toBe('newer than the checkpoint');
    });

    it('refuses as checkpoint_unrestorable, only because the database is absent and no checkpoint carries one', async () => {
        const verdict = await restore([], 'http://127.0.0.1:1');
        expect(verdict).toMatchObject({ ok: false, kind: 'checkpoint_unrestorable' });
        expect(verdict.transient).toBeUndefined();
    });

    it.each([
        ['truncated', { version: 1, tip: null, truncated: true, bundleBytes: 0, sqliteBytes: 0 }],
        ['database-less', { version: 1, tip: null, truncated: false, bundleBytes: 0, sqliteBytes: 0 }],
    ])('refuses a %s checkpoint as checkpoint_unrestorable', async (_name, header) => {
        const stream = Buffer.from(`${JSON.stringify(header)}\n`);
        const url = await serve(stream);
        mkdirSync(join(dir, 'opencode'));
        expect(await restore(chunksOf(stream), url)).toMatchObject({ ok: false, kind: 'checkpoint_unrestorable' });
        expect(existsSync(dbPath())).toBe(false);
    });

    it('answers transient on a 503 chunk, leaving no database and no temp file', async () => {
        const { stream, chunks } = await taken();
        mkdirSync(join(dir, 'opencode'));
        const url = await serve(stream, 503);

        const verdict = await restore(chunks, url);
        expect(verdict).toMatchObject({ ok: false, transient: true });
        expect(verdict.kind).toBeUndefined();
        expect(readdirSync(join(dir, 'opencode'))).toEqual([]);
    }, 60_000);
});
