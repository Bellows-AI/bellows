import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore, stackEnv, type EnvVarStore } from '../src/db/env-var-store.js';
import { EnvSecretError } from '../src/db/env-secrets.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';
import { faultySecrets, seedEncryptedRow, testSecretStore } from './env-secrets-harness.js';
import { MutableKeys } from './secrets-postgres-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: EnvVarStore;
let secrets: ReturnType<typeof testSecretStore>;
let keys: MutableKeys;

const ORG = testOrg();
const OTHER_ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const REPO = { owner: 'Bellows-AI', name: 'bellows.ai' };

const RESERVE_GITHUB = new URL('../migrations/072_github_env_reserved.sql', import.meta.url);

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE_USER] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    keys = new MutableKeys();
    secrets = testSecretStore(sql, keys);
    store = createEnvVarStore({ sql, orgId: ORG, secrets });
});

describe.skipIf(!enabled)('the env var store', () => {
    it('replaces a scope whole, so replaying the same body changes nothing', async () => {
        await store.replaceOrg([{ name: 'FIRST', value: '1', isSecret: false }]);
        await store.replaceOrg([{ name: 'SECOND', value: '2', isSecret: false }]);
        await store.replaceOrg([{ name: 'SECOND', value: '2', isSecret: false }]);

        const rows = await store.listOrg();
        expect(rows.map((row) => row.name)).toEqual(['SECOND']);
    });

    it('keeps a secret whose incoming value is null, and deletes one whose name is omitted', async () => {
        await store.replaceOrg([
            { name: 'SECRET_A', value: 'a', isSecret: true },
            { name: 'SECRET_B', value: 'b', isSecret: true },
            { name: 'PLAIN', value: 'p', isSecret: false },
        ]);

        // SECRET_B is omitted entirely — deleted. SECRET_A is sent back with a null value — kept.
        await store.replaceOrg([
            { name: 'SECRET_A', value: null, isSecret: true },
            { name: 'PLAIN', value: 'p2', isSecret: false },
        ]);

        const rows = await store.listOrg();
        expect(rows.map((row) => row.name).sort()).toEqual(['PLAIN', 'SECRET_A']);
    });

    it('never echoes a secret value from list, but resolveFor returns it', async () => {
        await store.replaceOrg([
            { name: 'SECRET', value: 's3cr3t', isSecret: true },
            { name: 'PLAIN', value: 'visible', isSecret: false },
        ]);

        const rows = await store.listOrg();
        expect(rows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'SECRET', value: null, isSecret: true }),
                expect.objectContaining({ name: 'PLAIN', value: 'visible', isSecret: false }),
            ])
        );

        const resolved = await store.resolveFor({ userId: null, repo: null });
        expect(resolved).toEqual({ SECRET: 's3cr3t', PLAIN: 'visible' });
    });

    it('stacks org under workspace under repo, the more specific winning', async () => {
        await store.replaceOrg([
            { name: 'LEVEL', value: 'org', isSecret: false },
            { name: 'ONLY_ORG', value: 'o', isSecret: false },
        ]);
        await store.replaceWorkspace(ALICE, [{ name: 'LEVEL', value: 'workspace', isSecret: false }]);
        await store.replaceRepo(REPO.owner, REPO.name, [
            { name: 'LEVEL', value: 'repo', isSecret: false },
            { name: 'ONLY_REPO', value: 'r', isSecret: false },
        ]);

        // All three contribute, repo winning the collision.
        expect(await store.resolveFor({ userId: ALICE, repo: `${REPO.owner}/${REPO.name}` })).toEqual({
            ONLY_ORG: 'o',
            ONLY_REPO: 'r',
            LEVEL: 'repo',
        });

        // A job with no repo label gets org + workspace only.
        expect(await store.resolveFor({ userId: ALICE, repo: null })).toEqual({
            ONLY_ORG: 'o',
            LEVEL: 'workspace',
        });

        // An unattributed job gets the org level alone.
        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({
            ONLY_ORG: 'o',
            LEVEL: 'org',
        });
    });

    it('groups the repo scopes for the page', async () => {
        await store.replaceRepo(REPO.owner, REPO.name, [{ name: 'R', value: '1', isSecret: false }]);
        // Created with its real value, then echoed without it — the write-only contract.
        await store.replaceRepo('Other', 'repo', [{ name: 'S', value: 'hidden', isSecret: true }]);

        const repos = await store.listRepos();
        expect(repos).toEqual([
            { owner: 'Bellows-AI', name: 'bellows.ai', vars: [expect.objectContaining({ name: 'R', value: '1' })] },
            {
                owner: 'Other',
                name: 'repo',
                vars: [expect.objectContaining({ name: 'S', value: null, isSecret: true })],
            },
        ]);
    });

    it.each<{ name: string; insert: () => Promise<unknown>; check: RegExp }>([
        {
            name: 'refuses a row that is both user- and repo-scoped, at the row',
            insert: () => sql`
                insert into env_var (org_id, user_id, repo_owner, repo_name, name, value)
                values (${ORG}, ${ALICE}, 'Bellows-AI', 'bellows.ai', 'X', '1')
            `,
            check: /env_var_scope_ck/,
        },
        {
            name: 'refuses a name that is not a legal environment variable name, at the row',
            insert: () => sql`
                insert into env_var (org_id, user_id, repo_owner, repo_name, name, value)
                values (${ORG}, null, null, null, 'not a name', '1')
            `,
            check: /env_var_name_ck/,
        },
    ])('$name', async ({ insert, check }) => {
        await expect(insert()).rejects.toThrow(check);
    });
});

