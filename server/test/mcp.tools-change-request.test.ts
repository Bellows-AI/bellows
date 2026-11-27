import { createServer } from 'node:net';
import { githubRepo, type RepoRef } from '@factory-ai/core';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { McpCaller, OAuthStore } from '../src/auth/oauth-store.js';
import { hashToken } from '../src/auth/session.js';
import type { GitlabApi, GitlabRequest, GitlabResponse } from '../src/gitlab/gitlab-api.js';
import type { MemberForgeGrants } from '../src/integrations/member-forge-grant.js';
import type { OrgRegistry } from '../src/orgs.js';
import {
    githubAuth,
    jobStoreSlice,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { trackApps } from './helpers-http.js';

/**
 * `read_change_request` through the real auth plugin, bridge and user route, over a scripted GitLab: a 2xx is data, a
 * broken grant is a refusal naming the page to reconnect, and anything unconfirmed is inconclusive, never an empty diff.
 */
const track = trackApps();
const LOCALHOST = '127.0.0.1';
const MODERN = '2026-07-28';
const TOKEN = 'mat_cr-alice-token-0123456789';
const JOB = '11111111-1111-4111-8111-111111111111';
const HOST = 'board.gitlab.test';
const PATH = 'grp/sub/web';
const FORGE = `gitlab:${HOST}`;
const OK = 200;

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

const file = {
    old_path: 'a.txt',
    new_path: 'a.txt',
    new_file: false,
    deleted_file: false,
    renamed_file: false,
    diff: '@@ -1 +1 @@\n-a\n+b\n',
};

interface Scenario {
    repo?: RepoRef | null;
    published?: boolean;
    grant?: 'live' | 'reconnect' | 'unconfirmed';
    answer?: (request: GitlabRequest) => GitlabResponse;
}

async function boot(scenario: Scenario = {}) {
    const port = await freePort();
    const publicUrl = `http://${LOCALHOST}:${port}`;
    const resource = `${publicUrl}/api/mcp`;
    const auth = memoryAuthStore();
    const alice = auth.seedMember('org-a', 'alice', 'admin');
    const tokens = new Map<string, McpCaller>([
        [
            hashToken(TOKEN).toString('hex'),
            { ...alice, scopes: ['factory:read'], clientId: 'c', resource, familyId: 'f-alice' },
        ],
    ]);
    const oauth: Pick<OAuthStore, 'findAccessToken'> = {
        findAccessToken: async (hash) => tokens.get(hash.toString('hex')) ?? null,
    };
    const config = testConfig({
        auth: githubAuth({ publicUrl }),
        port,
        mcp: { enabled: true, resource, trustedOrigins: [] },
    });
    const requests: GitlabRequest[] = [];
    const answer = scenario.answer ?? (() => ({ ok: true, status: OK, text: '[]' }) as GitlabResponse);
    const gitlabApi = {
        request: async (request: GitlabRequest) => {
            requests.push(request);
            return answer(request);
        },
    } as unknown as GitlabApi;
    const grant = scenario.grant ?? 'live';
    const memberGrants = {
        accessToken: async () => {
            if (grant === 'unconfirmed') throw new Error('store down');
            return grant === 'live'
                ? { ok: true, accessToken: 'glpat-starter', expiresAt: null }
                : { ok: false, outcome: { outcome: 'integration_required', reason: 'reconnect' } };
        },
        standing: async () => 'live',
    } as unknown as MemberForgeGrants;
    const repo = scenario.repo === undefined ? { forge: 'gitlab' as const, host: HOST, path: PATH } : scenario.repo;
    const jobs = jobStoreSlice({
        changeRequestContext: async (id: string) =>
            id === JOB
                ? {
                      result: 'ok',
                      orgId: 'org-a',
                      rootJobId: JOB,
                      ref: repo,
                      executionUserId: 'user-starter',
                      publication:
                          scenario.published === false
                              ? null
                              : { number: 7, url: `https://${HOST}/${PATH}/-/merge_requests/7` },
                  }
                : { result: 'missing' },
    });
    const base = staticRegistry({ config, telemetry: stubTelemetryClient(), jobs });
    const orgs: OrgRegistry = {
        ...base,
        for: async (id) => {
            const runtime = await base.for(id);
            return (
                runtime && {
                    ...runtime,
                    forgeConnections: { application: async () => ({ active: true, caBundle: undefined }) },
                }
            );
        },
    } as OrgRegistry;
    const app = track(
        await buildApp({
            config,
            orgs,
            store: telemetryStoreStub(),
            auth,
            oauth: oauth as OAuthStore,
            memberGrants,
            gitlabApi,
        })
    );
    await app.listen({ port, host: LOCALHOST });
    return { url: new URL(resource), requests };
}

const call = async (url: URL, args: Record<string, unknown>) => {
    const client = new Client({ name: 'cr', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await client.connect(
        new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } })
    );
    try {
        const result = await client.callTool({ name: 'read_change_request', arguments: args });
        // biome-ignore lint/suspicious/noExplicitAny: structured content is asserted field by field below
        return { ...result, data: result.structuredContent as Record<string, any> };
    } finally {
        await client.close();
    }
};

