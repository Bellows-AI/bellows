import { request as httpRequest } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ATTACHMENT_NAME_HEADER, ERROR_CODES, MAX_FILE_BYTES, OCTET_STREAM_CONTENT_TYPE } from '@factory-ai/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import { createAttachmentStore } from '../src/attachments/attachment-store.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { SESSION_COOKIE, hashToken, sign } from '../src/auth/session.js';
import { LOCAL_ORG_ID } from '../src/identifiers.js';
import type { OrgRegistry } from '../src/orgs.js';
import { TEST_SESSION_SECRET } from './helpers-config.js';
import { memoryAttachmentRows, pdfBytes, pngBytes, textBytes } from './helpers-attachments.js';
import {
    githubAuth,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_CREATED, HTTP_PAYLOAD_TOO_LARGE, trackApps } from './helpers-http.js';
import { memoryUploadCapabilities } from './helpers-upload-capability.js';

/**
 * The attachment handoff (BEL-248): `create_attachment_upload` through the real auth plugin and bridge mints a
 * single-use capability, and `PUT /api/attachments/uploads/:capability` (an open route, the capability is the
 * credential) streams into the board's own attachment pipeline. `server/test-db/mcp.attachment-handoff.test.ts` runs
 * the same over real stores.
 */

const track = trackApps();
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const HTTP_GONE = 410;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNSUPPORTED = 415;
const HTTP_UNAVAILABLE = 503;
const TOKENS = {
    alice: 'mat_upload-alice-token-0123456789',
    writeOnly: 'mat_upload-writer-token-0123456789',
    readOnly: 'mat_upload-reader-token-0123456789',
    unbound: 'mat_upload-unbound-token-0123456789',
    bob: 'mat_upload-bob-token-0123456789',
} as const;
type Who = keyof typeof TOKENS;
const ORG = 'org-a';
const OTHER_ORG = 'org-b';
const UPLOAD_PATH = '/api/attachments/uploads';
const NOT_A_CAPABILITY = 'fcu_' + 'A'.repeat(43);

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, LOCALHOST, () => {
            const address = probe.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });

async function boot({ now = Date.now, mode = 'github' }: { now?: () => number; mode?: 'github' | 'none' } = {}) {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const auth = memoryAuthStore();
    auth.seedOrg(OTHER_ORG);
    if (mode === 'none') auth.seedLocalUser(LOCAL_ORG_ID);
    const people = {
        alice: auth.seedMember(ORG, 'alice', 'member'),
        writeOnly: auth.seedMember(ORG, 'writer', 'member'),
        readOnly: auth.seedMember(ORG, 'reader', 'member'),
        bob: auth.seedMember(OTHER_ORG, 'bob', 'member'),
        unbound: auth.seedMember(ORG, 'unbound', 'member'),
    };
    const scopes: Record<Who, McpCaller['scopes']> = {
        alice: ['factory:read', 'factory:write'],
        writeOnly: ['factory:write'],
        readOnly: ['factory:read'],
        bob: ['factory:read', 'factory:write'],
        unbound: ['factory:read', 'factory:write'],
    };
    const tokens = new Map<string, McpCaller>(
        (Object.keys(TOKENS) as Who[]).map((who) => [
            hashToken(TOKENS[who]).toString('hex'),
            {
                ...people[who],
                scopes: scopes[who],
                clientId: 'c',
                resource,
                familyId: who === 'unbound' ? '' : `family-${who}`,
            },
        ])
    );
    const oauth: Pick<OAuthStore, 'findAccessToken'> = {
        findAccessToken: async (hash) => tokens.get(hash.toString('hex')) ?? null,
    };
    const config = testConfig({
        ...(mode === 'github' ? { auth: githubAuth({ publicUrl }) } : {}),
        port,
        mcp: { enabled: true, resource, trustedOrigins: [] },
    });
    // A session or a personal token's capability lives only while that credential does, as the store's SQL joins ask.
    const caps = memoryUploadCapabilities(now, async ({ sessionHash, accessTokenId }) => {
        if (sessionHash) return (await auth.findSession(sessionHash)) !== null;
        if (accessTokenId) return auth.accessTokens().some((token) => token.id === accessTokenId && !token.revoked);
        return true;
    });
    const objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'attachment-handoff-')));
    const rowsByOrg = new Map<string, ReturnType<typeof memoryAttachmentRows>>();
    const storeOf = (org: string) => {
        let rows = rowsByOrg.get(org);
        if (!rows) {
            rows = memoryAttachmentRows();
            rowsByOrg.set(org, rows);
        }
        return createAttachmentStore({ rows, objects, orgId: org, prefix: '' });
    };
    const base = staticRegistry({ config, telemetry: stubTelemetryClient() });
    const orgs: OrgRegistry = {
        ...base,
        for: async (orgId) => {
            const runtime = await base.for(orgId);
            return runtime && { ...runtime, orgId, attachments: storeOf(orgId) };
        },
    };
    const lines: string[] = [];
    const app = track(
        await buildApp({
            config,
            orgs,
            store: telemetryStoreStub(),
            auth,
            oauth: oauth as OAuthStore,
            uploadCapabilities: caps.store,
            logger: { level: 'trace', stream: { write: (line: string) => void lines.push(line) } },
        })
    );
    await app.listen({ port, host: LOCALHOST });
    return {
        app,
        auth,
        port,
        url: new URL(resource),
        origin: publicUrl,
        caps,
        lines,
        people,
        attachments: (org: string = ORG) => rowsByOrg.get(org)?.all ?? [],
        storeOf,
    };
}
type World = Awaited<ReturnType<typeof boot>>;