describe.skipIf(!enabled)('the GitHub reservation migration (072)', () => {
    it('deletes stored GITHUB_TOKEN and GH_TOKEN rows in every scope and keeps the rest', async () => {
        await store.replaceOrg([
            { name: 'GITHUB_TOKEN', value: 'ghp_org', isSecret: true },
            { name: 'KEEP_ORG', value: '1', isSecret: false },
        ]);
        await store.replaceWorkspace(ALICE, [{ name: 'GH_TOKEN', value: 'ghp_mine', isSecret: true }]);
        await store.replaceRepo(REPO.owner, REPO.name, [{ name: 'GITHUB_TOKEN', value: 'ghp_repo', isSecret: true }]);

        await sql.unsafe(readFileSync(RESERVE_GITHUB, 'utf8'));

        const names = await sql<{ name: string }[]>`select name from env_var where org_id = ${ORG} order by name`;
        expect(names.map((row) => row.name)).toEqual(['KEEP_ORG']);
    });
});

describe('stackEnv', () => {
    it('merges three scopes, most specific winning on collisions', () => {
        expect(stackEnv({ A: 'org', B: 'org' }, { B: 'workspace', C: 'workspace' }, { C: 'repo', D: 'repo' })).toEqual({
            A: 'org',
            B: 'workspace',
            C: 'repo',
            D: 'repo',
        });
    });
});

const REPO_SCOPE = { kind: 'repo', owner: REPO.owner, name: REPO.name } as const;
const ORG_SCOPE = { kind: 'org' } as const;
const WORKSPACE_SCOPE = { kind: 'workspace', userId: ALICE } as const;

const rejection = async (promise: Promise<unknown>): Promise<EnvSecretError> => {
    const error = await promise.then(
        () => undefined,
        (e: unknown) => e
    );
    expect(error).toBeInstanceOf(EnvSecretError);
    return error as EnvSecretError;
};

