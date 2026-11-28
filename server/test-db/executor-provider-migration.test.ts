import { beforeAll, describe, expect, it } from 'vitest';
import type { SubscriptionTokenPolicy } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { mintCredentials, sealAll } from '../src/db/executor-credentials.js';
import { migrateExecutorProviders } from '../src/db/executor-provider-migration.js';
import { createProviderConnectionStore } from '../src/db/provider-connection-store.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { ExecutorConnectionRefusedError, MIGRATION_PENDING_MESSAGE } from '../src/db/executor-connection-selection.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { faultySecrets, seedEncryptedRow, spySecrets, testSecretStore } from './env-secrets-harness.js';
import { testConnection, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * Migration 175's data step (docs/persistence.md): every executor with no provider connection gets one holding its
 * key, or is suspended with the reason. Legacy rows cannot be inserted under the constraint, so a suite drops it for
 * the seeding transaction (DDL is transactional: no other suite ever sees it gone) and re-adds it NOT VALID.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const CONSTRAINT = 'executor_profile_provider_required_ck';
const MODELS_URL = 'https://models.example.test/v1';

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER], max: 6 });

let sql: Sql;
let healthy: SecretStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    healthy = testSecretStore(sql);
});

const secretDeps = () => ({
    sql,
    orgId: ORG,
    secrets: healthy,
    secretLog: () => {},
    writeDeadlineMs: 3000,
    cleanupDeadlineMs: 3000,
});

/** A config with its credentials sealed into the secret store, as a saved profile held them before this step. */
async function sealedConfig(config: Record<string, unknown>) {
    const minted = await mintCredentials(secretDeps(), [config]);
    return sealAll([config], minted, []).sealed[0]!;
}

interface Seed {
    name: string;
    type: 'claude-code' | 'opencode';
    owner: string | null;
    config: Record<string, unknown>;
    secretRefs?: unknown[];
}

/** Rows the migration marked pending: the validated check admits them, as it admitted every row 175 found. */
async function seedLegacy(seeds: readonly Seed[]): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    for (const [position, seed] of seeds.entries()) {
        const [row] = await sql<{ id: string }[]>`
            insert into executor_profile
                (org_id, user_id, name, type, config, secret_refs, position, provider_migration_pending)
            values (${ORG}, ${seed.owner}, ${seed.name}, ${seed.type}, ${sql.json(seed.config as never)},
                ${sql.json((seed.secretRefs ?? []) as never)}, ${position}, true)
            returning id
        `;
        ids[seed.name] = row!.id;
    }
    return ids;
}

const orgVar = (name: string, value: string) =>
    seedEncryptedRow(sql, healthy, { orgId: ORG, scope: { kind: 'org' }, name }, value);

/** The seven legacy shapes the plan names, plus the two vars their scopes hold. */
async function seedScenario() {
    const personal = await sealedConfig({ env: { ANTHROPIC_API_KEY: 'sk-ant-personal' } });
    const shared = await sealedConfig({ env: { ANTHROPIC_API_KEY: 'sk-ant-shared' } });
    await orgVar('ANTHROPIC_KEY', 'sk-ant-from-env');
    await orgVar('OPENROUTER_API_KEY', 'sk-or-from-env');
    await orgVar('CUSTOM_KEY', 'sk-custom-from-env');
    await seedEncryptedRow(
        sql,
        healthy,
        { orgId: ORG, scope: { kind: 'workspace', userId: ALICE }, name: 'ANTHROPIC_API_KEY' },
        'sk-ant-alice'
    );
    return seedLegacy([
        {
            name: 'personal-stored',
            type: 'claude-code',
            owner: ALICE,
            config: personal.config,
            secretRefs: personal.secretRefs,
        },
        {
            name: 'org-env',
            type: 'opencode',
            owner: null,
            config: {
                model: 'anthropic/claude-sonnet-4-5',
                provider: {
                    anthropic: { options: { apiKey: '{env:ANTHROPIC_KEY}', baseURL: 'https://proxy.example.test/v1' } },
                },
            },
        },
        { name: 'shared-a', type: 'claude-code', owner: null, config: shared.config, secretRefs: shared.secretRefs },
        { name: 'shared-b', type: 'claude-code', owner: null, config: shared.config, secretRefs: shared.secretRefs },
        {
            name: 'unresolvable',
            type: 'opencode',
            owner: null,
            config: {
                model: 'anthropic/claude-sonnet-4-5',
                provider: { anthropic: { options: { apiKey: '{env:MISSING}' } } },
            },
        },
        { name: 'empty-org', type: 'claude-code', owner: null, config: {} },
        { name: 'ambiguous', type: 'claude-code', owner: ALICE, config: { model: 'sonnet' } },
        {
            name: 'custom',
            type: 'opencode',
            owner: null,
            config: {
                model: 'gateway/m1',
                provider: {
                    gateway: {
                        npm: '@ai-sdk/openai-compatible',
                        options: { baseURL: MODELS_URL, apiKey: '{env:CUSTOM_KEY}' },
                        models: { m1: { name: 'm1' } },
                    },
                },
            },
        },
    ]);
}

