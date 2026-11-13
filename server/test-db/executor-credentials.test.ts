import { STORED_CREDENTIAL_PREFIX } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { executorCredentialIdentity, type StoredCredential } from '../src/db/executor-credentials.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import type { SecretRef, SecretStore } from '../src/secrets/secret-store.js';
import { faultySecrets, testSecretStore } from './env-secrets-harness.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * Provider keys in executor settings live in the secret store: the row keeps
 * `stored-credential:<ref>` where the value was and `secret_refs` holds each reference, so no read of the
 * settings — the edit dialog's, the admin list's, the raw row — carries a key. Sending the marker back keeps
 * the value; a changed value replaces it and the old record is deleted; a row saved before the store held
 * keys is converted before the first read.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const KEY = 'sk-ant-api03-member-owned-key';
const OTHER = 'sk-ant-api03-rotated-key';
const ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER, BOB_USER] });

let sql: Sql;
let secrets: SecretStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    secrets = testSecretStore(sql);
});

const store = (with_: SecretStore = secrets) =>
    createUserExecutorStore({ sql, orgId: ORG, secrets: with_, secretLog: () => {} });

const rawRows = () => sql<{ name: string; config: unknown; secret_refs: StoredCredential[] }[]>`
    select name, config, secret_refs from executor_profile where org_id = ${ORG} order by name
`;

const markerAt = (config: unknown, ...path: string[]) =>
    path.reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], config) as string;

const recordExists = async (stored: StoredCredential) => {
    const answer = await secrets.readActive({
        identity: executorCredentialIdentity(ORG, stored.path),
        ref: stored.ref as SecretRef,
    });
    return answer.ok;
};

describe.skipIf(!enabled)('executor settings never read back a provider key', () => {
    it('the personal and admin reads and the raw row hold a marker; the claim read resolves the key', async () => {
        const executors = store();
        const opencode = { provider: { anthropic: { options: { apiKey: KEY, baseURL: 'https://a.example.test' } } } };
        await executors.replace(ALICE, [
            { name: 'claude', type: 'claude-code', config: { model: 'sonnet', env: { ANTHROPIC_API_KEY: KEY } } },
            { name: 'open', type: 'opencode', config: opencode },
        ]);
        await executors.createOrg({
            name: 'team',
            type: 'claude-code',
            config: { env: { ANTHROPIC_API_KEY: KEY } },
            createdBy: ALICE,
        });

        const reads = [await executors.listWithConfigs(ALICE), await executors.listOrgWithConfigs(), await rawRows()];
        for (const read of reads) expect(JSON.stringify(read)).not.toContain(KEY);
        const [claude] = await executors.listWithConfigs(ALICE);
        expect(claude?.config).toEqual({
            model: 'sonnet',
            env: { ANTHROPIC_API_KEY: expect.stringMatching(/^stored-credential:/) },
        });
        expect((await rawRows()).find((row) => row.name === 'open')?.secret_refs).toEqual([
            {
                path: ['provider', 'anthropic', 'options', 'apiKey'],
                ref: expect.any(String),
                version: expect.any(String),
            },
        ]);

        expect((await executors.claimConfigFor(ALICE, 'claude', 'user', sql))?.config).toEqual({
            model: 'sonnet',
            env: { ANTHROPIC_API_KEY: KEY },
        });
        expect((await executors.claimConfigFor(ALICE, 'open', 'user', sql))?.config).toEqual(opencode);
        expect((await executors.claimConfigFor(ALICE, 'team', 'org', sql))?.config).toEqual({
            env: { ANTHROPIC_API_KEY: KEY },
        });
    });
});

