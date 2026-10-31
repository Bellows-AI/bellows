import { request as httpRequest } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
    ATTACHMENT_NAME_HEADER,
    ERROR_CODES,
    MAX_FILE_BYTES,
    MAX_FILES_PER_REQUEST,
    MAX_IMAGE_PIXELS,
    MAX_IMAGE_SIDE,
    MAX_REQUEST_BYTES,
    OCTET_STREAM_CONTENT_TYPE,
} from '@factory-ai/core';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { createAttachmentStore } from '../src/attachments/attachment-store.js';
import type { JobActionStore } from '../src/db/jobs/job-store-actions.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRegistry } from '../src/orgs.js';
import { memoryAttachmentRows, pdfBytes, pngBytes } from './helpers-attachments.js';
import {
    githubAuth,
    jobStoreSlice,
    memoryAuthStore,
    signedIn,
    staticRegistry,
    stubTelemetryClient,
    testConfig,
} from './helpers.js';
import {
    HTTP_BAD_REQUEST,
    HTTP_CONFLICT,
    HTTP_CREATED,
    HTTP_FORBIDDEN,
    HTTP_NOT_FOUND,
    HTTP_NO_CONTENT,
    HTTP_OK,
    HTTP_PAYLOAD_TOO_LARGE,
    HTTP_UNAUTHORIZED,
    HTTP_UNAVAILABLE,
    HTTP_UNSUPPORTED_MEDIA_TYPE,
    trackApps,
} from './helpers-http.js';

/**
 * Offline: the attachment routes' HTTP contract over the real store logic, an in-memory row double and a filesystem
 * object store. The rows' SQL is pinned by server/test-db/attachment-store.test.ts.
 */

const track = trackApps();
const ORG = 'test-org';
const FOREIGN_ORG = 'foreign-org';

const encoded = (name: string) => encodeURIComponent(name);

async function boot({
    objects,
    maxInFlight,
}: {
    objects?: (base: ObjectStore) => Partial<ObjectStore>;
    maxInFlight?: number;
} = {}) {
    const auth = memoryAuthStore();
    const owner = auth.seedMember(ORG, 'octocat');
    const stranger = auth.seedMember(ORG, 'hubot');
    auth.seedOrg(FOREIGN_ORG);
    const outsider = auth.seedMember(FOREIGN_ORG, 'mallory');
    const base = createFilesystemStore(await mkdtemp(join(tmpdir(), 'attachment-routes-')));
    const store: ObjectStore = { ...base, ...objects?.(base) };
    const rowsByOrg = new Map<string, ReturnType<typeof memoryAttachmentRows>>();
    const storeOf = (org: string) => {
        let rows = rowsByOrg.get(org);
        if (!rows) {
            rows = memoryAttachmentRows();
            rowsByOrg.set(org, rows);
        }
        return createAttachmentStore({ rows, objects: store, orgId: org, prefix: '' });
    };
    const created: string[] = [];
    const config = testConfig({ auth: githubAuth() });
    const registry = staticRegistry({
        config,
        repos: staticRepoSource([{ owner: 'acme', name: 'web' }]),
        telemetry: stubTelemetryClient(),
        jobs: jobStoreSlice<JobActionStore>({
            async create(command: string) {
                created.push(command);
                return { id: crypto.randomUUID() };
            },
        }),
    });
    const orgs: OrgRegistry = {
        ...registry,
        for: async (orgId) => {
            const runtime = await registry.for(orgId);
            return runtime && { ...runtime, orgId, attachments: storeOf(orgId) };
        },
    };
    const instance = await buildApp({
        config,
        orgs,
        auth,
        ...(maxInFlight ? { attachmentMaxInFlight: maxInFlight } : {}),
    });
    track(instance);
    const cookie = {
        owner: await signedIn(auth, owner),
        stranger: await signedIn(auth, stranger),
        outsider: await signedIn(auth, outsider),
    };
    return { instance, auth, cookie, created, rows: () => rowsByOrg.get(ORG)?.all ?? [], orgs };
}

