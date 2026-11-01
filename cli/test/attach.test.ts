import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, uploadAllowanceMs } from '../src/attach.js';
import { run } from '../src/run.js';
import { BOARD_URL, ENV, NO_SETTINGS } from './harness.js';

interface Upload {
    name: string;
    bytes: Buffer;
    key: string | null;
    contentType: string | null;
}
interface JobCall {
    path: string;
    key: string | null;
    body: Record<string, unknown>;
}

const UUID = /^[0-9a-f-]{36}$/;
const isRoot = process.getuid?.() === 0;

let dir: string;
beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bellows-attach-'));
});

async function file(name: string, content: string | Buffer): Promise<string> {
    const path = join(dir, `${randomUUID()}-${name}`);
    await writeFile(path, content);
    return path;
}

/** A named file in its own directory, so its display name is exactly `name`. */
async function named(name: string, content: string | Buffer): Promise<string> {
    const folder = join(dir, randomUUID());
    await mkdir(folder);
    const path = join(folder, name);
    await writeFile(path, content);
    return path;
}

/** A board that stores uploads, replays both uploads and creates by key, and can refuse the nth upload. */
function board(
    options: {
        refuseUpload?: (n: number) => Response | undefined;
        uploadFault?: () => Response | undefined;
        jobFault?: () => Response | undefined;
    } = {}
) {
    const uploads: Upload[] = [];
    const jobs: JobCall[] = [];
    const byKey = new Map<string, Response>();
    const ids = new Map<string, string>();
    let tasks = 0;
    const out: string[] = [];
    const err: string[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
        const path = String(url).replace(BOARD_URL, '');
        const headers = new Headers(init?.headers);
        const key = headers.get('idempotency-key');
        if (path === '/api/attachments') {
            const bytes = Buffer.from(init?.body as Uint8Array);
            const upload = {
                name: decodeURIComponent(headers.get('x-attachment-name') ?? ''),
                bytes,
                key,
                contentType: headers.get('content-type'),
            };
            uploads.push(upload);
            const fault = options.uploadFault?.();
            if (fault) return fault;
            const refused = options.refuseUpload?.(uploads.length);
            if (refused) return refused;
            const replay = key !== null && ids.has(key);
            const id = (key !== null && ids.get(key)) || randomUUID();
            if (key !== null) ids.set(key, id);
            return Response.json(
                { id, name: upload.name, state: 'ready' },
                { status: 201, headers: replay ? { 'idempotency-replayed': 'true' } : {} }
            );
        }
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        jobs.push({ path, key, body });
        const jobFault = options.jobFault?.();
        if (jobFault) return jobFault;
        if (key !== null && byKey.has(key)) {
            return new Response(byKey.get(key)!.clone().body, {
                status: 201,
                headers: { 'idempotency-replayed': 'true', 'content-type': 'application/json' },
            });
        }
        tasks++;
        const response = Response.json({ id: `job-${tasks}`, status: 'queued' }, { status: 201 });
        if (key !== null) byKey.set(key, response.clone());
        return response;
    }) as unknown as typeof globalThis.fetch;
    const go = (argv: string[], env: NodeJS.ProcessEnv = ENV) =>
        run(argv, {
            env,
            settings: NO_SETTINGS,
            fetch,
            sleep: async () => {},
            stdout: (text) => out.push(text),
            stderr: (text) => err.push(text),
        });
    return {
        uploads,
        jobs,
        go,
        out: () => out.join(''),
        err: () => err.join(''),
        tasks: () => tasks,
        requests: () => uploads.length + jobs.length,
    };
}

