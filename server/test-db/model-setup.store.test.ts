import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createUserExecutorStore, type UserExecutorStore } from '../src/db/user-executor-store.js';
import { type KeySave, saveModelKey } from '../src/routes/model-setup-save.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { faultySecrets, spySecrets, testSecretStore } from './env-secrets-harness.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The model setup's save against Postgres: the key and the agent default land in one transaction, so a failure on
 * either side leaves neither, and a secret the failed write created is released exactly once.
 */
const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER] });

let sql: Sql;
let healthy: SecretStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    healthy = testSecretStore(sql);
});

const SAVE: KeySave = {
    scope: 'personal',
    userId: ALICE,
    provider: 'anthropic',
    key: 'sk-ant-store-test',
    agentType: 'claude-code',
    model: 'claude-sonnet-4-5',
};

const storesOver = (secrets: SecretStore, executors?: (store: UserExecutorStore) => UserExecutorStore) => {
    const envVars = createEnvVarStore({ sql, orgId: ORG, secrets, secretLog: () => {} });
    const real = createUserExecutorStore({ sql, orgId: ORG, secrets, secretLog: () => {} });
    return { envVars, executors: executors ? executors(real) : real, deploymentMode: 'self-hosted' as const };
};

const envNames = async () =>
    (await sql<{ name: string }[]>`select name from env_var where org_id = ${ORG} order by name`).map((r) => r.name);
const agentRows = () => sql`select user_id, agent_type, model, provider from agent_default where org_id = ${ORG}`;

describe.skipIf(!enabled)('saveModelKey', () => {
    it('writes the key and the agent default together, the provider recorded', async () => {
        await saveModelKey(storesOver(healthy), SAVE);
        expect(await envNames()).toEqual(['ANTHROPIC_API_KEY']);
        expect(await agentRows()).toEqual([
            { user_id: ALICE, agent_type: 'claude-code', model: 'claude-sonnet-4-5', provider: 'anthropic' },
        ]);
    });

    it('a failing secret backend leaves the agent default unwritten', async () => {
        const failing = faultySecrets(healthy, {
            create: async () => ({ ok: false, error: { code: 'unavailable', reason: 'provider-unavailable' } }),
        });
        await expect(saveModelKey(storesOver(failing), SAVE)).rejects.toThrow();
        expect(await envNames()).toEqual([]);
        expect(await agentRows()).toEqual([]);
    });

    it('a failing agent-default write rolls the env rows back and releases the created secret once', async () => {
        const spy = spySecrets(healthy);
        const stores = storesOver(spy.store, (real) => ({
            ...real,
            setAgentDefaultInTx: async () => {
                throw new Error('agent default write failed');
            },
        }));

        await expect(saveModelKey(stores, SAVE)).rejects.toThrow('agent default write failed');

        const created = spy.calls.creates.at(-1);
        expect(created).toBeDefined();
        expect(spy.calls.deletes.filter((d) => d.ref === created?.ref)).toHaveLength(1);
        expect(await envNames()).toEqual([]);
        expect(await agentRows()).toEqual([]);
    });

    it('a provider switch removes the recorded provider’s names inside the write', async () => {
        await saveModelKey(storesOver(healthy), { ...SAVE, provider: 'litellm', baseUrl: 'https://llm.example.test' });
        expect(await envNames()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

        await saveModelKey(storesOver(healthy), {
            ...SAVE,
            provider: 'openrouter',
            key: 'sk-or-store-test',
            agentType: 'opencode',
            model: 'openai/gpt-5',
        });

        expect(await envNames()).toEqual(['OPENROUTER_API_KEY']);
        expect(await agentRows()).toEqual([
            { user_id: ALICE, agent_type: 'opencode', model: 'openrouter/openai/gpt-5', provider: 'openrouter' },
        ]);
    });
});
