import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTACHMENT_NAME_HEADER, ERROR_CODES, OCTET_STREAM_CONTENT_TYPE } from '@factory-ai/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Sql } from 'postgres';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import { createAttachmentRows } from '../src/attachments/attachment-rows.js';
import { createAttachmentStore } from '../src/attachments/attachment-store.js';
import { createUploadCapabilityStore } from '../src/attachments/upload-capability-store.js';
import { createAuthStore } from '../src/auth/store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { staticRepoSource } from '../src/github/repo-source.js';
import type { OrgRegistry } from '../src/orgs.js';
import { pdfBytes, pngBytes, textBytes } from '../test/helpers-attachments.js';
import { githubAuth, staticRegistry, stubTelemetryClient, telemetryStoreStub, testConfig } from '../test/helpers.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { buildWorld, grant, okGrant, type OAuthWorld } from './oauth-rig.js';

/**
 * The attachment handoff over real stores (BEL-248): a capability minted through MCP, spent by a plain HTTP PUT, and
 * the resulting file bound by `create_task`. `server/test/mcp.attachment-upload.test.ts` holds the in-memory twin.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const ORG = testOrg();
const OTHER_ORG = testOrg();
const db = useTestDb({ orgs: [ORG, OTHER_ORG] });

let sql: Sql;
beforeAll(() => {
    if (enabled) sql = db.sql;
});

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
    for (const close of closers.splice(0)) await close();
});

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

type Who = 'alice' | 'mallory' | 'bob';

async function boot() {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const worlds: Record<Who, OAuthWorld> = {
        alice: await buildWorld(sql, ORG),
        mallory: await buildWorld(sql, ORG),
        bob: await buildWorld(sql, OTHER_ORG),
    };
    const tokens = {} as Record<Who, { accessToken: string; familyId: string }>;
    for (const who of Object.keys(worlds) as Who[]) {
        worlds[who].resource = resource;
        tokens[who] = okGrant(await grant(worlds[who], ['factory:read', 'factory:write']));
    }
    const config = testConfig({
        auth: githubAuth({ publicUrl }),
        port,
        mcp: { enabled: true, resource, trustedOrigins: [] },
    });
    const objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'attachment-handoff-db-')));
    const storeOf = (org: string) =>
        createAttachmentStore({
            rows: createAttachmentRows({ sql, orgId: org, ready: Promise.resolve() }),
            objects,
            orgId: org,
            prefix: 'test/',
        });
    const jobs = createJobStore({ sql, orgId: ORG });
    const base = staticRegistry({
        config,
        telemetry: stubTelemetryClient(),
        repos: staticRepoSource([{ owner: 'acme', name: 'web' }]),
        jobs,
    });
    const orgs: OrgRegistry = {
        ...base,
        for: async (orgId) => {
            const runtime = await base.for(orgId);
            return runtime && { ...runtime, orgId, attachments: storeOf(orgId) };
        },
    };
    const app = await buildApp({
        config,
        orgs,
        store: telemetryStoreStub(),
        auth: createAuthStore({ sql }),
        oauth: worlds.alice.store,
        uploadCapabilities: createUploadCapabilityStore({ sql }),
        // The in-flight cap sheds with 503; the races below are about the file, not about admission.
        attachmentMaxInFlight: 16,
    });
    closers.push(() => app.close());
    await app.listen({ port, host: LOCALHOST });
    return { url: new URL(resource), origin: publicUrl, worlds, tokens };
}
type Board = Awaited<ReturnType<typeof boot>>;

const call = async (board: Board, who: Who, name: string, args: Record<string, unknown> = {}) => {
    const client = new Client({ name: 'handoff', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(board.url, {
            requestInit: { headers: { authorization: `Bearer ${board.tokens[who].accessToken}` } },
        })
    );
    try {
        const result = await client.callTool({ name, arguments: args });
        // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
        return { ...result, data: result.structuredContent as Record<string, any> };
    } finally {
        await client.close();
    }
};

const mint = async (board: Board, who: Who = 'alice', args: Record<string, unknown> = {}) => {
    const made = await call(board, who, 'create_attachment_upload', args);
    expect(made.isError, JSON.stringify(made.data)).toBeFalsy();
    return made.data;
};

const PNG = pngBytes();
const putTo = (
    uploadUrl: string,
    body: Uint8Array = PNG,
    headers: Record<string, string> = { [ATTACHMENT_NAME_HEADER]: encodeURIComponent('shot.png') }
) =>
    fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': OCTET_STREAM_CONTENT_TYPE, ...headers },
        body: Buffer.from(body),
    });

const upload = async (board: Board, who: Who = 'alice', body: Uint8Array = PNG) => {
    const { uploadUrl } = await mint(board, who);
    const response = await putTo(uploadUrl, body);
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string };
};

const jobCount = async (): Promise<number> => {
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from job where org_id = ${ORG}`;
    return Number(row?.n);
};

const rowOf = async (id: string) => {
    const [row] = await sql<{ state: string; bound_job_id: string | null }[]>`
        select state, bound_job_id from input_attachment where id = ${id}
    `;
    return row;
};

const task = (board: Board, who: Who, attachmentIds: string[]) =>
    call(board, who, 'create_task', { command: `look ${randomUUID()}`, repo: 'acme/web', attachmentIds });

describe.skipIf(!enabled)('the attachment handoff over real stores', () => {
    it('mints a capability bound to the caller, org, grant family and limits, storing only its hash', async () => {
        const board = await boot();

        const data = await mint(board, 'alice', { maxBytes: 4096, mediaTypes: ['image/png', 'application/pdf'] });

        const [row] = await sql<
            {
                org_id: string;
                user_id: string;
                family_id: string;
                max_bytes: string;
                media_types: string[];
                hash: string;
                completed_at: Date | null;
            }[]
        >`
            select org_id, user_id, family_id, max_bytes::text, media_types, encode(capability_hash, 'hex') as hash,
                   completed_at
            from attachment_upload where id = ${data.id}
        `;
        const capability = new URL(data.uploadUrl).pathname.split('/').pop() as string;
        expect(row).toMatchObject({
            org_id: ORG,
            user_id: board.worlds.alice.caller.user.id,
            family_id: board.tokens.alice.familyId,
            max_bytes: '4096',
            completed_at: null,
        });
        expect([...(row?.media_types ?? [])].sort()).toEqual(['application/pdf', 'image/png']);
        expect(row?.hash).not.toContain(capability);
        expect(capability).toMatch(/^fcu_/);
    });

    it('uploads through the capability and the id binds to a task as the board does for any upload', async () => {
        const board = await boot();
        const { id: uploadId, uploadUrl } = await mint(board);

        const response = await putTo(uploadUrl);
        const file = (await response.json()) as { id: string; sha256: string; size: number };

        expect(response.status).toBe(201);
        expect(file.size).toBe(PNG.length);
        const status = await call(board, 'alice', 'create_attachment_upload', { uploadId });
        expect(status.data).toMatchObject({ id: uploadId, state: 'completed', attachmentId: file.id });
        expect(status.data.attachment).toMatchObject({ id: file.id, sha256: file.sha256 });

        const created = await task(board, 'alice', [file.id]);
        expect(created.isError, JSON.stringify(created.data)).toBeFalsy();
        expect(await rowOf(file.id)).toEqual({ state: 'bound', bound_job_id: created.data.id });
    });

    it("refuses a foreign org's file, another member's file and a half-written file, creating no task", async () => {
        const board = await boot();
        const foreign = await upload(board, 'bob');
        const theirs = await upload(board, 'mallory');
        const pending = randomUUID();
        await sql`
            insert into input_attachment (org_id, id, uploader_id, name, media_type, size_bytes, sha256, object_key, state)
            values (${ORG}, ${pending}, ${board.worlds.alice.caller.user.id}, 'half.png', 'image/png', 33, ${randomUUID()},
                    ${`k/${pending}`}, 'pending')
        `;
        const before = await jobCount();

        for (const id of [foreign.id, theirs.id, pending]) {
            const refused = await task(board, 'alice', [id]);
            expect(refused.isError, id).toBe(true);
            expect(refused.data.outcome).toBe('refused');
        }

        expect(await jobCount()).toBe(before);
        expect((await rowOf(foreign.id))?.state).toBe('ready');
        expect((await rowOf(theirs.id))?.state).toBe('ready');
    });

    it('rejects an id that is a client-local path or a URL, creating no task', async () => {
        const board = await boot();
        const before = await jobCount();

        for (const id of [
            '/home/me/shot.png',
            '~/shot.png',
            '../shot.png',
            'file:///etc/passwd',
            'http://169.254.169.254/',
        ]) {
            const refused = await task(board, 'alice', [id]);
            expect(refused.isError, id).toBe(true);
            expect(refused.data.outcome, id).toBe('refused');
        }

        expect(await jobCount()).toBe(before);
    });

    it('refuses a type the board rejects and an overflow, leaving the capability open', async () => {
        const board = await boot();
        const { id, uploadUrl } = await mint(board, 'alice', {
            maxBytes: 64,
            mediaTypes: ['image/png', 'application/pdf'],
        });

        const script = await putTo(uploadUrl, textBytes('#!/bin/sh\n\u0000'), { [ATTACHMENT_NAME_HEADER]: 'run.sh' });
        const huge = await putTo(uploadUrl, Buffer.concat([PNG, Buffer.alloc(200)]));
        const [left] = await sql<{ n: string }[]>`
            select count(*)::text as n from input_attachment where org_id = ${ORG} and name in ('run.sh', 'shot.png')
              and uploader_id = ${board.worlds.alice.caller.user.id}
        `;
        const ok = await putTo(uploadUrl);

        expect(script.status).toBe(415);
        expect(huge.status).toBe(413);
        expect(left?.n).toBe('0');
        expect(ok.status).toBe(201);
        const status = await call(board, 'alice', 'create_attachment_upload', { uploadId: id });
        expect(status.data.state).toBe('completed');
    });

    it('stops working the moment the grant is revoked', async () => {
        const board = await boot();
        const { uploadUrl } = await mint(board, 'mallory');
        await board.worlds.mallory.store.revokeFamily(board.tokens.mallory.familyId);

        const response = await putTo(uploadUrl);

        expect(response.status).toBe(404);
        expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_INVALID);
        const [written] = await sql<{ n: string }[]>`
            select count(*)::text as n from input_attachment where uploader_id = ${board.worlds.mallory.caller.user.id}
        `;
        expect(written?.n).toBe('0');
    });

    it('stops working the moment the membership is removed', async () => {
        const board = await boot();
        const { uploadUrl } = await mint(board, 'mallory');
        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${board.worlds.mallory.caller.user.id}`;

        const response = await putTo(uploadUrl);

        expect(response.status).toBe(404);
        expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_INVALID);
    });

    it('refuses an expired capability, even one whose file was already uploaded', async () => {
        const board = await boot();
        const fresh = await mint(board);
        const used = await mint(board);
        expect((await putTo(used.uploadUrl)).status).toBe(201);
        await sql`update attachment_upload set expires_at = now() - interval '1 second' where id in ${sql([fresh.id, used.id])}`;

        for (const { uploadUrl } of [fresh, used]) {
            const response = await putTo(uploadUrl);
            expect(response.status).toBe(410);
            expect(((await response.json()) as { code: string }).code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_EXPIRED);
        }
        const status = await call(board, 'alice', 'create_attachment_upload', { uploadId: fresh.id });
        expect(status.data.state).toBe('expired');
    });

    it('spends it once: the same bytes replay the same file, other bytes are refused', async () => {
        const board = await boot();
        const { uploadUrl } = await mint(board);

        const first = await putTo(uploadUrl);
        const again = await putTo(uploadUrl);
        const other = await putTo(uploadUrl, pdfBytes(), { [ATTACHMENT_NAME_HEADER]: 'spec.pdf' });

        expect(first.status).toBe(201);
        expect(again.status).toBe(201);
        expect(again.headers.get('idempotency-replayed')).toBe('true');
        expect(((await again.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);
        expect(other.status).toBe(409);
        expect(((await other.json()) as { code: string }).code).toBe(ERROR_CODES.UPLOAD_CAPABILITY_SPENT);
    });

    it('converges concurrent retries on one file, and concurrent different files on exactly one', async () => {
        const board = await boot();
        const same = await mint(board);
        const mixed = await mint(board);
        const spec = { [ATTACHMENT_NAME_HEADER]: 'spec.pdf' };

        const retries = await Promise.all(Array.from({ length: 6 }, () => putTo(same.uploadUrl)));
        const race = await Promise.all(
            Array.from({ length: 6 }, (_v, i) =>
                i % 2 === 0 ? putTo(mixed.uploadUrl) : putTo(mixed.uploadUrl, pdfBytes(), spec)
            )
        );

        expect(new Set(retries.map((r) => r.status))).toEqual(new Set([201]));
        expect(new Set(await Promise.all(retries.map(async (r) => ((await r.json()) as { id: string }).id))).size).toBe(
            1
        );
        expect(race.filter((r) => r.status === 201).length).toBeGreaterThan(0);
        expect(new Set(race.map((r) => r.status))).toEqual(new Set([201, 409]));
        const rows = await sql<{ id: string }[]>`
            select id from input_attachment where idempotency_key in (${`upload-${same.id}`}, ${`upload-${mixed.id}`})
        `;
        expect(rows).toHaveLength(2);
        const status = await call(board, 'alice', 'create_attachment_upload', { uploadId: mixed.id });
        expect(status.data.state).toBe('completed');
    });

    it("does not show one member's request to another, and an unknown id is a refusal", async () => {
        const board = await boot();
        const { id } = await mint(board, 'alice');

        for (const who of ['mallory', 'bob'] as const) {
            const peek = await call(board, who, 'create_attachment_upload', { uploadId: id });
            expect(peek.isError, who).toBe(true);
            expect(peek.data.status, who).toBe(404);
        }
        const unknown = await call(board, 'alice', 'create_attachment_upload', { uploadId: randomUUID() });
        expect(unknown.data.status).toBe(404);
    });

    it('purges expired capabilities and keeps the rest', async () => {
        const board = await boot();
        const lapsed = await mint(board);
        const live = await mint(board);
        await sql`update attachment_upload set expires_at = now() - interval '2 days' where id = ${lapsed.id}`;

        const purged = await createUploadCapabilityStore({ sql }).purgeExpired();

        expect(purged).toBeGreaterThanOrEqual(1);
        const rows = await sql<
            { id: string }[]
        >`select id from attachment_upload where id in ${sql([lapsed.id, live.id])}`;
        expect(rows.map((r) => r.id)).toEqual([live.id]);
    });
});