const page = (request: GitlabRequest, entries: unknown[]): GitlabResponse =>
    request.path.endsWith('&page=1')
        ? { ok: true, status: OK, text: JSON.stringify(entries) }
        : { ok: true, status: OK, text: '[]' };

describe('read_change_request over POST /api/mcp', () => {
    it('is listed read-only with an output schema', async () => {
        const { url } = await boot();
        const client = new Client({ name: 'cr', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(
            new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } })
        );
        const tool = (await client.listTools()).tools.find((t) => t.name === 'read_change_request');
        await client.close();
        expect(tool?.annotations?.readOnlyHint).toBe(true);
        expect(tool?.outputSchema?.type).toBe('object');
    });

    it('answers the diff as data, read with the starter’s token under the encoded project', async () => {
        const { url, requests } = await boot({ answer: (request) => page(request, [file]) });
        const result = await call(url, { taskId: JOB, part: 'diff' });
        expect(result.isError).toBeFalsy();
        expect(result.data).toMatchObject({ part: 'diff', number: 7, files: [{ newPath: 'a.txt', diff: file.diff }] });
        expect(requests[0]?.headers?.authorization).toBe('Bearer glpat-starter');
        expect(requests[0]?.path).toContain('/projects/grp%2Fsub%2Fweb/merge_requests/7/diffs');
    });

    it('answers a broken grant as a FORGE_GRANT_REQUIRED refusal that names the page to reconnect', async () => {
        const { url, requests } = await boot({ grant: 'reconnect' });
        const result = await call(url, { taskId: JOB, part: 'diff' });
        expect(result.isError).toBe(true);
        expect(result.data).toMatchObject({ outcome: 'refused', code: 'FORGE_GRANT_REQUIRED', status: 409 });
        expect(result.data.message).toContain('/settings/integrations/gitlab');
        expect(requests).toEqual([]);
        expect(FORGE).toContain(HOST);
    });

    it('is inconclusive, never an empty diff, for a 503, a timeout and a body that fails the schema', async () => {
        for (const answer of [
            () => ({ ok: true, status: 500, text: '{}' }) as GitlabResponse,
            () => ({ ok: false, reason: 'timeout', sent: true }) as GitlabResponse,
            (request: GitlabRequest) => page(request, [{ not: 'a file' }]),
        ]) {
            const { url } = await boot({ answer });
            const result = await call(url, { taskId: JOB, part: 'diff' });
            expect(result.isError).toBe(true);
            expect(result.data).toMatchObject({ outcome: 'inconclusive' });
            expect(result.data).not.toHaveProperty('files');
        }
        const unconfirmed = await call((await boot({ grant: 'unconfirmed' })).url, { taskId: JOB, part: 'notes' });
        expect(unconfirmed.data).toMatchObject({ outcome: 'inconclusive' });
    });

    it('refuses a task with no merge request and a GitHub task, with their own codes', async () => {
        const none = await call((await boot({ published: false })).url, { taskId: JOB, part: 'notes' });
        expect(none.data).toMatchObject({ outcome: 'refused', code: 'NO_CHANGE_REQUEST', status: 404 });
        const { url, requests } = await boot({ repo: githubRepo('acme/web') });
        const github = await call(url, { taskId: JOB, part: 'diff' });
        expect(github.data).toMatchObject({ outcome: 'refused', code: 'CHANGE_REQUEST_READ_UNSUPPORTED', status: 409 });
        expect(requests).toEqual([]);
    });

    it('rejects a part that is not one', async () => {
        const { url } = await boot();
        const result = await call(url, { taskId: JOB, part: 'everything' }).catch((e: Error) => e);
        expect(result instanceof Error || (result as { isError?: boolean }).isError).toBeTruthy();
    });
});
