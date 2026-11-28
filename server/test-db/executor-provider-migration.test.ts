import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { mintCredentials, sealAll } from '../src/db/executor-credentials.js';
import { migrateExecutorProviders } from '../src/db/executor-provider-migration.js';
import { createProviderConnectionStore } from '../src/db/provider-connection-store.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { faultySecrets, seedEncryptedRow, testSecretStore } from './env-secrets-harness.js';
import { testOrg, testUser } from './fixtures.js';
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

async function seedLegacy(seeds: readonly Seed[]): Promise<Record<string, string>> {
    const ids: Record<string, string> = {};
    await sql.begin(async (tx) => {
        await tx.unsafe(`alter table executor_profile drop constraint ${CONSTRAINT}`);
        for (const [position, seed] of seeds.entries()) {
            const [row] = await tx<{ id: string }[]>`
                insert into executor_profile (org_id, user_id, name, type, config, secret_refs, position)
                values (${ORG}, ${seed.owner}, ${seed.name}, ${seed.type}, ${tx.json(seed.config as never)},
                    ${tx.json((seed.secretRefs ?? []) as never)}, ${position})
                returning id
            `;
            ids[seed.name] = row!.id;
        }
        await tx.unsafe(
            `alter table executor_profile add constraint ${CONSTRAINT}
             check (provider_connection_id is not null or provider_migration_reason is not null) not valid`
        );
    });
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
}

const rows = async () =>
    Object.fromEntries(
        (
            await sql<Row[]>`
                select id, name, config, secret_refs, suspended, provider_connection_id, provider_migration_reason
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

const validated = async () =>
    (
        await sql<
            { convalidated: boolean }[]
        >`select convalidated from pg_constraint where conname = ${CONSTRAINT} and conrelid = 'executor_profile'::regclass`
    )[0]?.convalidated;

const run = (secrets: SecretStore = healthy) => migrateExecutorProviders({ sql, secrets, secretLog: () => {} });

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
        expect(custom.config).toEqual({ model: 'custom/m1' });
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

    it('leaves no legacy row, validates the constraint, and a second run changes nothing', async () => {
        await seedScenario();
        expect(await validated()).toBe(false);
        const first = await run();
        expect(first).toMatchObject({ converted: 6, suspended: 2, inconclusive: 0 });
        expect(await validated()).toBe(true);
        const [{ n }] = await sql<{ n: number }[]>`
            select count(*)::int as n from executor_profile
            where provider_connection_id is null and provider_migration_reason is null
        `;
        expect(n).toBe(0);

        const snapshot = {
            rows: await rows(),
            connections:
                await sql`select id, name, secret_ref from provider_connection where org_id = ${ORG} order by id`,
        };
        expect(await run()).toMatchObject({ converted: 0, suspended: 0, inconclusive: 0 });
        expect({
            rows: await rows(),
            connections:
                await sql`select id, name, secret_ref from provider_connection where org_id = ${ORG} order by id`,
        }).toEqual(snapshot);
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
                suspended: false,
            });
        }
        expect(await validated()).toBe(false);

        await run();
        const after = await rows();
        for (const name of ['personal-stored', 'org-env', 'shared-a', 'shared-b', 'custom', 'empty-org']) {
            expect(after[name]!.provider_connection_id, name).not.toBeNull();
        }
        expect(await validated()).toBe(true);
    });
});