interface Row {
    id: string;
    name: string;
    config: Record<string, unknown>;
    secret_refs: unknown[];
    suspended: boolean;
    provider_connection_id: string | null;
    provider_migration_reason: string | null;
    provider_migration_pending: boolean;
}

const rows = async () =>
    Object.fromEntries(
        (
            await sql<Row[]>`
                select id, name, config, secret_refs, suspended, provider_connection_id, provider_migration_reason,
                    provider_migration_pending
                from executor_profile where org_id = ${ORG}
            `
        ).map((row) => [row.name, row])
    );

const connectionOf = async (row: Row) => {
    const [connection] = await sql<
        { id: string; name: string; provider: string; user_id: string | null; base_url: string | null }[]
    >`
        select id, name, provider, user_id, base_url from provider_connection
        where org_id = ${ORG} and id = ${row.provider_connection_id}
    `;
    return connection!;
};

const keyOf = async (row: Row) =>
    (
        await createProviderConnectionStore({ sql, orgId: ORG, secrets: healthy, secretLog: () => {} }).credentialFor(
            ALICE,
            row.provider_connection_id!
        )
    )?.key;

const SELF_HOSTED_POLICY = { deploymentMode: 'self-hosted', cloudSubscriptionOrgIds: new Set<string>() } as const;

const run = (secrets: SecretStore = healthy, subscriptionPolicy: SubscriptionTokenPolicy = SELF_HOSTED_POLICY) =>
    migrateExecutorProviders({ sql, secrets, secretLog: () => {}, subscriptionPolicy });

const pendingCount = async () =>
    (await sql<{ n: number }[]>`select count(*)::int as n from executor_profile where provider_migration_pending`)[0]!
        .n;