const call = async (url: URL, who: Who, name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: 'handoff', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKENS[who]}` } } })
    );
    try {
        const result = await client.callTool({ name, arguments: args });
        // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
        return { ...result, data: result.structuredContent as Record<string, any> };
    } finally {
        await client.close();
    }
};

const mint = async (world: World, who: Who = 'alice', args: Record<string, unknown> = {}) => {
    const made = await call(world.url, who, 'create_attachment_upload', args);
    expect(made.isError, JSON.stringify(made.data)).toBeFalsy();
    return made.data;
};

/** The path of a minted upload URL: the PUT goes through `app.inject`, with no credential beside it. */
const pathOf = (uploadUrl: string): string => new URL(uploadUrl).pathname;

const put = (
    world: World,
    path: string,
    payload: Uint8Array,
    headers: Record<string, string> = { [ATTACHMENT_NAME_HEADER]: encodeURIComponent('shot.png') }
) =>
    world.app.inject({
        method: 'PUT',
        url: path,
        headers: { 'content-type': OCTET_STREAM_CONTENT_TYPE, ...headers },
        payload: Buffer.from(payload),
    });

describe('create_attachment_upload', () => {
    it('mints a capability bound to the caller, the org and the limits, and stores only its hash', async () => {
        const world = await boot();

        const data = await mint(world, 'alice', { maxBytes: 4096, mediaTypes: ['image/png'] });

        expect(data).toMatchObject({ state: 'open', maxBytes: 4096, mediaTypes: ['image/png'], attachmentId: null });
        expect(data.uploadUrl).toMatch(new RegExp(`^${world.origin}/api/attachments/uploads/fcu_[A-Za-z0-9_-]{43}$`));
        expect(data.pageUrl).toMatch(new RegExp(`^${world.origin}/attachments/upload#fcu_[A-Za-z0-9_-]{43}$`));
        const [row] = [...world.caps.rows.values()];
        expect(row).toMatchObject({
            orgId: ORG,
            userId: world.people.alice.user.id,
            familyId: 'family-alice',
            maxBytes: 4096,
            mediaTypes: ['image/png'],
        });
        const capability = new URL(data.uploadUrl).pathname.split('/').pop() as string;
        expect(JSON.stringify(row)).not.toContain(capability);
        expect(row?.hash).toBe(world.caps.hashOf(capability));
    });

    it('defaults to the board limits and every accepted format, and caps a larger ask', async () => {
        const world = await boot();

        const data = await mint(world);

        expect(data.maxBytes).toBe(MAX_FILE_BYTES);
        expect(data.mediaTypes).toContain('image/png');
        expect(data.mediaTypes).toContain('application/pdf');
        const asked = await call(world.url, 'alice', 'create_attachment_upload', { maxBytes: MAX_FILE_BYTES + 1 });
        expect(asked.isError).toBe(true);
        expect(world.caps.rows.size).toBe(1);
    });

    it('refuses a type the board does not accept', async () => {
        const world = await boot();

        const refused = await call(world.url, 'alice', 'create_attachment_upload', {
            mediaTypes: ['application/x-sh'],
        });

        expect(refused.isError).toBe(true);
        expect(world.caps.rows.size).toBe(0);
    });

    it('takes no path and no URL: an unknown argument is refused, nothing is read or fetched', async () => {
        const world = await boot();
        const fetched = vi.spyOn(globalThis, 'fetch');
        try {
            const calls = fetched.mock.calls.length;
            for (const extra of [
                { path: '/etc/passwd' },
                { url: 'http://169.254.169.254/latest' },
                { file: '~/a.png' },
            ]) {
                const refused = await call(world.url, 'alice', 'create_attachment_upload', extra);
                expect(refused.isError, JSON.stringify(extra)).toBe(true);
            }
            expect(world.caps.rows.size).toBe(0);
            // The only fetches are the test's own MCP transport calls to this board.
            const foreign = fetched.mock.calls
                .slice(calls)
                .filter(([input]) => !String(input).startsWith(world.origin));
            expect(foreign).toEqual([]);
        } finally {
            fetched.mockRestore();
        }
    });

    it('needs factory:write, and a write-only token can mint', async () => {
        const world = await boot();

        const denied = await call(world.url, 'readOnly', 'create_attachment_upload');
        expect(denied.isError).toBe(true);
        expect(denied.data.code).toBe('insufficient_scope');

        const minted = await call(world.url, 'writeOnly', 'create_attachment_upload');
        expect(minted.isError, JSON.stringify(minted.data)).toBeFalsy();
        expect(world.caps.rows.size).toBe(1);
    });
});

