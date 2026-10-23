import { execFile, execFileSync, spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { uploadRunArtifacts } from '../src/artifact-upload.js';
import type { ArtifactStreamRef, BoardJob } from '../src/board/board.js';
import { mergeOpencodeOutcome, parseOpencodeExport, parseOpencodeRunOutcome } from '../src/close-read.js';
import type { RunOutcome } from '../src/runner.js';
import { insertMessage, insertPart, MINE, seedOpencodeDb } from './fixtures/opencode-db.js';
import { hasNodeSqlite, pathOf } from './fixtures/scripts-support.js';

const execFileAsync = promisify(execFile);
const KIB = 1024;
const EXPORT_LIMIT = 256 * KIB;
const CONSISTENCY_ROUNDS = 8;
// Committing flat out is what puts a commit between an unsafe export's reads; the writer runs at a
// low priority so it never starves the rest of a parallel suite.
const WRITER_PAIRS = 40_000;
const WRITER_NICE = 15;
// Large enough that no stream is cut: a cut drops the oldest rows and would read as inconsistency.
const UNCAPPED_EXPORT = String(64 * KIB * KIB);
const WRITER_POLL_MS = 20;
const WRITER_WAIT_ROUNDS = 500;

const exportOptions = (dbPath: string, env: Record<string, string>) => ({
    env: {
        ...process.env,
        OPENCODE_DB: dbPath,
        OPENCODE_DIR: MINE,
        EXPORT_LIMIT_BYTES: String(EXPORT_LIMIT),
        ...env,
    },
    encoding: 'utf8' as const,
    maxBuffer: 64 * KIB * KIB,
});

const runExport = (dbPath: string, env: Record<string, string> = {}): string =>
    execFileSync('node', [pathOf('opencode-readout.cjs')], exportOptions(dbPath, env));

// Async, so a long export never blocks the worker's event loop beside the rest of the suite.
const runExportAsync = async (dbPath: string, env: Record<string, string> = {}): Promise<string> =>
    (await execFileAsync('node', [pathOf('opencode-readout.cjs')], exportOptions(dbPath, env))).stdout;

// biome-ignore lint/suspicious/noExplicitAny: export lines are probed field by field in assertions
const jsonLines = (stdout: string): Record<string, any>[] =>
    stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));

/**
 * A readout log the kubernetes transport cut to its tail (issue #825): whatever stream it now opens
 * on lost its head, whatever that stream's own lines say; a stream wholly after it did not.
 */
describe('the opencode export parse of a head-cut readout', () => {
    const rawLine = (n: number) => JSON.stringify({ stream: 'raw', table: 'part', row: { n } });
    const normalizedLine = (n: number) => JSON.stringify({ stream: 'normalized', event: { n } });
    const answer = JSON.stringify({ id: 'ses_mine' });

    it('marks the first stream a head-cut readout kept as truncated, and only that one', () => {
        const opensOnRaw = [`w":2}}`, rawLine(3), normalizedLine(1), answer].join('\n');
        const opensOnNormalized = [`t":{"n":`, normalizedLine(2), answer].join('\n');

        expect(parseOpencodeExport(opensOnRaw, true)).toMatchObject({
            raw: { truncated: true },
            normalized: { truncated: false },
        });
        expect(parseOpencodeExport(opensOnNormalized, true)).toMatchObject({
            raw: null,
            normalized: { truncated: true },
        });
        expect(parseOpencodeExport(opensOnRaw)).toMatchObject({
            raw: { truncated: false },
            normalized: { truncated: false },
        });
        expect(parseOpencodeRunOutcome(opensOnRaw, true).exported).toMatchObject({ raw: { truncated: true } });
    });
});

/**
 * The opencode session export (issues #735, #767), against a real sqlite database: the readout
 * prints every raw row and a normalized event stream ahead of its answer line, all inside one read
 * transaction. The suite pins what the export keeps (tool calls, usage, provenance), the cap's
 * marker, and — the part worth executing — a consistent snapshot while a writer commits.
 */