describe.skipIf(!enabled)('the executor provider migration step', () => {
    it('gives each executor a connection of its provider in its scope, holding its key, with the key off the config', async () => {
        await seedScenario();
        await run();
        const after = await rows();

        const personal = after['personal-stored']!;
        expect(await connectionOf(personal)).toMatchObject({
            provider: 'anthropic',
            user_id: ALICE,
            name: 'Anthropic',
        });
        expect(await keyOf(personal)).toBe('sk-ant-personal');
        expect(personal.config).toEqual({});
        expect(personal.secret_refs).toEqual([]);

        const orgEnv = after['org-env']!;
        expect(await connectionOf(orgEnv)).toMatchObject({
            provider: 'anthropic',
            user_id: null,
            name: 'Anthropic',
            base_url: 'https://proxy.example.test/v1',
        });
        expect(await keyOf(orgEnv)).toBe('sk-ant-from-env');
        expect(orgEnv.config).toEqual({ model: 'anthropic/claude-sonnet-4-5' });

        const empty = after['empty-org']!;
        expect(await connectionOf(empty)).toMatchObject({ provider: 'openrouter', user_id: null, name: 'OpenRouter' });
        expect(await keyOf(empty)).toBe('sk-or-from-env');

        const custom = after.custom!;
        expect(await connectionOf(custom)).toMatchObject({ provider: 'openai-compatible', base_url: MODELS_URL });
        expect(await keyOf(custom)).toBe('sk-custom-from-env');
        // Only the key and the endpoint leave the config; the rest of the block stays.
        expect(custom.config).toEqual({
            model: 'custom/m1',
            provider: { gateway: { npm: '@ai-sdk/openai-compatible', models: { m1: { name: 'm1' } } } },
        });
    });

    it('shares one connection between executors holding the same stored key, named with a dedup suffix', async () => {
        await seedScenario();
        await run();
        const after = await rows();
        expect(after['shared-a']!.provider_connection_id).not.toBeNull();
        expect(after['shared-a']!.provider_connection_id).toBe(after['shared-b']!.provider_connection_id);
        expect(await connectionOf(after['shared-a']!)).toMatchObject({ name: 'Anthropic 2', provider: 'anthropic' });
        expect(await keyOf(after['shared-a']!)).toBe('sk-ant-shared');
        expect(after['shared-a']!.config).toEqual({});
    });

    it('suspends what it cannot determine, with the reason, and deletes nothing', async () => {
        await seedScenario();
        const before = await rows();
        await run();
        const after = await rows();
        expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());

        const missing = after.unresolvable!;
        expect(missing).toMatchObject({ suspended: true, provider_connection_id: null });
        expect(missing.provider_migration_reason).toContain('MISSING');
        expect(missing.config).toEqual(before.unresolvable!.config);

        const ambiguous = after.ambiguous!;
        expect(ambiguous).toMatchObject({ suspended: true, provider_connection_id: null });
        expect(ambiguous.provider_migration_reason).toContain('ANTHROPIC_API_KEY');
        expect(ambiguous.provider_migration_reason).toContain('OPENROUTER_API_KEY');
        expect(ambiguous.config).toEqual({ model: 'sonnet' });
    });

    it('leaves nothing pending, and a second run changes nothing', async () => {
        await seedScenario();
        const first = await run();
        expect(first).toMatchObject({ converted: 6, suspended: 2, inconclusive: 0, remaining: 0 });
        expect(await pendingCount()).toBe(0);

        const snapshot = {
            rows: await rows(),
            connections:
                await sql`select id, name, secret_ref from provider_connection where org_id = ${ORG} order by id`,
        };
        expect(await run()).toMatchObject({ converted: 0, suspended: 0, inconclusive: 0, remaining: 0 });
        expect({
            rows: await rows(),
            connections:
                await sql`select id, name, secret_ref from provider_connection where org_id = ${ORG} order by id`,
        }).toEqual(snapshot);
    });

    it('keeps the check validated: a new row with no connection and no reason is refused', async () => {
        expect(
            (
                await sql<
                    { convalidated: boolean }[]
                >`select convalidated from pg_constraint where conname = ${CONSTRAINT}`
            )[0]?.convalidated
        ).toBe(true);
        await expect(
            sql`insert into executor_profile (org_id, user_id, name, type, config, position)
                values (${ORG}, null, 'bare', 'claude-code', '{}'::jsonb, 0)`
        ).rejects.toMatchObject({ code: '23514' });
        // A reason alone is not enough: only a suspended row may keep a null connection.
        await expect(
            sql`insert into executor_profile (org_id, user_id, name, type, config, position, provider_migration_reason)
                values (${ORG}, null, 'live', 'claude-code', '{}'::jsonb, 0, 'because')`
        ).rejects.toMatchObject({ code: '23514' });
    });

    it('leaves an executor whose secret read failed legacy, and converts it on a later run', async () => {
        await seedScenario();
        const down = faultySecrets(healthy, { readActive: () => Promise.reject(new Error('store down')) });
        const first = await run(down);
        expect(first.inconclusive).toBeGreaterThan(0);
        const during = await rows();
        // The stored-key and env-key executors could not be read: untouched, not suspended, not guessed.
        for (const name of ['personal-stored', 'org-env', 'shared-a', 'shared-b', 'custom', 'empty-org']) {
            expect(during[name], name).toMatchObject({
                provider_connection_id: null,
                provider_migration_reason: null,
                provider_migration_pending: true,
                suspended: false,
            });
        }
        expect(await pendingCount()).toBeGreaterThan(0);

        await run();
        const after = await rows();
        for (const name of ['personal-stored', 'org-env', 'shared-a', 'shared-b', 'custom', 'empty-org']) {
            expect(after[name]!.provider_connection_id, name).not.toBeNull();
        }
        expect(await pendingCount()).toBe(0);
    });
});

