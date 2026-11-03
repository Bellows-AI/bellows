import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Sql } from 'postgres';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createAuthStore } from '../src/auth/store.js';
import { githubAuth, staticRegistry, stubTelemetryClient, telemetryStoreStub, testConfig } from '../test/helpers.js';
import { testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { buildWorld, grant, okGrant } from './oauth-rig.js';

const enabled = Boolean(process.env.DATABASE_URL);
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const HTTP_UNAUTHORIZED = 401;
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });

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

describe.skipIf(!enabled)('whoami with a token minted by the real OAuth store', () => {
    it('answers the member, then the next POST /api/mcp is 401 once the membership is gone', async () => {
        const port = await freePort();
        const publicUrl = `http://${LOCALHOST}:${port}`;
        const resource = `${publicUrl}/api/mcp`;
        const world = await buildWorld(sql, ORG);
        world.resource = resource;
        const minted = okGrant(await grant(world, ['factory:read']));

        const config = testConfig({
            auth: githubAuth({ publicUrl }),
            port,
            mcp: { enabled: true, resource, trustedOrigins: [] },
        });
        const app = await buildApp({
            config,
            orgs: staticRegistry({ config, telemetry: stubTelemetryClient(), orgsFor: [ORG] }),
            store: telemetryStoreStub(),
            auth: createAuthStore({ sql }),
            oauth: world.store,
        });
        closers.push(() => app.close());
        await app.listen({ port, host: LOCALHOST });

        const client = new Client({ name: 'whoami', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(
            new StreamableHTTPClientTransport(new URL(resource), {
                requestInit: { headers: { authorization: `Bearer ${minted.accessToken}` } },
            })
        );
        const result = await client.callTool({ name: 'whoami', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
            account: { login: world.caller.user.login },
            organization: { id: ORG },
            scopes: ['factory:read'],
        });
        await client.close();

        await sql`delete from org_membership where org_id = ${ORG} and user_id = ${world.caller.user.id}`;
        const after = await fetch(resource, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${minted.accessToken}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        expect(after.status).toBe(HTTP_UNAUTHORIZED);
    });
});