describe.skipIf(!enabled)('a save keeps, replaces or drops a stored key', () => {
    it('the marker sent back keeps the value through a rename and a scope change', async () => {
        const executors = store();
        await executors.replace(ALICE, [
            { name: 'main', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: KEY } } },
        ]);
        const [row] = await executors.listWithConfigs(ALICE);
        await executors.replace(ALICE, [{ name: 'renamed', type: 'claude-code', config: row!.config }]);
        expect((await executors.claimConfigFor(ALICE, 'renamed', 'user', sql))?.config).toEqual({
            env: { ANTHROPIC_API_KEY: KEY },
        });

        const [renamed] = await executors.list(ALICE);
        await executors.changeScope(renamed!.id, 'org', ALICE);
        expect((await executors.claimConfigFor(ALICE, 'renamed', 'org', sql))?.config).toEqual({
            env: { ANTHROPIC_API_KEY: KEY },
        });
    });

    it('a new value replaces the reference and deletes the old record after the commit', async () => {
        const executors = store();
        await executors.replace(ALICE, [
            { name: 'main', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: KEY } } },
        ]);
        const [before] = (await rawRows())[0]!.secret_refs;
        await executors.replace(ALICE, [
            { name: 'main', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: OTHER } } },
        ]);

        expect(await recordExists(before!)).toBe(false);
        expect((await executors.claimConfigFor(ALICE, 'main', 'user', sql))?.config).toEqual({
            env: { ANTHROPIC_API_KEY: OTHER },
        });
    });

    it("a marker naming another member's or another path's reference is dropped, never resolved", async () => {
        const executors = store();
        await executors.replace(BOB, [
            { name: 'bob', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: KEY } } },
        ]);
        const [bob] = await executors.listWithConfigs(BOB);
        const stolen = markerAt(bob!.config, 'env', 'ANTHROPIC_API_KEY');
        expect(stolen.startsWith(STORED_CREDENTIAL_PREFIX)).toBe(true);

        await executors.replace(ALICE, [
            { name: 'mine', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: stolen } } },
        ]);
        expect((await executors.claimConfigFor(ALICE, 'mine', 'user', sql))?.config).toEqual({ env: {} });
        await executors.replace(BOB, [
            { name: 'bob', type: 'claude-code', config: { env: { OPENAI_API_KEY: stolen } } },
        ]);
        expect((await executors.claimConfigFor(BOB, 'bob', 'user', sql))?.config).toEqual({ env: {} });
    });

    it('removing a profile deletes its stored keys', async () => {
        const executors = store();
        const team = await executors.createOrg({
            name: 'team',
            type: 'claude-code',
            config: { env: { ANTHROPIC_API_KEY: KEY } },
            createdBy: ALICE,
        });
        const [stored] = (await rawRows())[0]!.secret_refs;
        expect(await executors.deleteOrg(team.id)).toBe(true);
        expect(await recordExists(stored!)).toBe(false);
    });

    it('a store that cannot write refuses the save and stores nothing', async () => {
        const down = faultySecrets(secrets, {
            create: async () => {
                throw new Error('store down');
            },
        });
        await expect(
            store(down).replace(ALICE, [
                { name: 'main', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: KEY } } },
            ])
        ).rejects.toThrow();
        expect(await rawRows()).toEqual([]);
    });
});

describe.skipIf(!enabled)('migration 136: a key saved before the store held them', () => {
    it('moves to the secret store before the first read; the row keeps only the reference', async () => {
        const config = { model: 'sonnet', env: { ANTHROPIC_API_KEY: KEY } };
        await sql`
            insert into executor_profile (org_id, user_id, name, type, config, position)
            values (${ORG}, ${ALICE}, 'legacy', 'claude-code', ${sql.json(config)}, 0)
        `;
        const executors = store();

        const [listed] = await executors.listWithConfigs(ALICE);
        expect(JSON.stringify(listed)).not.toContain(KEY);
        const [row] = await rawRows();
        expect(JSON.stringify(row?.config)).not.toContain(KEY);
        expect(row?.secret_refs).toEqual([
            { path: ['env', 'ANTHROPIC_API_KEY'], ref: expect.any(String), version: expect.any(String) },
        ]);
        expect(markerAt(row?.config, 'env', 'ANTHROPIC_API_KEY')).toBe(
            `${STORED_CREDENTIAL_PREFIX}${row?.secret_refs[0]?.ref}`
        );
        expect((await executors.claimConfigFor(ALICE, 'legacy', 'user', sql))?.config).toEqual(config);
    });

    it('a failed conversion fails the read and is retried by the next', async () => {
        await sql`
            insert into executor_profile (org_id, user_id, name, type, config, position)
            values (${ORG}, ${ALICE}, 'legacy', 'claude-code', ${sql.json({ env: { ANTHROPIC_API_KEY: KEY } })}, 0)
        `;
        let fail = true;
        const flaky = faultySecrets(secrets, {
            create: (...args) => (fail ? Promise.reject(new Error('store down')) : secrets.create(...args)),
        });
        const executors = store(flaky);
        await expect(executors.list(ALICE)).rejects.toThrow();
        expect(JSON.stringify(await rawRows())).toContain(KEY);
        fail = false;
        expect(await executors.list(ALICE)).toHaveLength(1);
        expect(JSON.stringify(await rawRows())).not.toContain(KEY);
    });
});