const reasonOf = async (name: string) => (await rows())[name]!.provider_migration_reason;

describe.skipIf(!enabled)('the executor provider migration step: what is confirmed bad is suspended', () => {
    it('suspends a stored key with no record, and a config that is not an object, and converges', async () => {
        await seedLegacy([
            {
                name: 'no-record',
                type: 'claude-code',
                owner: null,
                config: { env: { ANTHROPIC_API_KEY: 'stored-credential:missing-ref' } },
            },
            { name: 'not-an-object', type: 'claude-code', owner: null, config: 'text' as never },
        ]);
        expect(await run()).toMatchObject({ suspended: 2, inconclusive: 0, remaining: 0 });
        expect(await reasonOf('no-record')).toContain('no record');
        expect(await reasonOf('not-an-object')).toContain('not a JSON object');
    });

    it('suspends an endpoint or key the routes would refuse, and never stores credentials in the base URL', async () => {
        await orgVar('ANTHROPIC_KEY', 'sk-ant-from-env');
        const block = (baseURL: string) => ({
            model: 'anthropic/claude-sonnet-4-5',
            provider: { anthropic: { options: { apiKey: '{env:ANTHROPIC_KEY}', baseURL } } },
        });
        await seedLegacy([
            {
                name: 'long-base',
                type: 'opencode',
                owner: null,
                config: block(`https://models.example.test/${'a'.repeat(2100)}`),
            },
            {
                name: 'user-info',
                type: 'opencode',
                owner: null,
                config: block('https://user:hunter2@models.example.test/v1'),
            },
            {
                name: 'padded-key',
                type: 'claude-code',
                owner: null,
                config: { env: { ANTHROPIC_API_KEY: 'sk-ant-key\n' } },
            },
        ]);
        await run();
        for (const name of ['long-base', 'user-info']) expect(await reasonOf(name), name).toContain('http(s) URL');
        expect(await reasonOf('user-info')).not.toContain('hunter2');
        expect(await reasonOf('padded-key')).toContain('valid provider key');
        expect(await sql`select 1 from provider_connection where org_id = ${ORG}`).toHaveLength(0);
    });

    it('resolves an {env:NAME} endpoint through the scope like the key', async () => {
        await orgVar('ANTHROPIC_KEY', 'sk-ant-from-env');
        await sql`insert into env_var (org_id, name, value, is_secret) values (${ORG}, 'PROXY_URL', 'https://proxy.example.test/v1', false)`;
        await seedLegacy([
            {
                name: 'env-base',
                type: 'opencode',
                owner: null,
                config: {
                    model: 'anthropic/claude-sonnet-4-5',
                    provider: { anthropic: { options: { apiKey: '{env:ANTHROPIC_KEY}', baseURL: '{env:PROXY_URL}' } } },
                },
            },
        ]);
        await run();
        const row = (await rows())['env-base']!;
        expect(await connectionOf(row)).toMatchObject({ base_url: 'https://proxy.example.test/v1' });
    });

    it('creates a subscription connection only where the organization may hold one', async () => {
        const seed = {
            type: 'claude-code',
            owner: null,
            config: { env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value' } },
        } as const;
        await seedLegacy([{ ...seed, name: 'sub' }]);
        const cloud: SubscriptionTokenPolicy = { deploymentMode: 'cloud', cloudSubscriptionOrgIds: new Set() };
        await run(healthy, cloud);
        expect(await reasonOf('sub')).toContain('subscription');
        await sql`delete from executor_profile where org_id = ${ORG}`;
        await seedLegacy([{ ...seed, name: 'sub' }]);
        await run(healthy, { deploymentMode: 'cloud', cloudSubscriptionOrgIds: new Set([ORG]) });
        expect(await connectionOf((await rows()).sub!)).toMatchObject({ provider: 'subscription' });
    });

    it('treats a secret store timeout as inconclusive and converts on a later run', async () => {
        await orgVar('OPENROUTER_API_KEY', 'sk-or-from-env');
        await seedLegacy([{ name: 'empty-org', type: 'claude-code', owner: null, config: {} }]);
        const slow = faultySecrets(healthy, {
            readActive: () =>
                Promise.resolve({ ok: false, error: { code: 'unavailable', reason: 'provider-timeout' } }),
        });
        expect(await run(slow)).toMatchObject({ converted: 0, suspended: 0, inconclusive: 1, remaining: 1 });
        expect(await reasonOf('empty-org')).toBeNull();
        expect(await run()).toMatchObject({ converted: 1, remaining: 0 });
    });

    it('converts a personal executor from an org variable into a personal connection holding a copy', async () => {
        await orgVar('OPENROUTER_API_KEY', 'sk-or-from-org');
        await seedLegacy([{ name: 'mine', type: 'claude-code', owner: ALICE, config: {} }]);
        await run();
        const row = (await rows()).mine!;
        expect(await connectionOf(row)).toMatchObject({ provider: 'openrouter', user_id: ALICE });
        expect(await keyOf(row)).toBe('sk-or-from-org');
    });
});

describe.skipIf(!enabled)('the executor provider migration step: the old stored key is retired last', () => {
    const marker = { env: { ANTHROPIC_API_KEY: 'sk-ant-shared' } };

    it('retires the shared marker once, after the last sharer converted', async () => {
        const shared = await sealedConfig(marker);
        await seedLegacy(
            ['a', 'b'].map((name) => ({
                name,
                type: 'claude-code',
                owner: null,
                config: shared.config,
                secretRefs: shared.secretRefs,
            }))
        );
        const spy = spySecrets(healthy);
        await run(spy.store);
        const old = shared.secretRefs[0]!.ref;
        expect(spy.calls.deletes.filter((call) => call.ref === old)).toHaveLength(1);
    });

    it('keeps the marker while a sharer is left unconverted', async () => {
        const shared = await sealedConfig(marker);
        await seedLegacy([
            { name: 'a', type: 'claude-code', owner: null, config: shared.config, secretRefs: shared.secretRefs },
            {
                name: 'b',
                type: 'claude-code',
                owner: null,
                config: { env: { ...(shared.config.env as object), OTHER_API_KEY: 'x' } },
                secretRefs: shared.secretRefs,
            },
        ]);
        const spy = spySecrets(healthy);
        await run(spy.store);
        expect((await rows()).a!.provider_connection_id).not.toBeNull();
        expect(await reasonOf('b')).toContain('OTHER_API_KEY');
        expect(spy.calls.deletes.filter((call) => call.ref === shared.secretRefs[0]!.ref)).toHaveLength(0);
    });
});

describe.skipIf(!enabled)('rows the step has not reached, and rows it suspended, stay writable', () => {
    const stores = () => {
        const deps = { sql, orgId: ORG, secrets: healthy, secretLog: () => {} };
        return createUserExecutorStore(deps);
    };

    it('survives the deletion of the creating member: a pending row still satisfies the check', async () => {
        const [creator] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login) values (${Math.floor(Math.random() * 1e9)}, ${`gone-${Date.now()}`})
            returning id
        `;
        await seedLegacy([{ name: 'made', type: 'claude-code', owner: null, config: {} }]);
        await sql`update executor_profile set created_by = ${creator!.id} where org_id = ${ORG} and name = 'made'`;
        await sql`delete from app_user where id = ${creator!.id}`;
        expect((await rows()).made).toMatchObject({ provider_migration_pending: true, provider_connection_id: null });
    });

    it('answers a suspend, a resume or an edit without a connection on a pending row with the pending message', async () => {
        const ids = await seedLegacy([{ name: 'pending', type: 'claude-code', owner: null, config: {} }]);
        const store = stores();
        const refused = { name: 'ExecutorConnectionRefusedError', message: MIGRATION_PENDING_MESSAGE };
        await expect(store.setOrgSuspended(ids.pending!, true)).rejects.toMatchObject(refused);
        await expect(store.setOrgSuspended(ids.pending!, false)).rejects.toMatchObject(refused);
        await expect(store.updateOrg(ids.pending!, { gateFixRounds: 2 })).rejects.toMatchObject(refused);
    });

    it('carries a pending personal row back unchanged, and names the pending migration when it is changed', async () => {
        const ids = await seedLegacy([
            { name: 'waiting', type: 'claude-code', owner: ALICE, config: { model: 'sonnet' } },
        ]);
        const connection = await testConnection(sql, ORG);
        const store = stores();
        const carried = {
            id: ids.waiting!,
            name: 'waiting',
            type: 'claude-code',
            config: { model: 'sonnet' },
            providerConnectionId: null,
        };
        await store.replace(ALICE, [
            carried,
            { name: 'fresh', type: 'claude-code', config: {}, providerConnectionId: connection },
        ]);
        expect((await rows()).waiting).toMatchObject({
            provider_migration_pending: true,
            provider_connection_id: null,
            suspended: false,
        });
        await expect(store.replace(ALICE, [{ ...carried, config: { model: 'opus' } }])).rejects.toMatchObject({
            message: MIGRATION_PENDING_MESSAGE,
        });
    });

    it('clears the reason and the pending flag when an edit selects a connection', async () => {
        const ids = await seedLegacy([
            { name: 'stuck', type: 'claude-code', owner: null, config: { model: 'sonnet' } },
        ]);
        await run();
        expect((await rows()).stuck).toMatchObject({ suspended: true, provider_connection_id: null });
        const connection = await testConnection(sql, ORG);
        const updated = await stores().updateOrg(ids.stuck!, { providerConnectionId: connection });
        expect(updated).toMatchObject({ providerConnectionId: connection, suspendedReason: null });
        expect((await rows()).stuck).toMatchObject({
            provider_migration_reason: null,
            provider_migration_pending: false,
        });
    });

    it('lets a personal list save carry a migration-suspended row back unchanged while others change', async () => {
        const ids = await seedLegacy([
            { name: 'stuck', type: 'claude-code', owner: ALICE, config: { model: 'sonnet' } },
        ]);
        await run();
        const connection = await testConnection(sql, ORG);
        const store = stores();
        const [stuck] = await store.listWithConfigs(ALICE);
        const carried = {
            id: ids.stuck!,
            name: 'stuck',
            type: 'claude-code',
            config: stuck!.config,
            providerConnectionId: null,
        };
        await store.replace(ALICE, [
            carried,
            { name: 'fresh', type: 'claude-code', config: {}, providerConnectionId: connection },
        ]);
        expect((await rows()).stuck).toMatchObject({ suspended: true, provider_connection_id: null });
        expect((await rows()).stuck!.provider_migration_reason).not.toBeNull();
        expect((await rows()).fresh!.provider_connection_id).toBe(connection);
        // Edited, or resumed, or sent without its id, it is not the carried-back row any more.
        for (const refused of [
            { ...carried, config: { model: 'opus' } },
            { ...carried, suspended: false },
            { name: 'stuck', type: 'claude-code', config: stuck!.config, providerConnectionId: null },
        ]) {
            await expect(store.replace(ALICE, [refused])).rejects.toBeInstanceOf(ExecutorConnectionRefusedError);
        }
    });
});

/** A store whose reads answer `code` for the secrets `match` selects, and the real answer for the rest. */
const failing = (code: string, reason: string, match: (purpose: string) => boolean = () => true): SecretStore =>
    faultySecrets(healthy, {
        readActive: (input) =>
            match(input.identity.purpose)
                ? Promise.resolve({ ok: false, error: { code, reason } } as never)
                : healthy.readActive(input),
    });

describe.skipIf(!enabled)('the executor provider migration step: secret store answers by class', () => {
    const emptyOrg = () => seedLegacy([{ name: 'empty-org', type: 'claude-code', owner: null, config: {} }]);

    it.each([
        ['unavailable', 'provider-unavailable'],
        ['outcome-unknown', 'provider-timeout'],
        ['invalid-configuration', 'configuration-invalid'],
    ])('retries on %s: the row stays pending', async (code, reason) => {
        await orgVar('OPENROUTER_API_KEY', 'sk-or-from-env');
        await emptyOrg();
        expect(await run(failing(code, reason))).toMatchObject({ inconclusive: 1, remaining: 1, suspended: 0 });
        expect((await rows())['empty-org']).toMatchObject({ provider_migration_pending: true });
    });

    it.each([
        ['not-found', 'reference-not-found'],
        ['identity-mismatch', 'identity-mismatch'],
        ['integrity-failure', 'integrity-check-failed'],
    ])('suspends on %s: a confirmed answer about that secret', async (code, reason) => {
        await orgVar('OPENROUTER_API_KEY', 'sk-or-from-env');
        await emptyOrg();
        expect(await run(failing(code, reason))).toMatchObject({ suspended: 1, inconclusive: 0, remaining: 0 });
        expect(await reasonOf('empty-org')).toContain(code);
    });

    it('skips a candidate connection whose secret is confirmed bad, and converts with a fresh one', async () => {
        await orgVar('ANTHROPIC_API_KEY', 'sk-ant-from-env');
        await testConnection(sql, ORG, { key: 'sk-ant-other' });
        await emptyOrg();
        const result = await run(
            failing('not-found', 'reference-not-found', (purpose) => purpose === 'provider-credential')
        );
        expect(result).toMatchObject({ converted: 1, inconclusive: 0 });
        expect(await sql`select 1 from provider_connection where org_id = ${ORG}`).toHaveLength(2);
    });
});

describe.skipIf(!enabled)('the executor provider migration step: the endpoint column is never a secret', () => {
    it('suspends an endpoint kept as a secret variable, through {env:} or the scope, instead of copying it', async () => {
        await orgVar('ANTHROPIC_KEY', 'sk-ant-from-env');
        await orgVar('PROXY_URL', 'https://secret-proxy.example.test/v1');
        await orgVar('ANTHROPIC_API_KEY', 'sk-ant-scope');
        await orgVar('ANTHROPIC_BASE_URL', 'https://secret-host.example.test/v1');
        await seedLegacy([
            {
                name: 'through-env',
                type: 'opencode',
                owner: null,
                config: {
                    model: 'anthropic/claude-sonnet-4-5',
                    provider: { anthropic: { options: { apiKey: '{env:ANTHROPIC_KEY}', baseURL: '{env:PROXY_URL}' } } },
                },
            },
            { name: 'through-scope', type: 'claude-code', owner: null, config: {} },
        ]);
        await run();
        for (const name of ['through-env', 'through-scope']) {
            expect(await reasonOf(name), name).toContain('secret variable');
        }
        expect(await sql`select 1 from provider_connection where org_id = ${ORG}`).toHaveLength(0);
    });

    it('reads an empty plain endpoint variable as the provider default', async () => {
        await orgVar('ANTHROPIC_API_KEY', 'sk-ant-scope');
        await sql`insert into env_var (org_id, name, value, is_secret) values (${ORG}, 'ANTHROPIC_BASE_URL', '', false)`;
        await seedLegacy([{ name: 'plain-default', type: 'claude-code', owner: null, config: {} }]);
        await run();
        expect(await connectionOf((await rows())['plain-default']!)).toMatchObject({
            provider: 'anthropic',
            base_url: null,
        });
    });
});

describe.skipIf(!enabled)('the executor provider migration step: races and stale snapshots', () => {
    const emptyOrg = () => seedLegacy([{ name: 'empty-org', type: 'claude-code', owner: null, config: {} }]);

    it('skips a row whose type changed during the pass, and converts it on the next with a plan for the new type', async () => {
        await orgVar('ANTHROPIC_API_KEY', 'sk-ant-from-env');
        await emptyOrg();
        const changing = faultySecrets(healthy, {
            readActive: async (input) => {
                await sql`update executor_profile set type = 'opencode' where org_id = ${ORG} and name = 'empty-org'`;
                return healthy.readActive(input);
            },
        });
        expect(await run(changing)).toMatchObject({ converted: 0, suspended: 0, remaining: 1 });
        expect((await rows())['empty-org']).toMatchObject({
            provider_migration_pending: true,
            provider_connection_id: null,
        });
        expect(await run()).toMatchObject({ converted: 1, remaining: 0 });
    });

    it.each([
        ['23503', 'pending'],
        ['23505', 'pending'],
        ['23514', 'suspended'],
    ])('on a %s violation storing the connection the row is left %s', async (code, outcome) => {
        await orgVar('ANTHROPIC_API_KEY', 'sk-ant-from-env');
        await emptyOrg();
        await sql.unsafe(`
            create or replace function test_refuse_connection() returns trigger language plpgsql as $$
            begin raise exception 'refused' using errcode = '${code}', constraint = 'provider_connection_internal_ck'; end $$;
            create trigger test_refuse_connection before insert on provider_connection
                for each row execute function test_refuse_connection();
        `);
        try {
            await run();
        } finally {
            await sql.unsafe(
                'drop trigger test_refuse_connection on provider_connection; drop function test_refuse_connection()'
            );
        }
        const row = (await rows())['empty-org']!;
        if (outcome === 'pending') {
            expect(row).toMatchObject({ provider_migration_pending: true, provider_migration_reason: null });
        } else {
            expect(row).toMatchObject({ provider_migration_pending: false, suspended: true });
            expect(row.provider_migration_reason).not.toContain('provider_connection_internal_ck');
            expect(row.provider_migration_reason).not.toMatch(/_ck|_fk|_uk/);
        }
    });

    it('reads {env:NAME} of a plain variable set to the empty string as the default endpoint', async () => {
        await orgVar('ANTHROPIC_KEY', 'sk-ant-from-env');
        await sql`insert into env_var (org_id, name, value, is_secret) values (${ORG}, 'PROXY', '', false)`;
        await seedLegacy([
            {
                name: 'blank-proxy',
                type: 'opencode',
                owner: null,
                config: {
                    model: 'anthropic/claude-sonnet-4-5',
                    provider: { anthropic: { options: { apiKey: '{env:ANTHROPIC_KEY}', baseURL: '{env:PROXY}' } } },
                },
            },
        ]);
        await run();
        expect(await connectionOf((await rows())['blank-proxy']!)).toMatchObject({
            provider: 'anthropic',
            base_url: null,
        });
    });

    it('treats a secret variable rotated or deleted during the pass as a stale read, not a bad secret', async () => {
        await orgVar('ANTHROPIC_API_KEY', 'sk-ant-from-env');
        await emptyOrg();
        const rotating = faultySecrets(healthy, {
            readActive: async () => {
                await sql`delete from env_var where org_id = ${ORG} and name = 'ANTHROPIC_API_KEY'`;
                return { ok: false, error: { code: 'not-found', reason: 'reference-not-found' } } as never;
            },
        });
        expect(await run(rotating)).toMatchObject({ suspended: 0, inconclusive: 1, remaining: 1 });
        expect(await reasonOf('empty-org')).toBeNull();
    });
});