describe.skipIf(!enabled)('encrypted environment secrets (reader for both formats)', () => {
    it('resolves an encrypted secret in each scope, precedence kept', async () => {
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'LEVEL' }, 'org-secret');
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'ONLY_ORG' }, 'o');
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: WORKSPACE_SCOPE, name: 'LEVEL' }, 'ws-secret');
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: REPO_SCOPE, name: 'REPO_ONLY' }, 'ünï-✓');

        expect(await store.resolveFor({ userId: ALICE, repo: `${REPO.owner}/${REPO.name}` })).toEqual({
            LEVEL: 'ws-secret',
            ONLY_ORG: 'o',
            REPO_ONLY: 'ünï-✓',
        });
        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({ LEVEL: 'org-secret', ONLY_ORG: 'o' });
    });

    it('resolves a mix of old-format and encrypted rows', async () => {
        await store.replaceOrg([
            { name: 'OLD_SECRET', value: 'plain-secret', isSecret: true },
            { name: 'PLAIN', value: 'p', isSecret: false },
        ]);
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'NEW_SECRET' }, 'enc');

        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({
            OLD_SECRET: 'plain-secret',
            PLAIN: 'p',
            NEW_SECRET: 'enc',
        });
    });

    it('never echoes an encrypted secret from a list', async () => {
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'HIDDEN' }, 'enc');
        expect(await store.listOrg()).toEqual([
            expect.objectContaining({ name: 'HIDDEN', value: null, isSecret: true }),
        ]);
    });

    it.each([
        {
            label: 'across organizations',
            slot: { orgId: ORG, scope: ORG_SCOPE, name: 'COPIED' },
            from: { orgId: OTHER_ORG, scope: { kind: 'org' } as const, name: 'COPIED' },
        },
        {
            label: 'to another name',
            slot: { orgId: ORG, scope: ORG_SCOPE, name: 'COPIED' },
            from: { orgId: ORG, scope: ORG_SCOPE, name: 'SOURCE' },
        },
        {
            label: 'from a workspace row to an organization row',
            slot: { orgId: ORG, scope: ORG_SCOPE, name: 'COPIED' },
            from: { orgId: ORG, scope: WORKSPACE_SCOPE, name: 'COPIED' },
        },
    ])('a copied reference fails $label', async ({ slot, from }) => {
        await seedEncryptedRow(sql, secrets, { ...slot, identityOf: from }, 'secret-value');
        const error = await rejection(store.resolveFor({ userId: null, repo: null }));
        expect(error).toMatchObject({ envName: 'COPIED', code: 'identity-mismatch' });
        expect(error.message).not.toContain('secret-value');
    });

    it('a tampered envelope fails with integrity-failure and no plaintext in the message', async () => {
        const { ref } = await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'T' }, 'plain-xyz');
        await sql`update secret_version set envelope = set_byte(envelope, length(envelope) - 1,
                  get_byte(envelope, length(envelope) - 1) # 1) where ref = ${ref}`;

        const error = await rejection(store.resolveFor({ userId: null, repo: null }));
        expect(error).toMatchObject({ envName: 'T', code: 'integrity-failure' });
        expect(error.message).not.toContain('plain-xyz');
    });

    it('a missing key fails closed', async () => {
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'K' }, 'v');
        const keyless = createEnvVarStore({
            sql,
            orgId: ORG,
            secrets: testSecretStore(sql, new MutableKeys({ keys, only: [] })),
        });
        await rejection(keyless.resolveFor({ userId: null, repo: null }));
    });

    it.each(['unavailable', 'outcome-unknown'] as const)('a %s read rejects and drops nothing', async (code) => {
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'A' }, 'a');
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'B' }, 'b');
        const faulty = createEnvVarStore({
            sql,
            orgId: ORG,
            secrets: faultySecrets(secrets, {
                readActive: async () => ({ ok: false, error: { code, reason: 'provider-unavailable' } }),
            }),
        });
        expect(await rejection(faulty.resolveFor({ userId: null, repo: null }))).toMatchObject({ code });
    });

    it('a version mismatch rejects', async () => {
        const { ref } = await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'V' }, 'v');
        await sql`update env_var set secret_version = 'stale' where secret_ref = ${ref}`;
        expect(await rejection(store.resolveFor({ userId: null, repo: null }))).toMatchObject({
            envName: 'V',
            code: 'version-mismatch',
        });
    });

    it('bytes that are not valid UTF-8 reject', async () => {
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'BIN' }, Uint8Array.of(0xff, 0xfe));
        expect(await rejection(store.resolveFor({ userId: null, repo: null }))).toMatchObject({
            envName: 'BIN',
            code: 'invalid-encoding',
        });
    });

    it.each([
        { label: 'a secret with no reference and no value', is: true, value: null },
        { label: 'a non-secret with a null value', is: false, value: null },
    ])('a malformed row rejects: $label', async ({ is, value }) => {
        await sql`insert into env_var (org_id, name, value, is_secret) values (${ORG}, 'BAD', ${value}, ${is})`;
        expect(await rejection(store.resolveFor({ userId: null, repo: null }))).toMatchObject({
            envName: 'BAD',
            code: 'malformed-row',
        });
    });
});
