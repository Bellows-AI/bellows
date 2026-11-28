import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { NO_MODEL_MESSAGE, normalizeModelId, OPENROUTER_ANTHROPIC_BASE_URL } from '@factory-ai/core';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { createProviderConnectionStore, type ProviderConnectionStore } from '../src/db/provider-connection-store.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { expireLease, lapseDeferral, mustCreate, testOrg, testUser } from './fixtures.js';
import { faultySecrets, testSecretStore } from './env-secrets-harness.js';
import { useTestDb } from './harness.js';

/**
 * A profile's selected provider connection at claim (docs/env.md): its key and endpoint are ONE layer above
 * the stacked env scopes and below the pasted config, resolved from the connection's CURRENT sealed secret,
 * re-checked for visibility and compatibility, and never replaced by ambient credentials once the reference
 * is bad. The real stores run against PostgreSQL; only the secret store's read is faulted in one test.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const LEASE_SECONDS = 300;
const ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;
const AMBIENT_URL = 'https://ambient-proxy.example.test';
const CONN_URL = 'https://gateway.example.test/v1';
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER, BOB_USER] });

let sql: Sql;

function stores(over: { secrets?: SecretStore; mode?: 'cloud' | 'self-hosted' } = {}) {
    const secrets = over.secrets ?? testSecretStore(sql);
    const deps = { sql, orgId: ORG, secrets, secretLog: () => {} };
    const executors = createUserExecutorStore(deps);
    const connections = createProviderConnectionStore(deps);
    const env = createEnvVarStore(deps);
    const jobs = createJobStore({
        sql,
        orgId: ORG,
        env,
        executorConfig: executors,
        providerConnections: connections,
        deploymentMode: over.mode ?? 'self-hosted',
    });
    return { executors, connections, env, jobs };
}

const connect = (
    connections: ProviderConnectionStore,
    over: Partial<Parameters<ProviderConnectionStore['create']>[0]> = {}
) =>
    connections.create({
        scope: 'personal',
        userId: ALICE,
        provider: 'anthropic',
        name: `conn-${Math.random().toString(36).slice(2, 8)}`,
        baseUrl: null,
        key: 'sk-ant-connection-key',
        ...over,
    });

const queue = (jobs: ReturnType<typeof stores>['jobs'], executor: string, scope: 'user' | 'org' = 'user') =>
    mustCreate(jobs.create('echo hi', ALICE, { repo: null, executor, executorScope: scope }));

beforeAll(() => {
    if (enabled) sql = db.sql;
});

describe.skipIf(!enabled)('a profile provider connection at claim', () => {
    it('a connection alone satisfies the model requirement and the claim', async () => {
        const { executors, connections, jobs } = stores({ mode: 'cloud' });
        const conn = await connect(connections);
        await executors.replace(ALICE, [
            { name: 'solo', type: 'claude-code', config: {}, providerConnectionId: conn.id },
        ]);
        await queue(jobs, 'solo');

        const claim = await jobs.claim('w1', LEASE_SECONDS);

        expect(claim?.executorRefusal ?? null).toBeNull();
        expect(claim?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-connection-key');
    });

    it('without a connection or a key the same cloud claim is NO_MODEL (the layer is the difference)', async () => {
        const { executors, jobs } = stores({ mode: 'cloud' });
        await executors.replace(ALICE, [{ name: 'bare', type: 'claude-code', config: {} }]);
        await queue(jobs, 'bare');

        expect((await jobs.claim('w1', LEASE_SECONDS))?.executorRefusal).toBe(NO_MODEL_MESSAGE);
    });

    it('two executors use different supported providers, and two share one connection', async () => {
        const { executors, connections, jobs } = stores();
        const anthropic = await connect(connections, { key: 'sk-ant-A' });
        const openai = await connect(connections, { provider: 'openai', key: 'sk-openai-B' });
        await executors.replace(ALICE, [
            { name: 'cc', type: 'claude-code', config: {}, providerConnectionId: anthropic.id },
            { name: 'cc2', type: 'opencode', config: {}, providerConnectionId: anthropic.id },
            { name: 'oc', type: 'opencode', config: {}, providerConnectionId: openai.id },
        ]);
        for (const name of ['cc', 'cc2', 'oc']) await queue(jobs, name);

        const claims = [
            await jobs.claim('w1', LEASE_SECONDS),
            await jobs.claim('w2', LEASE_SECONDS),
            await jobs.claim('w3', LEASE_SECONDS),
        ];
        const byType = (type: string, key: string) =>
            claims.find((c) => c?.executorType === type && c.env?.[key] !== undefined);

        expect(byType('claude-code', 'ANTHROPIC_API_KEY')?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-A');
        expect(byType('opencode', 'OPENAI_API_KEY')?.env?.OPENAI_API_KEY).toBe('sk-openai-B');
        expect(byType('opencode', 'ANTHROPIC_API_KEY')?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-A');
    });

    it('shared connection rotation reaches later claims only, and a reclaim resolves the current key', async () => {
        const { executors, connections, jobs } = stores();
        const conn = await connect(connections, { key: 'sk-ant-OLD' });
        await executors.replace(ALICE, [
            { name: 'a', type: 'claude-code', config: {}, providerConnectionId: conn.id },
            { name: 'b', type: 'claude-code', config: {}, providerConnectionId: conn.id },
        ]);
        const first = await queue(jobs, 'a');
        const running = await jobs.claim('w1', LEASE_SECONDS);
        expect(running?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-OLD');

        await connections.update(ALICE, conn.id, { key: 'sk-ant-NEW' });
        await queue(jobs, 'b');
        const later = await jobs.claim('w2', LEASE_SECONDS);
        // The running attempt keeps what it was injected with.
        expect(running?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-OLD');
        expect(later?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-NEW');

        // The lease lapses: the reclaim of the same task resolves the key as it is now, state untouched.
        await expireLease(sql, first.id);
        const reclaim = await jobs.claim('w3', LEASE_SECONDS);
        expect(reclaim?.id).toBe(first.id);
        expect(reclaim?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-NEW');
    });

    it('switching one executor leaves its sibling and the shared connection unchanged', async () => {
        const { executors, connections, jobs } = stores();
        const shared = await connect(connections, { key: 'sk-ant-SHARED' });
        const other = await connect(connections, { provider: 'openrouter', key: 'sk-or-OTHER' });
        await executors.replace(ALICE, [
            { name: 'a', type: 'opencode', config: {}, providerConnectionId: shared.id },
            { name: 'b', type: 'opencode', config: {}, providerConnectionId: shared.id },
        ]);
        await executors.replace(ALICE, [
            { name: 'a', type: 'opencode', config: {}, providerConnectionId: other.id },
            { name: 'b', type: 'opencode', config: {}, providerConnectionId: shared.id },
        ]);
        await queue(jobs, 'a');
        await queue(jobs, 'b');

        const claims = [await jobs.claim('w1', LEASE_SECONDS), await jobs.claim('w2', LEASE_SECONDS)];
        expect(claims.map((c) => c?.env?.OPENROUTER_API_KEY).filter(Boolean)).toEqual(['sk-or-OTHER']);
        expect(claims.map((c) => c?.env?.ANTHROPIC_API_KEY).filter(Boolean)).toEqual(['sk-ant-SHARED']);
        expect((await connections.forUser(ALICE, shared.id))?.provider).toBe('anthropic');
    });

    it('a connection on its default endpoint cannot inherit an ambient custom endpoint', async () => {
        const { executors, connections, env, jobs } = stores();
        await env.replaceOrg('admin', [{ name: 'ANTHROPIC_BASE_URL', value: AMBIENT_URL, isSecret: false }]);
        const conn = await connect(connections);
        await executors.replace(ALICE, [
            { name: 'cc', type: 'claude-code', config: {}, providerConnectionId: conn.id },
        ]);
        await queue(jobs, 'cc');

        const claim = await jobs.claim('w1', LEASE_SECONDS);

        // Empty, not absent: a driver-forwarded value under the same name loses to the claim's own.
        expect(claim?.env?.ANTHROPIC_BASE_URL).toBe('');
        expect(JSON.stringify(claim?.env)).not.toContain(AMBIENT_URL);
        expect(claim?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-connection-key');
    });

    it('a connection with an endpoint supplies it with its key', async () => {
        const { executors, connections, jobs } = stores();
        const conn = await connect(connections, { provider: 'litellm', baseUrl: CONN_URL });
        await executors.replace(ALICE, [
            { name: 'cc', type: 'claude-code', config: {}, providerConnectionId: conn.id },
        ]);
        await queue(jobs, 'cc');

        const claim = await jobs.claim('w1', LEASE_SECONDS);

        expect(claim?.env).toMatchObject({ ANTHROPIC_BASE_URL: CONN_URL, ANTHROPIC_API_KEY: 'sk-ant-connection-key' });
    });

    it('removes conflicting ambient authentication and routing', async () => {
        const { executors, connections, env, jobs } = stores();
        await env.replaceOrg('admin', [
            { name: 'ANTHROPIC_AUTH_TOKEN', value: 'ambient-bearer', isSecret: true },
            { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'ambient-oauth', isSecret: true },
            { name: 'OPENROUTER_API_KEY', value: 'ambient-or', isSecret: true },
        ]);
        const conn = await connect(connections);
        await executors.replace(ALICE, [
            { name: 'cc', type: 'claude-code', config: {}, providerConnectionId: conn.id },
        ]);
        await queue(jobs, 'cc');

        const claim = await jobs.claim('w1', LEASE_SECONDS);

        expect(claim?.env).toMatchObject({
            ANTHROPIC_API_KEY: 'sk-ant-connection-key',
            ANTHROPIC_AUTH_TOKEN: '',
            CLAUDE_CODE_OAUTH_TOKEN: '',
            OPENROUTER_API_KEY: '',
        });
        expect(JSON.stringify(claim?.env)).not.toContain('ambient');
    });

    it('pasted config credentials retain precedence', async () => {
        const { executors, connections, jobs } = stores();
        const anthropic = await connect(connections);
        const openai = await connect(connections, { provider: 'openai', key: 'sk-openai-conn', baseUrl: CONN_URL });
        await executors.replace(ALICE, [
            {
                name: 'cc',
                type: 'claude-code',
                config: { env: { ANTHROPIC_BASE_URL: 'https://deliberate.example.test' } },
                providerConnectionId: anthropic.id,
            },
            {
                name: 'oc',
                type: 'opencode',
                config: {
                    provider: {
                        openai: { options: { baseURL: 'https://deliberate.example.test', apiKey: 'pasted-literal' } },
                    },
                },
                providerConnectionId: openai.id,
            },
        ]);
        await queue(jobs, 'cc');
        await queue(jobs, 'oc');

        const claims = [await jobs.claim('w1', LEASE_SECONDS), await jobs.claim('w2', LEASE_SECONDS)];
        const cc = claims.find((c) => c?.executorType === 'claude-code');
        const oc = claims.find((c) => c?.executorType === 'opencode');

        // The pasted settings travel last and still win inside the CLI; the connection supplied the key beneath.
        expect(JSON.parse(cc?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? '{}').env.ANTHROPIC_BASE_URL).toBe(
            'https://deliberate.example.test'
        );
        expect(cc?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-connection-key');
        const options = JSON.parse(oc?.env?.OPENCODE_CONFIG_CONTENT ?? '{}').provider.openai.options;
        expect(options).toEqual({ baseURL: 'https://deliberate.example.test', apiKey: 'pasted-literal' });
    });

    it('connection participates in Claude single-scope credentials', async () => {
        const { executors, connections, env, jobs } = stores();
        await env.replaceOrg('admin', [{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-org', isSecret: true }]);
        const conn = await connect(connections, { provider: 'openrouter', key: 'sk-or-conn' });
        await executors.replace(ALICE, [
            { name: 'cc', type: 'claude-code', config: {}, providerConnectionId: conn.id },
        ]);
        await queue(jobs, 'cc');

        const claim = await jobs.claim('w1', LEASE_SECONDS);

        // The org Anthropic key neither rides along nor turns the OpenRouter wiring off.
        expect(claim?.env).toMatchObject({
            ANTHROPIC_BASE_URL: OPENROUTER_ANTHROPIC_BASE_URL,
            ANTHROPIC_AUTH_TOKEN: 'sk-or-conn',
            ANTHROPIC_API_KEY: '',
            OPENROUTER_API_KEY: 'sk-or-conn',
        });
    });

    it('OpenCode env references resolve from connection credentials', async () => {
        const { executors, connections, jobs } = stores();
        const conn = await connect(connections, { provider: 'openai', key: 'sk-openai-ref' });
        await executors.replace(ALICE, [
            {
                name: 'oc',
                type: 'opencode',
                config: {
                    provider: {
                        gw: { options: { baseURL: 'https://gw.example.test', apiKey: '{env:OPENAI_API_KEY}' } },
                    },
                },
                providerConnectionId: conn.id,
            },
        ]);
        await queue(jobs, 'oc');

        const claim = await jobs.claim('w1', LEASE_SECONDS);

        expect(claim?.executorRefusal ?? null).toBeNull();
        expect(JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? '{}').provider.gw.options.apiKey).toBe(
            'sk-openai-ref'
        );
    });

    it('renders an OpenCode endpoint option beneath the pasted config for a custom endpoint', async () => {
        const { executors, connections, jobs } = stores();
        const conn = await connect(connections, { provider: 'openai', key: 'sk-openai-ep', baseUrl: CONN_URL });
        await executors.replace(ALICE, [
            { name: 'oc', type: 'opencode', config: { model: 'openai/gpt-x' }, providerConnectionId: conn.id },
        ]);
        await queue(jobs, 'oc');

        const claim = await jobs.claim('w1', LEASE_SECONDS);

        expect(claim?.env?.OPENAI_BASE_URL).toBe(CONN_URL);
        expect(JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
            model: 'openai/gpt-x',
            provider: { openai: { options: { baseURL: CONN_URL, apiKey: 'sk-openai-ep' } } },
        });
    });

    it('an OpenCode executor on an openai-compatible connection resolves its stored model, and keeps resolving after an endpoint edit', async () => {
        const { executors, connections, jobs } = stores();
        const url = 'https://models.example.test/v1';
        const conn = await connect(connections, { provider: 'openai-compatible', key: 'sk-compat-key', baseUrl: url });
        // The id the endpoint listed, stored through the real normalize path.
        const model = normalizeModelId('openai-compatible', 'opencode', 'local-a');
        await executors.replace(ALICE, [
            { name: 'oc', type: 'opencode', config: { model }, providerConnectionId: conn.id },
        ]);

        const claimed = async (worker: string) => {
            await queue(jobs, 'oc');
            const claim = await jobs.claim(worker, LEASE_SECONDS);
            expect(claim?.executorRefusal ?? null).toBeNull();
            expect(claim?.env?.OPENCODE_CONFIG_CONTENT).not.toContain('{env:');
            return JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? '{}');
        };
        const config = await claimed('w1');
        expect(config.model).toBe('custom/local-a');
        expect(config.provider.custom.options).toEqual({ baseURL: url, apiKey: 'sk-compat-key' });
        expect(Object.keys(config.provider.custom.models)).toEqual(['local-a']);

        const moved = 'https://other.example.test/v1';
        await connections.update(ALICE, conn.id, { baseUrl: moved });
        const after = await claimed('w2');
        expect(after.model).toBe('custom/local-a');
        expect(after.provider.custom.options.baseURL).toBe(moved);
        expect(Object.keys(after.provider.custom.models)).toEqual(['local-a']);
    });

    it('secret read failure rolls back the claim', async () => {
        const healthy = stores();
        const conn = await connect(healthy.connections);
        await healthy.executors.replace(ALICE, [
            { name: 'cc', type: 'claude-code', config: {}, providerConnectionId: conn.id },
        ]);
        const { id } = await queue(healthy.jobs, 'cc');
        const broken = stores({
            secrets: faultySecrets(testSecretStore(sql), {
                readActive: async () => {
                    throw new Error('secret backend unreachable');
                },
            }),
        });

        await expect(broken.jobs.claim('w1', LEASE_SECONDS)).rejects.toThrow();

        expect(await healthy.jobs.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
        // The failed claim defers the retry; once it lapses the task claims normally.
        await lapseDeferral(sql, id);
        expect((await healthy.jobs.claim('w2', LEASE_SECONDS))?.id).toBe(id);
    });

    it('stale forbidden and incompatible references refuse without ambient fallback', async () => {
        const { executors, connections, env, jobs } = stores();
        await env.replaceOrg('admin', [{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-ambient', isSecret: true }]);
        const bobs = await connect(connections, { userId: BOB });
        const openai = await connect(connections, { provider: 'openai' });
        const mine = await connect(connections);
        await executors.replace(ALICE, [
            { name: 'forbidden', type: 'claude-code', config: {}, providerConnectionId: mine.id },
            { name: 'incompatible', type: 'claude-code', config: {}, providerConnectionId: mine.id },
        ]);
        // Write what the stores would refuse, to prove the claim re-checks rather than trusting save.
        await sql`update executor_profile set provider_connection_id = ${bobs.id}
                  where org_id = ${ORG} and user_id = ${ALICE} and name = 'forbidden'`;
        await sql`update executor_profile set provider_connection_id = ${openai.id}
                  where org_id = ${ORG} and user_id = ${ALICE} and name = 'incompatible'`;
        await queue(jobs, 'forbidden');
        await queue(jobs, 'incompatible');

        const claims = [await jobs.claim('w1', LEASE_SECONDS), await jobs.claim('w2', LEASE_SECONDS)];

        for (const claim of claims) {
            expect(claim?.executorRefusal).toBeTruthy();
            expect(claim?.env).toBeUndefined();
        }
        expect(JSON.stringify(claims)).not.toContain('sk-ant-ambient');
        expect(JSON.stringify(claims)).not.toContain('sk-ant-connection-key');
    });

    it('frozen legacy agent tasks retain their original configuration', async () => {
        const { executors, connections, env, jobs } = stores();
        await env.replaceOrg('admin', [{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-ambient', isSecret: true }]);
        const conn = await connect(connections);
        await executors.replace(ALICE, [
            { name: 'cc', type: 'claude-code', config: {}, providerConnectionId: conn.id },
        ]);
        await mustCreate(
            jobs.create('echo hi', ALICE, { repo: null, executor: null, agentType: 'claude-code', agentModel: 'm-1' })
        );

        const claim = await jobs.claim('w1', LEASE_SECONDS);

        expect(claim?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-ambient');
        expect(JSON.parse(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? '{}')).toEqual({ model: 'm-1' });
    });

    it('an OpenRouter connection with a custom endpoint routes Claude Code to that endpoint, for every deployment mode', async () => {
        for (const mode of ['self-hosted', 'cloud'] as const) {
            const { executors, connections, jobs } = stores({ mode });
            const conn = await connect(connections, {
                provider: 'openrouter',
                key: 'sk-or-custom',
                baseUrl: 'https://gateway.example.test/api/v1',
            });
            const name = `or-${mode}`;
            await executors.replace(ALICE, [{ name, type: 'claude-code', config: {}, providerConnectionId: conn.id }]);
            await queue(jobs, name);

            const claim = await jobs.claim('w1', LEASE_SECONDS);

            expect(claim?.env, mode).toMatchObject({
                ANTHROPIC_BASE_URL: 'https://gateway.example.test/api',
                ANTHROPIC_AUTH_TOKEN: 'sk-or-custom',
                ANTHROPIC_API_KEY: '',
            });
            expect(JSON.stringify(claim?.env), mode).not.toContain(OPENROUTER_ANTHROPIC_BASE_URL);
        }
    });

    it('the claim refuses NO_MODEL for a cleared connection key beside an ambient key the connection replaced', async () => {
        const { executors, connections, env, jobs } = stores({ mode: 'cloud' });
        await env.replaceOrg('admin', [{ name: 'OPENROUTER_API_KEY', value: 'sk-or-ambient', isSecret: true }]);
        const conn = await connect(connections);
        await executors.replace(ALICE, [
            {
                name: 'cleared',
                type: 'claude-code',
                config: { env: { ANTHROPIC_API_KEY: '' } },
                providerConnectionId: conn.id,
            },
        ]);
        await queue(jobs, 'cleared');

        expect((await jobs.claim('w1', LEASE_SECONDS))?.executorRefusal).toBe(NO_MODEL_MESSAGE);
    });
});