describe('PUT /api/attachments/uploads/:capability', () => {
    it('completes an upload with no credential, owned by the account that minted it', async () => {
        const world = await boot();
        const { uploadUrl, id } = await mint(world);
        const png = pngBytes();

        const response = await put(world, pathOf(uploadUrl), png);

        expect(response.statusCode).toBe(HTTP_CREATED);
        const meta = response.json();
        expect(meta).toMatchObject({ name: 'shot.png', mediaType: 'image/png', size: png.length, state: 'ready' });
        const stored = await world.storeOf(ORG).meta(meta.id, world.people.alice.user.id);
        expect(stored?.sha256).toBe(meta.sha256);
        expect(await world.storeOf(ORG).meta(meta.id, world.people.writeOnly.user.id)).toBeNull();
        const status = await call(world.url, 'alice', 'create_attachment_upload', { uploadId: id });
        expect(status.data).toMatchObject({ id, state: 'completed', attachmentId: meta.id });
    });

    it('is classed open and never reachable through the bridge', async () => {
        const world = await boot();
        const { uploadUrl } = await mint(world);
        const { bridgedRequestClass } = await import('../src/auth/bridge-binding.js');

        const bridged = await world.app.inject({
            method: 'PUT',
            url: pathOf(uploadUrl),
            Request: bridgedRequestClass({ ...world.people.alice, scopes: ['factory:write'] }),
            headers: { 'content-type': OCTET_STREAM_CONTENT_TYPE, [ATTACHMENT_NAME_HEADER]: 'a.png' },
            payload: Buffer.from(pngBytes()),
        } as never);

        expect(bridged.statusCode).toBe(403);
        expect(world.attachments()).toHaveLength(0);
    });

    it('spends the capability once: the same bytes replay the same file, other bytes are refused', async () => {
        const world = await boot();
        const { uploadUrl } = await mint(world);
        const path = pathOf(uploadUrl);

        const first = await put(world, path, pngBytes());
        const again = await put(world, path, pngBytes());
        const other = await put(world, path, pngBytes(8, 8));

        expect(first.statusCode).toBe(HTTP_CREATED);
        expect(again.statusCode).toBe(HTTP_CREATED);
        expect(again.headers['idempotency-replayed']).toBe('true');
        expect(again.json().id).toBe(first.json().id);
        expect(other.statusCode).toBe(HTTP_CONFLICT);
        expect(other.json().code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_SPENT);
        expect(world.attachments()).toHaveLength(1);
    });

    it('converges concurrent retries on one file: each answer is that file or a retryable 503, never a second file', async () => {
        const world = await boot();
        const { uploadUrl } = await mint(world);

        // The in-memory row double does not serialize a pending replay, so some of these meet a retryable 503; the
        // real rows' SQL is pinned by server/test-db/mcp.attachment-handoff.test.ts.
        const responses = await Promise.all(Array.from({ length: 5 }, () => put(world, pathOf(uploadUrl), pngBytes())));

        for (const response of responses) expect([HTTP_CREATED, HTTP_UNAVAILABLE]).toContain(response.statusCode);
        expect(responses.some((r) => r.statusCode === HTTP_CREATED)).toBe(true);
        const retry = await put(world, pathOf(uploadUrl), pngBytes());
        expect(retry.statusCode).toBe(HTTP_CREATED);
        for (const response of responses.filter((r) => r.statusCode === HTTP_CREATED)) {
            expect(response.json().id).toBe(retry.json().id);
        }
        expect(world.attachments()).toHaveLength(1);
    });

    it('refuses an expired capability and writes nothing', async () => {
        let clock = Date.now();
        const world = await boot({ now: () => clock });
        const { uploadUrl } = await mint(world);
        clock += 60 * 60 * 1000;

        const response = await put(world, pathOf(uploadUrl), pngBytes());

        expect(response.statusCode).toBe(HTTP_GONE);
        expect(response.json().code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_EXPIRED);
        expect(world.attachments()).toHaveLength(0);
    });

    it.each([
        ['unknown', NOT_A_CAPABILITY],
        ['path-like', '..%2F..%2Fetc%2Fpasswd'],
        ['an attachment id', '11111111-1111-4111-8111-111111111111'],
    ])('answers 404 to a %s capability', async (_name, capability) => {
        const world = await boot();

        const response = await put(world, `/api/attachments/uploads/${capability}`, pngBytes());

        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        expect(response.json().code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_INVALID);
    });

    it('refuses once the grant is revoked or the account left the org, and writes nothing', async () => {
        const world = await boot();
        const revoked = await mint(world);
        const removed = await mint(world, 'writeOnly');
        world.caps.kill('family-alice');
        world.caps.kill(world.people.writeOnly.user.id);

        for (const { uploadUrl } of [revoked, removed]) {
            const response = await put(world, pathOf(uploadUrl), pngBytes());
            expect(response.statusCode).toBe(HTTP_NOT_FOUND);
            expect(response.json().code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_INVALID);
        }
        expect(world.attachments()).toHaveLength(0);
    });

    it('refuses a type the board rejects and a type the capability does not allow, leaving it open', async () => {
        const world = await boot();
        const pdfOnly = await mint(world, 'alice', { mediaTypes: ['application/pdf'] });
        const path = pathOf(pdfOnly.uploadUrl);

        const executable = await put(world, path, textBytes('#!/bin/sh\nrm -rf /\n\u0000\u0001'), {
            [ATTACHMENT_NAME_HEADER]: 'run.sh',
        });
        const wrongKind = await put(world, path, pngBytes());
        const accepted = await put(world, path, pdfBytes(), { [ATTACHMENT_NAME_HEADER]: 'spec.pdf' });

        expect(executable.statusCode).toBe(HTTP_UNSUPPORTED);
        expect(wrongKind.statusCode).toBe(HTTP_UNSUPPORTED);
        expect(wrongKind.json().code).toBe(ERROR_CODES.ATTACHMENT_UNSUPPORTED);
        expect(accepted.statusCode).toBe(HTTP_CREATED);
        expect(world.attachments()).toHaveLength(1);
    });

    it('refuses a body over the capability limit by its declared length and by its bytes, leaving it open', async () => {
        const world = await boot();
        const { uploadUrl } = await mint(world, 'alice', { maxBytes: 64 });
        const path = pathOf(uploadUrl);
        const big = Buffer.concat([pngBytes(), Buffer.alloc(100)]);

        const declared = await put(world, path, big);
        // No content-length: the size is known only once the bytes have been read.
        const streamed = await world.app.inject({
            method: 'PUT',
            url: path,
            headers: { 'content-type': OCTET_STREAM_CONTENT_TYPE, [ATTACHMENT_NAME_HEADER]: 'big.png' },
            payload: Readable.from([big.subarray(0, 50), big.subarray(50)]),
        });
        const small = await put(world, path, pngBytes());

        expect(declared.statusCode).toBe(HTTP_PAYLOAD_TOO_LARGE);
        expect(declared.json().code).toBe(ERROR_CODES.ATTACHMENT_TOO_LARGE);
        expect(streamed.statusCode).toBe(HTTP_PAYLOAD_TOO_LARGE);
        expect(streamed.json().code).toBe(ERROR_CODES.ATTACHMENT_TOO_LARGE);
        expect(pngBytes().length).toBeLessThanOrEqual(64);
        expect(small.statusCode).toBe(HTTP_CREATED);
        expect(world.attachments()).toHaveLength(1);
    });

    it('holds no upload slot while its capability is being resolved: bogus links cannot starve members', async () => {
        const world = await boot();
        const token = world.auth.seedAccessToken(ORG, 'personal', { userId: world.people.alice.user.id });
        let release: () => void = () => undefined;
        world.caps.state.hold = new Promise<void>((resolve) => {
            release = resolve;
        });
        const bogus = Array.from({ length: 8 }, () => put(world, `${UPLOAD_PATH}/${NOT_A_CAPABILITY}`, pngBytes()));

        await new Promise((resolve) => setTimeout(resolve, 50));

        const member = await world.app.inject({
            method: 'POST',
            url: '/api/attachments',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': OCTET_STREAM_CONTENT_TYPE,
                [ATTACHMENT_NAME_HEADER]: 'mine.png',
            },
            payload: Buffer.from(pngBytes()),
        });
        release();
        const answers = await Promise.all(bogus);

        expect(member.statusCode).toBe(HTTP_CREATED);
        expect(answers.map((answer) => answer.statusCode)).toEqual(new Array(8).fill(HTTP_NOT_FOUND));
    });

    it('stops a chunked body at the capability limit while it streams, before the request ends', async () => {
        const world = await boot();
        const { uploadUrl } = await mint(world, 'alice', { maxBytes: 64 });
        const chunk = Buffer.alloc(1024, 1);
        const sent = { chunks: 0 };

        const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const req = httpRequest({
                host: LOCALHOST,
                port: world.port,
                path: pathOf(uploadUrl),
                method: 'PUT',
                headers: {
                    'content-type': OCTET_STREAM_CONTENT_TYPE,
                    'transfer-encoding': 'chunked',
                    [ATTACHMENT_NAME_HEADER]: 'big.png',
                },
            });
            let body = '';
            req.on('response', (res) => {
                res.on('data', (part) => {
                    body += part;
                });
                res.on('end', () => {
                    req.destroy();
                    resolve({ status: res.statusCode ?? 0, body });
                });
            });
            req.on('error', () => undefined);
            // The request is never ended: only an answer given mid-stream resolves this.
            const writeMore = () => {
                if (sent.chunks >= 400) {
                    req.destroy();
                    return reject(new Error('no answer while the body was still arriving'));
                }
                sent.chunks += 1;
                req.write(chunk, () => setTimeout(writeMore, 2));
            };
            writeMore();
        });

        expect(answer.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
        expect(JSON.parse(answer.body).code).toBe(ERROR_CODES.ATTACHMENT_TOO_LARGE);
        expect(world.attachments()).toHaveLength(0);
        const retry = await put(world, pathOf(uploadUrl), pngBytes());
        expect(retry.statusCode).toBe(HTTP_CREATED);
    });

    describe('a capability dies with the credential that minted it', () => {
        const SESSION_TOKEN = 'session-token-for-the-upload-capability-test';
        const mintOver = (world: World, headers: Record<string, string>) =>
            world.app.inject({ method: 'POST', url: '/api/attachments/upload-requests', headers, payload: {} });

        it('refuses after the web session that minted it logs out, and binds the session, not the account', async () => {
            const world = await boot();
            const alice = world.people.alice;
            await world.auth.createSession(hashToken(SESSION_TOKEN), alice.user.id, new Date(Date.now() + 60_000), ORG);
            const cookies = { [SESSION_COOKIE]: sign(SESSION_TOKEN, TEST_SESSION_SECRET) };
            const minted = await world.app.inject({
                method: 'POST',
                url: '/api/attachments/upload-requests',
                cookies,
                payload: {},
            });
            expect(minted.statusCode).toBe(HTTP_CREATED);
            const path = pathOf(minted.json().uploadUrl);
            const other = await mint(world); // the same account under a different credential keeps its own link

            // What POST /api/auth/logout does with the cookie (routes/auth.ts): delete the session row.
            await world.auth.deleteSession(hashToken(SESSION_TOKEN));
            const response = await put(world, path, pngBytes());

            expect(response.statusCode).toBe(HTTP_NOT_FOUND);
            expect(response.json().code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_INVALID);
            expect(world.attachments()).toHaveLength(0);
            expect((await put(world, pathOf(other.uploadUrl), pngBytes())).statusCode).toBe(HTTP_CREATED);
        });

        it('refuses after the personal token that minted it is revoked', async () => {
            const world = await boot();
            const alice = world.people.alice;
            const token = world.auth.seedAccessToken(ORG, 'personal', { userId: alice.user.id });
            const minted = await mintOver(world, { authorization: `Bearer ${token}` });
            expect(minted.statusCode).toBe(HTTP_CREATED);
            const path = pathOf(minted.json().uploadUrl);
            const row = world.auth.accessTokens().find((t) => t.userId === alice.user.id);
            expect(await world.auth.revokePersonalToken(ORG, alice.user.id, row?.id ?? '')).toBe('revoked');

            const response = await put(world, path, pngBytes());

            expect(response.statusCode).toBe(HTTP_NOT_FOUND);
            expect(response.json().code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_INVALID);
            expect(world.attachments()).toHaveLength(0);
        });
    });

    it('refuses to mint a link it cannot bind: a credential with no grant, session or token behind it', async () => {
        const world = await boot();

        const made = await call(world.url, 'unbound', 'create_attachment_upload', {});

        expect(made.isError).toBe(true);
        expect(made.data).toMatchObject({ outcome: 'refused', status: 403, code: 'FORBIDDEN' });
        expect(world.caps.rows.size).toBe(0);
    });

    it('on an AUTH_MODE=none board, mints for the local caller with nothing to bind, and the PUT works', async () => {
        const world = await boot({ mode: 'none' });
        const minted = await world.app.inject({
            method: 'POST',
            url: '/api/attachments/upload-requests',
            payload: {},
        });
        expect(minted.statusCode).toBe(HTTP_CREATED);
        const [row] = [...world.caps.rows.values()];
        expect([row?.familyId ?? null, row?.sessionHash ?? null, row?.accessTokenId ?? null]).toEqual([
            null,
            null,
            null,
        ]);

        const response = await put(world, pathOf(minted.json().uploadUrl), pngBytes());

        expect(response.statusCode).toBe(HTTP_CREATED);
    });

    it('holds a chunked body to exactly maxBytes: that many is accepted, one more is refused', async () => {
        const world = await boot();
        const png = Buffer.from(pngBytes());
        const chunked = (path: string) =>
            new Promise<number>((resolve) => {
                const req = httpRequest({
                    host: LOCALHOST,
                    port: world.port,
                    path,
                    method: 'PUT',
                    headers: {
                        'content-type': OCTET_STREAM_CONTENT_TYPE,
                        'transfer-encoding': 'chunked',
                        [ATTACHMENT_NAME_HEADER]: 'edge.png',
                    },
                });
                req.on('response', (res) => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode ?? 0));
                });
                req.on('error', () => undefined);
                req.write(png.subarray(0, 10));
                req.end(png.subarray(10));
            });
        const exact = await mint(world, 'alice', { maxBytes: png.length });
        const under = await mint(world, 'alice', { maxBytes: png.length - 1 });

        expect(await chunked(pathOf(exact.uploadUrl))).toBe(HTTP_CREATED);
        expect(await chunked(pathOf(under.uploadUrl))).toBe(HTTP_PAYLOAD_TOO_LARGE);
    });

    it('requires the file name', async () => {
        const world = await boot();
        const { uploadUrl } = await mint(world);

        const response = await put(world, pathOf(uploadUrl), pngBytes(), {});

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe(ERROR_CODES.BAD_ATTACHMENT);
    });

    it('a client that aborts mid-body leaves the capability open and no file behind', async () => {
        const world = await boot();
        const { uploadUrl } = await mint(world);
        const png = Buffer.from(pngBytes(32, 32));

        await new Promise<void>((resolve) => {
            const req = httpRequest({
                host: LOCALHOST,
                port: world.port,
                path: pathOf(uploadUrl),
                method: 'PUT',
                headers: {
                    'content-type': OCTET_STREAM_CONTENT_TYPE,
                    'content-length': String(png.length),
                    [ATTACHMENT_NAME_HEADER]: 'cut.png',
                },
            });
            req.on('error', () => resolve());
            req.on('close', () => resolve());
            req.write(png.subarray(0, 10), () => setTimeout(() => req.destroy(), 20));
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(world.attachments()).toHaveLength(0);

        const retry = await put(world, pathOf(uploadUrl), png);
        expect(retry.statusCode).toBe(HTTP_CREATED);
        expect(world.attachments()).toHaveLength(1);
    });

    it('answers 503, not a verdict, when the capability store cannot be read', async () => {
        const world = await boot();
        const { uploadUrl } = await mint(world);
        world.caps.state.failReads = true;

        const response = await put(world, pathOf(uploadUrl), pngBytes());

        expect(response.statusCode).toBe(HTTP_UNAVAILABLE);
        expect(world.attachments()).toHaveLength(0);
    });

    it('never writes the capability to the log', async () => {
        const world = await boot();
        const { uploadUrl } = await mint(world);
        const capability = pathOf(uploadUrl).split('/').pop() as string;
        world.caps.state.failReads = true;
        await put(world, pathOf(uploadUrl), pngBytes());
        world.caps.state.failReads = false;
        await put(world, pathOf(uploadUrl), pngBytes());
        await put(world, pathOf(uploadUrl), pngBytes(8, 8));

        expect(world.lines.length).toBeGreaterThan(0);
        expect(world.lines.join('\n')).not.toContain(capability);
    });
});

