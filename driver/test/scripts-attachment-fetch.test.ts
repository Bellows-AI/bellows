import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The task input fetch script: the files a task's claim lists are pulled from the control endpoint's
 * `/input/<delivery>/<id>` route into a target directory as `<id><ext>`, behind a `manifest.json` written last.
 * The script FILE runs as the container runs it, against a fake control endpoint.
 */
const SCRIPTS = join(import.meta.dirname, '..', 'src', 'scripts');
const TOKEN = 'input-token';
const run = promisify(execFile);

interface Entry {
    id: string;
    name: string;
    mediaType: string;
    size: number;
    sha256: string;
    originJobId: string;
}
interface Verdict {
    ok: boolean;
    reason?: string;
    kind?: string;
    transient?: boolean;
    files?: number;
    fetched?: number;
}

const MANIFEST = 'manifest.json';
const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORIGIN = '11111111-1111-4111-8111-111111111111';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const BODIES = new Map<string, Buffer>();
const fileOf = (id: string, name: string, body: Buffer): Entry => {
    BODIES.set(id, body);
    return { id, name, mediaType: 'text/plain', size: body.length, sha256: sha(body), originJobId: ORIGIN };
};

describe('the attachment fetch script', () => {
    let server: Server | null = null;
    let root = '';
    let target = '';
    let asked: string[] = [];
    /** What the fake endpoint answers per id, instead of the file: a status, or `hang`. */
    let overrides: Map<string, number | 'hang'>;
    let corrupt: Set<string>;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'attachment-fetch-'));
        target = join(root, 'inputs');
        asked = [];
        overrides = new Map();
        corrupt = new Set();
    });
    afterEach(() => {
        server?.closeAllConnections();
        server?.close();
        server = null;
        rmSync(root, { recursive: true, force: true });
    });

    async function serve(): Promise<string> {
        server = createServer((request, reply) => {
            const [, route, delivery, id] = (request.url ?? '').split('/');
            if (request.headers.authorization !== `Bearer ${TOKEN}`) return void reply.writeHead(401).end('{}');
            if (route !== 'input' || delivery !== 'task' || !id) return void reply.writeHead(400).end('{}');
            asked.push(id);
            const override = overrides.get(id);
            if (override === 'hang') return;
            if (override) return void reply.writeHead(override).end('{}');
            const body = BODIES.get(id);
            if (!body) return void reply.writeHead(404).end('{}');
            const sent = Buffer.from(body);
            if (corrupt.has(id)) sent[0] = (sent[0] ?? 0) ^ 0xff;
            reply.writeHead(200, { 'x-content-sha256': sha(body) }).end(sent);
        });
        await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    async function fetchAll(url: string, manifest: Entry[], env: Record<string, string> = {}): Promise<Verdict> {
        const { stdout } = await run('node', ['--no-warnings', join(SCRIPTS, 'attachment-fetch.cjs')], {
            env: {
                ...process.env,
                TARGET_DIR: target,
                MANIFEST: JSON.stringify(manifest),
                INPUT_DELIVERY: 'task',
                STAGING_SEQ: '7',
                RESTORE_URL: url,
                RESTORE_TOKEN: TOKEN,
                ...env,
            },
            encoding: 'utf8',
        });
        return JSON.parse(stdout.trim().split('\n').pop()!) as Verdict;
    }

    const names = () => (existsSync(target) ? readdirSync(target).sort() : []);
    const manifestOnDisk = () =>
        JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8')) as { files: Record<string, unknown>[] };

    it('lands every file at <id><ext> with exact bytes and writes manifest.json last', async () => {
        const binary = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
        const files = [fileOf(ID_A, 'notes.txt', Buffer.from('hello\n')), fileOf(ID_B, 'photo.PNG', binary)];
        const url = await serve();

        const verdict = await fetchAll(url, files);

        expect(verdict).toMatchObject({ ok: true, files: 2, fetched: 2 });
        expect(names()).toEqual([`${ID_A}.txt`, `${ID_B}.PNG`, 'manifest.json']);
        expect(readFileSync(join(target, `${ID_A}.txt`))).toEqual(Buffer.from('hello\n'));
        expect(readFileSync(join(target, `${ID_B}.PNG`))).toEqual(binary);
        expect(manifestOnDisk().files).toEqual([
            { ...files[0], path: `${ID_A}.txt` },
            { ...files[1], path: `${ID_B}.PNG` },
        ]);
    });

    it('keeps the display name only in manifest.json, JSON-escaped, and never in a path', async () => {
        const files = [
            fileOf(ID_A, '../../etc/passwd', Buffer.from('one')),
            fileOf(ID_B, 'quote".txt', Buffer.from('two')),
            fileOf(ID_C, 'quote".txt', Buffer.from('three')),
        ];
        const url = await serve();

        expect(await fetchAll(url, files)).toMatchObject({ ok: true });

        expect(names()).toEqual([ID_A, `${ID_B}.txt`, `${ID_C}.txt`, 'manifest.json']);
        expect(manifestOnDisk().files.map((f) => f.name)).toEqual(['../../etc/passwd', 'quote".txt', 'quote".txt']);
        expect(existsSync(join(root, 'etc'))).toBe(false);
    });

    it('fills an empty target directory with the full set', async () => {
        mkdirSync(target, { recursive: true });
        const url = await serve();

        const verdict = await fetchAll(url, [fileOf(ID_A, 'a.txt', Buffer.from('a'))]);

        expect(verdict).toMatchObject({ ok: true, files: 1, fetched: 1 });
        expect(names()).toEqual([`${ID_A}.txt`, 'manifest.json']);
    });

    it('keeps the valid files it already holds and fetches only the missing ones', async () => {
        const files = [fileOf(ID_A, 'a.txt', Buffer.from('aaa')), fileOf(ID_B, 'b.txt', Buffer.from('bbb'))];
        const url = await serve();
        await fetchAll(url, [files[0]!]);
        asked = [];

        const verdict = await fetchAll(url, files);

        expect(verdict).toMatchObject({ ok: true, files: 2, fetched: 1 });
        expect(asked).toEqual([ID_B]);
    });

    it('replaces a present file of the wrong sha through staging and a rename', async () => {
        const files = [fileOf(ID_A, 'a.txt', Buffer.from('right'))];
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, `${ID_A}.txt`), 'wrong');
        const url = await serve();

        const verdict = await fetchAll(url, files);

        expect(verdict).toMatchObject({ ok: true, fetched: 1 });
        expect(readFileSync(join(target, `${ID_A}.txt`), 'utf8')).toBe('right');
        expect(names().filter((n) => n.startsWith('.staging'))).toEqual([]);
    });

    it('removes a stale file the manifest no longer lists, only once the new manifest is published', async () => {
        const url = await serve();
        await fetchAll(url, [fileOf(ID_A, 'a.txt', Buffer.from('a')), fileOf(ID_B, 'b.txt', Buffer.from('b'))]);
        writeFileSync(join(target, 'stray.bin'), 'x');

        await fetchAll(url, [fileOf(ID_A, 'a.txt', Buffer.from('a'))]);

        expect(names()).toEqual([`${ID_A}.txt`, 'manifest.json']);
        expect(manifestOnDisk().files).toHaveLength(1);
    });

    it('keeps the stale files when the fetch fails, and the old manifest with them', async () => {
        const url = await serve();
        await fetchAll(url, [fileOf(ID_A, 'a.txt', Buffer.from('a'))]);
        const before = readFileSync(join(target, 'manifest.json'), 'utf8');
        overrides.set(ID_B, 503);

        const verdict = await fetchAll(url, [fileOf(ID_B, 'b.txt', Buffer.from('b'))]);

        expect(verdict).toMatchObject({ ok: false, transient: true });
        expect(readFileSync(join(target, 'manifest.json'), 'utf8')).toBe(before);
        expect(existsSync(join(target, `${ID_A}.txt`))).toBe(true);
    });

    it.each([410, 422])(
        'a board %i is {ok:false, kind:attachment_unavailable}, with no manifest and no final file',
        async (status) => {
            const files = [fileOf(ID_A, 'a.txt', Buffer.from('a')), fileOf(ID_B, 'b.txt', Buffer.from('b'))];
            overrides.set(ID_B, status);
            const url = await serve();

            const verdict = await fetchAll(url, files);

            expect(verdict).toMatchObject({ ok: false, kind: 'attachment_unavailable' });
            expect(verdict.transient).toBeUndefined();
            expect(names().filter((n) => !n.startsWith('.staging-'))).toEqual([]);
        }
    );

    it.each([502, 503, 404, 401])(
        'a %i is {ok:false, transient:true}, with no manifest and no final file',
        async (status) => {
            overrides.set(ID_A, status);
            const url = await serve();

            const verdict = await fetchAll(url, [fileOf(ID_A, 'a.txt', Buffer.from('a'))]);

            expect(verdict).toMatchObject({ ok: false, transient: true });
            expect(verdict.kind).toBeUndefined();
            expect(names().filter((n) => !n.startsWith('.staging-'))).toEqual([]);
        }
    );

    it('a filesystem fault is transient, never a verdict on the files', async () => {
        mkdirSync(target, { recursive: true });
        chmodSync(target, 0o500);
        const url = await serve();

        const verdict = await fetchAll(url, [fileOf(ID_A, 'a.txt', Buffer.from('a'))]);
        chmodSync(target, 0o700);

        expect(verdict).toMatchObject({ ok: false, transient: true });
        expect(verdict.kind).toBeUndefined();
        expect(existsSync(join(target, MANIFEST))).toBe(false);
    });

    it('an unreadable claim list is transient too: nothing local is a definitive answer', async () => {
        const url = await serve();

        const verdict = await fetchAll(url, [], { MANIFEST: 'not json' });

        expect(verdict).toMatchObject({ ok: false, transient: true });
    });

    it('a timeout is transient', async () => {
        overrides.set(ID_A, 'hang');
        const url = await serve();

        const verdict = await fetchAll(url, [fileOf(ID_A, 'a.txt', Buffer.from('a'))], { FETCH_TIMEOUT_MS: '300' });

        expect(verdict).toMatchObject({ ok: false, transient: true });
        expect(names().filter((n) => !n.startsWith('.staging-'))).toEqual([]);
    });

    it('a sha mismatch of the received bytes is unavailable and leaves no manifest', async () => {
        corrupt.add(ID_A);
        const url = await serve();

        const verdict = await fetchAll(url, [fileOf(ID_A, 'a.txt', Buffer.from('abc'))]);

        expect(verdict).toMatchObject({ ok: false, kind: 'attachment_unavailable' });
        expect(names().filter((n) => !n.startsWith('.staging-'))).toEqual([]);
    });

    it('serves a reviewer delivery from env alone: the target directory and the delivery name', async () => {
        const other = join(root, 'review-inputs');
        const url = await serve();

        const verdict = await fetchAll(url, [fileOf(ID_A, 'a.txt', Buffer.from('a'))], { TARGET_DIR: other });

        expect(verdict).toMatchObject({ ok: true });
        expect(readdirSync(other).sort()).toEqual([`${ID_A}.txt`, 'manifest.json']);
        expect(existsSync(target)).toBe(false);
    });
});