const post = (
    instance: FastifyInstance,
    cookie: string,
    payload: Uint8Array | Readable,
    headers: Record<string, string> = { [ATTACHMENT_NAME_HEADER]: encoded('shot.png') }
) =>
    instance.inject({
        method: 'POST',
        url: '/api/attachments',
        headers: { cookie, 'content-type': OCTET_STREAM_CONTENT_TYPE, ...headers },
        payload: payload instanceof Readable ? payload : Buffer.from(payload),
    });

describe('POST /api/attachments', () => {
    it('stores the file and round-trips its bytes through the content route', async () => {
        const { instance, cookie } = await boot();
        const png = pngBytes();

        const response = await post(instance, cookie.owner, png);

        expect(response.statusCode).toBe(HTTP_CREATED);
        const meta = response.json();
        expect(meta).toMatchObject({ name: 'shot.png', mediaType: 'image/png', size: png.length, state: 'ready' });
        expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
        const content = await instance.inject({
            method: 'GET',
            url: `/api/attachments/${meta.id}/content`,
            headers: { cookie: cookie.owner },
        });
        expect(content.statusCode).toBe(HTTP_OK);
        expect(Buffer.compare(content.rawPayload, Buffer.from(png))).toBe(0);
        const metaRead = await instance.inject({
            method: 'GET',
            url: `/api/attachments/${meta.id}`,
            headers: { cookie: cookie.owner },
        });
        expect(metaRead.json()).toEqual(meta);
    });

    it('decides the type from the bytes, whatever the name says', async () => {
        const { instance, cookie } = await boot();
        const response = await post(instance, cookie.owner, pngBytes(), { [ATTACHMENT_NAME_HEADER]: encoded('a.pdf') });
        expect(response.statusCode).toBe(HTTP_CREATED);
        expect(response.json().mediaType).toBe('image/png');
    });

    it('refuses an unsupported type with 415 and a declared type that disagrees with the bytes', async () => {
        const { instance, cookie, rows } = await boot();
        const html = await post(instance, cookie.owner, Buffer.from('<html></html>'), {
            [ATTACHMENT_NAME_HEADER]: encoded('a.html'),
        });
        expect(html.statusCode).toBe(HTTP_UNSUPPORTED_MEDIA_TYPE);
        expect(html.json().code).toBe(ERROR_CODES.ATTACHMENT_UNSUPPORTED);
        const mismatch = await post(instance, cookie.owner, pngBytes(), {
            [ATTACHMENT_NAME_HEADER]: encoded('a.png'),
            'x-attachment-media-type': 'application/pdf',
        });
        expect(mismatch.statusCode).toBe(HTTP_UNSUPPORTED_MEDIA_TYPE);
        expect(rows()).toHaveLength(0);
    });

    it('refuses an image declaring more pixels than the limits allow', async () => {
        const { instance, cookie } = await boot();
        const side = Math.min(MAX_IMAGE_SIDE, Math.floor(Math.sqrt(MAX_IMAGE_PIXELS)) + 1);
        const response = await post(instance, cookie.owner, pngBytes(side, side));
        expect(response.statusCode).toBe(HTTP_PAYLOAD_TOO_LARGE);
        expect(response.json().code).toBe(ERROR_CODES.ATTACHMENT_TOO_LARGE);
    });

    it('refuses a missing, malformed or path-like name and an empty body', async () => {
        const { instance, cookie } = await boot();
        const none = await post(instance, cookie.owner, pngBytes(), {});
        expect(none.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(none.json().code).toBe(ERROR_CODES.BAD_ATTACHMENT);
        const malformed = await post(instance, cookie.owner, pngBytes(), { [ATTACHMENT_NAME_HEADER]: '%E0%A4%A' });
        expect(malformed.statusCode).toBe(HTTP_BAD_REQUEST);
        const control = await post(instance, cookie.owner, pngBytes(), { [ATTACHMENT_NAME_HEADER]: '%00x.png' });
        expect(control.statusCode).toBe(HTTP_BAD_REQUEST);
        const empty = await post(instance, cookie.owner, Buffer.alloc(0));
        expect(empty.statusCode).toBe(HTTP_BAD_REQUEST);
        const traversal = await post(instance, cookie.owner, pngBytes(), {
            [ATTACHMENT_NAME_HEADER]: encoded('../x.png'),
        });
        expect(traversal.statusCode).toBe(HTTP_CREATED);
        expect(traversal.json().name).not.toContain('/');
    });

    it('needs a session, and refuses an organization token', async () => {
        const { instance, auth } = await boot();
        const anonymous = await instance.inject({
            method: 'POST',
            url: '/api/attachments',
            headers: { 'content-type': OCTET_STREAM_CONTENT_TYPE, [ATTACHMENT_NAME_HEADER]: 'a.png' },
            payload: Buffer.from(pngBytes()),
        });
        expect(anonymous.statusCode).toBe(HTTP_UNAUTHORIZED);
        const token = auth.seedAccessToken(ORG, 'org');
        const refused = await instance.inject({
            method: 'POST',
            url: '/api/attachments',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': OCTET_STREAM_CONTENT_TYPE,
                [ATTACHMENT_NAME_HEADER]: 'a.png',
            },
            payload: Buffer.from(pngBytes()),
        });
        expect(refused.statusCode).toBe(HTTP_FORBIDDEN);
    });

    it('refuses a chunked body over the file limit with 413 and leaves no ready row', async () => {
        const { instance, cookie, rows } = await boot();
        const chunk = Buffer.alloc(1024 * 1024, 0x61);
        const total = MAX_FILE_BYTES + 1;
        let sent = 0;
        const body = new Readable({
            read() {
                const size = Math.min(chunk.length, total - sent);
                if (size === 0) return this.push(null);
                sent += size;
                this.push(chunk.subarray(0, size));
            },
        });

        const response = await post(instance, cookie.owner, body);

        expect(response.statusCode).toBe(HTTP_PAYLOAD_TOO_LARGE);
        expect(rows().filter((r) => r.state === 'ready')).toHaveLength(0);
    });

    it('leaves no ready row when the client goes away mid-upload', async () => {
        const { instance, cookie, rows } = await boot();
        await instance.listen({ port: 0, host: '127.0.0.1' });
        const { port } = instance.server.address() as { port: number };
        await new Promise<void>((resolve) => {
            const req = httpRequest(
                {
                    port,
                    host: '127.0.0.1',
                    method: 'POST',
                    path: '/api/attachments',
                    headers: {
                        cookie: cookie.owner,
                        'content-type': OCTET_STREAM_CONTENT_TYPE,
                        'content-length': String(pngBytes().length + 1000),
                        [ATTACHMENT_NAME_HEADER]: 'a.png',
                    },
                },
                () => resolve()
            );
            req.on('error', () => resolve());
            req.write(Buffer.from(pngBytes()));
            setTimeout(() => req.destroy(), 50);
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(rows().filter((r) => r.state === 'ready')).toHaveLength(0);
    });

    it('answers 503 ATTACHMENTS_UNAVAILABLE when the object store fails, and keeps the board creating tasks', async () => {
        const { instance, cookie, rows, created } = await boot({
            objects: () => ({
                async put() {
                    throw new Error('store down');
                },
            }),
        });
        const response = await post(instance, cookie.owner, pngBytes());
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(response.json().code).toBe(ERROR_CODES.ATTACHMENTS_UNAVAILABLE);
        expect(rows().filter((r) => r.state === 'ready')).toHaveLength(0);

        const job = await instance.inject({
            method: 'POST',
            url: '/api/jobs',
            headers: { cookie: cookie.owner },
            payload: { repo: 'acme/web', command: 'a text-only task' },
        });
        expect(job.statusCode).toBe(HTTP_CREATED);
        expect(created).toEqual(['a text-only task']);
    });

    it('answers 503 ATTACHMENTS_UNAVAILABLE when the org has no attachment store', async () => {
        const { instance, cookie, orgs } = await boot();
        const bare: OrgRegistry = {
            ...orgs,
            for: async (id) => ({ ...(await orgs.for(id))!, attachments: undefined }),
        };
        const config = testConfig({ auth: githubAuth() });
        const auth = memoryAuthStore();
        const member = auth.seedMember(ORG, 'octocat');
        const app = track(await buildApp({ config, orgs: bare, auth }));
        void instance;
        void cookie;
        const response = await post(app, await signedIn(auth, member), pngBytes());
        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(response.json().code).toBe(ERROR_CODES.ATTACHMENTS_UNAVAILABLE);
    });

    it('sheds uploads over the in-flight cap with 503 and Retry-After, then accepts again', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { instance, cookie } = await boot({
            maxInFlight: 1,
            objects: (base) => ({
                async put(key, body) {
                    await gate;
                    return base.put(key, body);
                },
            }),
        });
        const first = post(instance, cookie.owner, pngBytes());
        await new Promise((resolve) => setTimeout(resolve, 50));
        const shed = await post(instance, cookie.owner, pngBytes());
        expect(shed.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(shed.headers['retry-after']).toBeDefined();
        release();
        expect((await first).statusCode).toBe(HTTP_CREATED);
        expect((await post(instance, cookie.owner, pngBytes())).statusCode).toBe(HTTP_CREATED);
    });

    it('replays an Idempotency-Key as the same attachment, and refuses the key for another body', async () => {
        const { instance, cookie, rows } = await boot();
        const headers = { [ATTACHMENT_NAME_HEADER]: encoded('a.png'), 'idempotency-key': 'upload-key-0001' };
        const first = await post(instance, cookie.owner, pngBytes(), headers);
        const again = await post(instance, cookie.owner, pngBytes(), headers);
        expect(first.statusCode).toBe(HTTP_CREATED);
        expect(again.json().id).toBe(first.json().id);
        expect(again.headers['idempotency-replayed']).toBe('true');
        expect(rows()).toHaveLength(1);
        const other = await post(instance, cookie.owner, pngBytes(8, 8), headers);
        expect(other.statusCode).toBe(HTTP_CONFLICT);
        expect(other.json().code).toBe(ERROR_CODES.IDEMPOTENCY_KEY_REUSED);
        const bad = await post(instance, cookie.owner, pngBytes(), { ...headers, 'idempotency-key': 'short' });
        expect(bad.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(bad.json().code).toBe(ERROR_CODES.BAD_IDEMPOTENCY_KEY);
    });
});

describe('reading and deleting a draft', () => {
    const upload = async () => {
        const booted = await boot();
        const response = await post(booted.instance, booted.cookie.owner, pngBytes());
        return { ...booted, id: response.json().id as string };
    };
    const call = (instance: FastifyInstance, cookie: string, method: 'GET' | 'DELETE', path: string) =>
        instance.inject({ method, url: path, headers: { cookie } });

    it("hides another member's draft: meta, content and delete answer 404", async () => {
        const { instance, cookie, id } = await upload();
        for (const [method, path] of [
            ['GET', `/api/attachments/${id}`],
            ['GET', `/api/attachments/${id}/content`],
            ['DELETE', `/api/attachments/${id}`],
        ] as const) {
            const response = await call(instance, cookie.stranger, method, path);
            expect(response.statusCode).toBe(HTTP_NOT_FOUND);
            expect(response.json().code).toBe(ERROR_CODES.ATTACHMENT_NOT_FOUND);
        }
        expect((await call(instance, cookie.owner, 'GET', `/api/attachments/${id}`)).statusCode).toBe(HTTP_OK);
    });

    it('hides the draft from another org', async () => {
        const { instance, cookie, id } = await upload();
        for (const [method, path] of [
            ['GET', `/api/attachments/${id}`],
            ['GET', `/api/attachments/${id}/content`],
            ['DELETE', `/api/attachments/${id}`],
        ] as const) {
            expect((await call(instance, cookie.outsider, method, path)).statusCode).toBe(HTTP_NOT_FOUND);
        }
    });

    it('answers 404 to an id that cannot be a row', async () => {
        const { instance, cookie } = await upload();
        expect((await call(instance, cookie.owner, 'GET', '/api/attachments/not-a-uuid')).statusCode).toBe(
            HTTP_NOT_FOUND
        );
    });

    it('serves the content as a sandboxed attachment under the validated type', async () => {
        const { instance, cookie, id } = await upload();
        const response = await call(instance, cookie.owner, 'GET', `/api/attachments/${id}/content`);
        expect(response.headers['content-type']).toBe('image/png');
        expect(response.headers['content-disposition']).toBe("attachment; filename*=UTF-8''shot.png");
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    });

    it('encodes a non-ASCII name in the disposition', async () => {
        const { instance, cookie } = await boot();
        const stored = await post(instance, cookie.owner, pngBytes(), {
            [ATTACHMENT_NAME_HEADER]: encoded('Zażółć "q".png'),
        });
        const response = await call(instance, cookie.owner, 'GET', `/api/attachments/${stored.json().id}/content`);
        expect(response.headers['content-disposition']).toBe(
            `attachment; filename*=UTF-8''${encodeURIComponent('Zażółć "q".png')}`
        );
    });

    it('serves inline only for the three image types', async () => {
        const { instance, cookie, id } = await upload();
        const image = await call(instance, cookie.owner, 'GET', `/api/attachments/${id}/content?disposition=inline`);
        expect(image.headers['content-disposition']).toMatch(/^inline;/);
        const pdf = await post(instance, cookie.owner, pdfBytes(), { [ATTACHMENT_NAME_HEADER]: encoded('a.pdf') });
        const document = await call(
            instance,
            cookie.owner,
            'GET',
            `/api/attachments/${pdf.json().id}/content?disposition=inline`
        );
        expect(document.headers['content-disposition']).toMatch(/^attachment;/);
    });

    it('deletes a draft, idempotently, and then reads 404', async () => {
        const { instance, cookie, id } = await upload();
        expect((await call(instance, cookie.owner, 'DELETE', `/api/attachments/${id}`)).statusCode).toBe(
            HTTP_NO_CONTENT
        );
        expect((await call(instance, cookie.owner, 'DELETE', `/api/attachments/${id}`)).statusCode).toBe(
            HTTP_NO_CONTENT
        );
        expect((await call(instance, cookie.owner, 'GET', `/api/attachments/${id}`)).statusCode).toBe(HTTP_NOT_FOUND);
    });
});

describe('reading a bound file', () => {
    const bound = async () => {
        const booted = await boot();
        const response = await post(booted.instance, booted.cookie.owner, pngBytes());
        const id = response.json().id as string;
        booted.rows().find((row) => row.id === id)!.state = 'bound';
        return { ...booted, id };
    };
    const read = (instance: FastifyInstance, cookie: string, path: string) =>
        instance.inject({ method: 'GET', url: path, headers: { cookie } });

    it('serves meta and content to any member of the org', async () => {
        const { instance, cookie, id } = await bound();
        for (const path of [`/api/attachments/${id}`, `/api/attachments/${id}/content`]) {
            expect((await read(instance, cookie.stranger, path)).statusCode).toBe(HTTP_OK);
        }
    });

    it('hides it from another org', async () => {
        const { instance, cookie, id } = await bound();
        for (const path of [`/api/attachments/${id}`, `/api/attachments/${id}/content`]) {
            expect((await read(instance, cookie.outsider, path)).statusCode).toBe(HTTP_NOT_FOUND);
        }
    });

    it('answers 404 once the thread was removed and the file is deleting', async () => {
        const { instance, cookie, id, rows } = await bound();
        rows().find((row) => row.id === id)!.state = 'deleting';
        for (const path of [`/api/attachments/${id}`, `/api/attachments/${id}/content`]) {
            expect((await read(instance, cookie.stranger, path)).statusCode).toBe(HTTP_NOT_FOUND);
        }
    });
});

describe('GET /api/attachments/limits', () => {
    it('serves the core constants and the formats table', async () => {
        const { instance, cookie } = await boot();
        const response = await instance.inject({
            method: 'GET',
            url: '/api/attachments/limits',
            headers: { cookie: cookie.owner },
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toMatchObject({
            maxFilesPerRequest: MAX_FILES_PER_REQUEST,
            maxFileBytes: MAX_FILE_BYTES,
            maxRequestBytes: MAX_REQUEST_BYTES,
            maxImageSide: MAX_IMAGE_SIDE,
            maxImagePixels: MAX_IMAGE_PIXELS,
        });
        expect(response.json().formats).toHaveLength(8);
    });

    it('needs a session', async () => {
        const { instance } = await boot();
        expect((await instance.inject({ method: 'GET', url: '/api/attachments/limits' })).statusCode).toBe(
            HTTP_UNAUTHORIZED
        );
    });
});