describe('create_attachment_upload with an uploadId', () => {
    it("reports the open, completed and expired states of the caller's own requests", async () => {
        let clock = Date.now();
        const world = await boot({ now: () => clock });
        const open = await mint(world);
        const done = await mint(world);
        const lapsed = await mint(world, 'alice', {});
        const response = await put(world, pathOf(done.uploadUrl), pngBytes());
        clock += 60 * 60 * 1000;
        const fresh = await mint(world);

        const states = await Promise.all(
            [open, done, lapsed, fresh].map((u) =>
                call(world.url, 'alice', 'create_attachment_upload', { uploadId: u.id })
            )
        );

        expect(states.map((s) => s.data.state)).toEqual(['expired', 'completed', 'expired', 'open']);
        expect(states[1]?.data.attachmentId).toBe(response.json().id);
        expect(states[1]?.data.attachment).toMatchObject({ id: response.json().id, name: 'shot.png' });
        expect(states[1]?.data.uploadUrl).toBeUndefined();
    });

    it("does not show another account's request, even in the same org", async () => {
        const world = await boot();
        const theirs = await mint(world, 'alice');

        const peek = await call(world.url, 'writeOnly', 'create_attachment_upload', { uploadId: theirs.id });
        const foreign = await call(world.url, 'bob', 'create_attachment_upload', { uploadId: theirs.id });

        for (const result of [peek, foreign]) {
            expect(result.isError).toBe(true);
            expect(result.data.status).toBe(HTTP_NOT_FOUND);
        }
    });

    it('is inconclusive, never "not found", when the state cannot be read', async () => {
        const world = await boot();
        const { id } = await mint(world);
        world.caps.state.failReads = true;

        const result = await call(world.url, 'alice', 'create_attachment_upload', { uploadId: id });

        expect(result.isError).toBe(true);
        expect(result.data.outcome).toBe('inconclusive');
    });

    it('refuses an id that is not an id, such as a client-local path', async () => {
        const world = await boot();

        for (const uploadId of ['/home/me/shot.png', 'file:///etc/passwd', '../x']) {
            const result = await call(world.url, 'alice', 'create_attachment_upload', { uploadId });
            expect(result.isError, uploadId).toBe(true);
        }
    });
});