describe.skipIf(!hasNodeSqlite())('the opencode session export', () => {
    let dbPath: string;
    beforeEach(() => {
        dbPath = seedOpencodeDb('factory-oexport-', { role: 'assistant', time: { created: 1000 } }, true);
    });

    it('prints every raw row verbatim and keeps the answer line last', () => {
        const db = new DatabaseSync(dbPath);
        const user = insertMessage(db, 'ses_mine', { role: 'user', time: { created: 2001 } });
        insertPart(db, user, 'ses_mine', 'fix the build');
        db.close();
        const lines = jsonLines(runExport(dbPath));
        const raw = lines.filter((l) => l.stream === 'raw');
        expect(raw.filter((l) => l.table === 'session').map((l) => l.row.id)).toEqual(['ses_other', 'ses_mine']);
        expect(raw.filter((l) => l.table === 'message')).toHaveLength(2);
        expect(raw.find((l) => l.table === 'part')?.row).toMatchObject({ message_id: user, session_id: 'ses_mine' });
        expect(lines.at(-1)).toMatchObject({ id: 'ses_mine' });
        expect(lines.at(-1)?.stream).toBeUndefined();
    });

    it('normalizes with provenance, tool calls and usage', () => {
        const db = new DatabaseSync(dbPath);
        const assistant = insertMessage(db, 'ses_mine', {
            role: 'assistant',
            time: { created: 2002 },
            modelID: 'm-1',
            providerID: 'p-1',
            finish: 'stop',
            tokens: { total: 90, input: 40, output: 50 },
            cost: 0.02,
        });
        const addPart = (data: object) =>
            db
                .prepare('insert into part (message_id, session_id, data) values (?, ?, ?)')
                .run(assistant, 'ses_mine', JSON.stringify(data));
        addPart({
            type: 'tool',
            tool: 'bash',
            callID: 'call_1',
            state: { status: 'completed', input: { command: 'npm test' }, output: 'ok' },
        });
        addPart({ type: 'step-finish', reason: 'stop', tokens: { total: 90 }, cost: 0.02 });
        db.close();

        const events = jsonLines(runExport(dbPath)).filter((l) => l.stream === 'normalized');
        const message = events.find((e) => e.kind === 'message' && e.source.id === String(assistant));
        expect(message).toMatchObject({
            role: 'assistant',
            model: 'm-1',
            provider: 'p-1',
            usage: { tokens: { total: 90 }, cost: 0.02 },
            source: { table: 'message', session_id: 'ses_mine' },
        });
        expect(events.find((e) => e.kind === 'tool')).toMatchObject({
            tool: 'bash',
            callId: 'call_1',
            status: 'completed',
            input: { command: 'npm test' },
            output: 'ok',
            source: { table: 'part', message_id: String(assistant), session_id: 'ses_mine' },
        });
        expect(events.find((e) => e.kind === 'step-finish')?.usage).toMatchObject({ cost: 0.02 });
    });

    it('tail-keeps each stream at the cap, leading with a marker that says what was dropped', () => {
        const db = new DatabaseSync(dbPath);
        for (let i = 0; i < 30; i += 1) {
            const id = insertMessage(db, 'ses_mine', { role: 'user', time: { created: 3000 + i } });
            insertPart(db, id, 'ses_mine', 'x'.repeat(KIB));
        }
        db.close();
        const stdout = runExport(dbPath, { EXPORT_LIMIT_BYTES: String(8 * KIB) });
        const raw = jsonLines(stdout).filter((l) => l.stream === 'raw');
        expect(raw[0]).toMatchObject({ truncated: true });
        expect(raw[0]?.droppedLines).toBeGreaterThan(0);
        // The newest rows survive; whole lines only.
        expect(raw.at(-1)?.row.session_id).toBe('ses_mine');
        const parsed = parseOpencodeExport(stdout);
        expect(parsed?.raw?.truncated).toBe(true);
        expect(parsed?.raw?.content.split('\n').every((line) => line.startsWith('{"stream":"raw","table"'))).toBe(true);
    });

    it('prints no export without a cap, and the driver parse still answers', () => {
        const { EXPORT_LIMIT_BYTES: _omit, ...env } = { ...process.env, EXPORT_LIMIT_BYTES: '' };
        const stdout = execFileSync('node', [pathOf('opencode-readout.cjs')], {
            env: { ...env, OPENCODE_DB: dbPath, OPENCODE_DIR: MINE },
            encoding: 'utf8',
        });
        expect(stdout.trim().split('\n')).toHaveLength(1);
        expect(parseOpencodeRunOutcome(stdout)).toMatchObject({ sessionId: 'ses_mine' });
        expect(parseOpencodeRunOutcome(stdout).exported).toBeUndefined();
    });

    it('uploads the raw rows and the normalized stream through the chunk route, under the session', async () => {
        const db = new DatabaseSync(dbPath);
        const id = insertMessage(db, 'ses_mine', { role: 'assistant', time: { created: 2002 }, tokens: { total: 5 } });
        insertPart(db, id, 'ses_mine', 'done');
        db.close();

        const outcome: RunOutcome = { exitCode: 0, output: '', timedOut: false, started: true };
        mergeOpencodeOutcome(outcome, parseOpencodeRunOutcome(runExport(dbPath)), null);

        const streams = new Map<string, string>();
        const manifests: string[] = [];
        const board = {
            async putArtifactChunk(_job: BoardJob, ref: ArtifactStreamRef, _offset: number, bytes: Uint8Array) {
                const key = `${ref.executor}/${ref.session}/${ref.stream}`;
                streams.set(key, (streams.get(key) ?? '') + Buffer.from(bytes).toString('utf8'));
                return { result: 'stored' as const };
            },
            async finalizeArtifact(_job: BoardJob, ref: ArtifactStreamRef) {
                manifests.push(ref.stream);
                return 'stored' as const;
            },
        };
        const io = { log: () => undefined, sleep: async () => undefined };
        await uploadRunArtifacts(
            { board, job: { id: 'job-1', claimSeq: 1 } as BoardJob, executorType: 'opencode', outcome },
            io
        );

        expect([...streams.keys()].sort()).toEqual([
            'opencode/ses_mine/transcript',
            'opencode/ses_mine/transcript-raw',
        ]);
        expect(manifests.sort()).toEqual(['transcript', 'transcript-raw']);
        expect(streams.get('opencode/ses_mine/transcript-raw')).toContain('"table":"part"');
        expect(streams.get('opencode/ses_mine/transcript')).toContain('"kind":"text"');
    });

    // A writer commits a message and its part in ONE transaction, forever. Whatever instant an
    // export lands on, the rows it read must be a prefix of those commits: parts never fall
    // behind or run ahead of the messages that own them. Separate reads would break this.
    it('exports one consistent snapshot while the database is being written', async () => {
        const setup = new DatabaseSync(dbPath);
        setup.exec('pragma journal_mode=wal');
        const baseline = {
            messages: Number(setup.prepare('select count(*) n from message').get()!.n),
            parts: Number(setup.prepare('select count(*) n from part').get()!.n),
        };
        setup.close();

        const writer = spawn(
            'node',
            [
                '-e',
                `const { DatabaseSync } = require('node:sqlite');
                const db = new DatabaseSync(process.argv[1]);
                db.exec('pragma busy_timeout=5000');
                for (let i = 0; i < ${WRITER_PAIRS}; i += 1) {
                    db.exec('BEGIN');
                    const r = db.prepare('insert into message (session_id, data) values (?, ?)')
                        .run('ses_mine', JSON.stringify({ role: 'user', time: { created: 5000 + i } }));
                    db.prepare('insert into part (message_id, session_id, data) values (?, ?, ?)')
                        .run(Number(r.lastInsertRowid), 'ses_mine', JSON.stringify({ type: 'text', text: 'w' + i }));
                    db.exec('COMMIT');
                }`,
                dbPath,
            ],
            { stdio: 'ignore' }
        );
        if (writer.pid) setPriority(writer.pid, WRITER_NICE);
        try {
            const probe = new DatabaseSync(dbPath, { readOnly: true });
            for (let round = 0; round < WRITER_WAIT_ROUNDS; round += 1) {
                if (Number(probe.prepare('select count(*) n from message').get()!.n) > baseline.messages) break;
                await new Promise((resolve) => setTimeout(resolve, WRITER_POLL_MS));
            }
            probe.close();

            const sizes = new Set<number>();
            for (let round = 0; round < CONSISTENCY_ROUNDS; round += 1) {
                const lines = jsonLines(await runExportAsync(dbPath, { EXPORT_LIMIT_BYTES: UNCAPPED_EXPORT }));
                expect(lines.some((l) => l.truncated)).toBe(false);
                const raw = lines.filter((l) => l.stream === 'raw');
                const messages = raw.filter((l) => l.table === 'message').length;
                const parts = raw.filter((l) => l.table === 'part').length;
                expect(messages - parts).toBe(baseline.messages - baseline.parts);
                sizes.add(messages);
            }
            // The writer really was committing while the exports ran.
            expect(Math.max(...sizes)).toBeGreaterThan(baseline.messages);
        } finally {
            writer.kill();
        }
    }, 60_000);
});