describe('--attach', () => {
    it('uploads each file with its exact bytes and name, then submits the ids in order', async () => {
        const spec = await named('my spec.pdf', Buffer.from('%PDF-1.7 spec'));
        const image = await named('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]));
        const b = board();

        const code = await b.go(['job', 'create', 'look at these', '--attach', spec, '--attach', image]);

        expect(code).toBe(0);
        expect(b.uploads.map((u) => u.name)).toEqual(['my spec.pdf', 'a.png']);
        expect(b.uploads[0]!.bytes.toString()).toBe('%PDF-1.7 spec');
        expect([...b.uploads[1]!.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 255]);
        expect(b.uploads.every((u) => u.contentType === 'application/octet-stream')).toBe(true);
        expect(b.jobs).toHaveLength(1);
        expect(b.jobs[0]!.path).toBe('/api/jobs');
        expect(b.jobs[0]!.body.command).toBe('look at these');
        expect((b.jobs[0]!.body.attachments as string[]).every((id) => UUID.test(id))).toBe(true);
        expect(b.jobs[0]!.body.attachments).toHaveLength(2);
        expect(b.out()).toBe('queued job-1\n');
    });

    it('sends the files with a follow-up', async () => {
        const note = await file('note.md', '# note');
        const b = board();

        expect(await b.go(['job', 'follow-up', 'job-9', 'more', '--attach', note])).toBe(0);

        expect(b.jobs[0]!.path).toBe('/api/jobs/job-9/follow-up');
        expect(b.jobs[0]!.body.command).toBe('more');
        expect(b.jobs[0]!.body.attachments).toHaveLength(1);
    });

    it('leaves a text-only create unchanged', async () => {
        const b = board();
        expect(await b.go(['job', 'create', 'echo hi'])).toBe(0);
        expect(b.uploads).toEqual([]);
        expect(b.jobs[0]!.body).toEqual({ command: 'echo hi' });
        expect(b.err()).toBe('');
    });

    describe('refused before any request', () => {
        it('names a missing file as missing', async () => {
            const b = board();
            const ok = await file('ok.txt', 'x');
            const code = await b.go(['job', 'create', 'x', '--attach', ok, '--attach', join(dir, 'nope.txt')]);
            expect(code).not.toBe(0);
            expect(b.err()).toContain('no such file');
            expect(b.requests()).toBe(0);
        });

        it('names a path under a regular file as missing too', async () => {
            const b = board();
            const ok = await file('ok.txt', 'x');
            expect(await b.go(['job', 'create', 'x', '--attach', join(ok, 'inside.txt')])).not.toBe(0);
            expect(b.err()).toContain('no such file');
            expect(b.requests()).toBe(0);
        });

        it.skipIf(isRoot)('names an unreadable file as unreadable, never as missing', async () => {
            const secret = await file('secret.txt', 'x');
            await chmod(secret, 0o000);
            const b = board();
            const code = await b.go(['job', 'create', 'x', '--attach', secret]);
            expect(code).not.toBe(0);
            expect(b.err()).toContain('not readable');
            expect(b.err()).not.toContain('no such file');
            expect(b.requests()).toBe(0);
        });

        it('refuses a directory', async () => {
            const b = board();
            expect(await b.go(['job', 'create', 'x', '--attach', dir])).not.toBe(0);
            expect(b.err()).toContain('not a regular file');
            expect(b.requests()).toBe(0);
        });

        it('refuses a file over the size limit', async () => {
            const big = await file('big.txt', '');
            await truncate(big, MAX_FILE_BYTES + 1);
            const b = board();
            expect(await b.go(['job', 'create', 'x', '--attach', big])).not.toBe(0);
            expect(b.err()).toContain('limit');
            expect(b.requests()).toBe(0);
        });

        it('refuses a type the board does not accept', async () => {
            const b = board();
            expect(await b.go(['job', 'create', 'x', '--attach', await file('run.exe', 'x')])).not.toBe(0);
            expect(b.err()).toContain('not an accepted type');
            expect(b.requests()).toBe(0);
        });

        it('refuses more files than a request may carry', async () => {
            const paths = await Promise.all(Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`, 'x')));
            const b = board();
            expect(await b.go(['job', 'create', 'x', ...paths.flatMap((p) => ['--attach', p])])).not.toBe(0);
            expect(b.requests()).toBe(0);
        });
    });

    it('submits nothing when the board refuses the second file', async () => {
        const b = board({
            refuseUpload: (n) =>
                n === 2
                    ? Response.json({ error: 'not accepted', code: 'UNSUPPORTED_ATTACHMENT' }, { status: 415 })
                    : undefined,
        });
        const code = await b.go([
            'job',
            'create',
            'x',
            '--attach',
            await file('a.txt', 'a'),
            '--attach',
            await file('b.txt', 'b'),
        ]);

        expect(code).not.toBe(0);
        expect(b.uploads).toHaveLength(2);
        expect(b.jobs).toEqual([]);
        expect(b.err()).toContain('b.txt');
        expect(b.err()).toContain('not accepted');
    });

    it('keeps --json stdout to the one envelope and puts progress on stderr', async () => {
        const b = board();
        const code = await b.go(['job', 'create', 'x', '--attach', await named('a.txt', 'a'), '--json']);

        expect(code).toBe(0);
        const envelope = JSON.parse(b.out()) as { ok: boolean; data: { id: string } };
        expect(envelope.ok).toBe(true);
        expect(envelope.data.id).toBe('job-1');
        expect(b.err()).toContain('uploading a.txt');
    });

    describe('idempotency', () => {
        it('derives each upload key from --idempotency-key, so a rerun replays the create', async () => {
            const paths = [await file('a.txt', 'a'), await file('b.txt', 'b')];
            const argv = [
                'job',
                'create',
                'x',
                '--idempotency-key',
                'attempt-0001',
                ...paths.flatMap((p) => ['--attach', p]),
            ];
            const b = board();

            expect(await b.go(argv)).toBe(0);
            expect(b.uploads.map((u) => u.key)).toEqual(['attempt-0001.a1', 'attempt-0001.a2']);
            expect(b.jobs[0]!.key).toBe('attempt-0001');

            expect(await b.go(argv)).toBe(0);
            expect(b.uploads.map((u) => u.key)).toEqual([
                'attempt-0001.a1',
                'attempt-0001.a2',
                'attempt-0001.a1',
                'attempt-0001.a2',
            ]);
            expect(b.tasks()).toBe(1);
            expect(b.err()).toContain('replayed:');
        });

        it('gives every upload a fresh random key when none is named', async () => {
            const b = board();
            await b.go([
                'job',
                'create',
                'x',
                '--attach',
                await file('a.txt', 'a'),
                '--attach',
                await file('b.txt', 'b'),
            ]);
            const keys = b.uploads.map((u) => u.key);
            expect(keys.every((k) => k !== null && UUID.test(k))).toBe(true);
            expect(new Set(keys).size).toBe(2);
            expect(b.jobs[0]!.key).toBeNull();
        });

        it('replays a failed upload under the same key', async () => {
            let faults = 1;
            const b = board({ uploadFault: () => (faults-- > 0 ? new Response('down', { status: 503 }) : undefined) });
            expect(await b.go(['job', 'create', 'x', '--attach', await file('a.txt', 'a')])).toBe(0);
            expect(b.uploads).toHaveLength(2);
            expect(b.uploads[0]!.key).toBe(b.uploads[1]!.key);
        });

        it('names the same --attach set in the recover hint after an uncertain create', async () => {
            const b = board({ jobFault: () => new Response('down', { status: 503 }) });
            const code = await b.go(
                ['job', 'create', 'x', '--idempotency-key', 'attempt-0001', '--attach', await file('a.txt', 'a')],
                { ...ENV, FACTORY_READ_RETRIES: '0' }
            );
            expect(code).not.toBe(0);
            expect(b.err()).toContain('--idempotency-key attempt-0001');
            expect(b.err()).toContain('the same --attach set');
        });
    });
});

describe('uploadAllowanceMs', () => {
    it('gives a maximum-size file a deadline beyond the base request timeout', () => {
        expect(uploadAllowanceMs(MAX_FILE_BYTES)).toBeGreaterThan(30_000);
        expect(uploadAllowanceMs(0)).toBe(0);
    });
});
