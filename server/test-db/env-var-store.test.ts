import { githubRepo } from '@factory-ai/core';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore, EnvScopeRefusal, stackEnv, type EnvVarStore } from '../src/db/env-var-store.js';
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

// Two racing writers, the barrier that holds them and the poll that watches them each need a connection.
const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE_USER], max: 6 });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    keys = new MutableKeys();
    secrets = testSecretStore(sql, keys);
    store = createEnvVarStore({ sql, orgId: ORG, secrets, secretLog: () => {} });
});

describe.skipIf(!enabled)('the env var store', () => {
    it('replaces a scope whole, so replaying the same body changes nothing', async () => {
        await store.replaceOrg('env-admin', [{ name: 'FIRST', value: '1', isSecret: false }]);
        await store.replaceOrg('env-admin', [{ name: 'SECOND', value: '2', isSecret: false }]);
        await store.replaceOrg('env-admin', [{ name: 'SECOND', value: '2', isSecret: false }]);

        const rows = await store.listOrg();
        expect(rows.map((row) => row.name)).toEqual(['SECOND']);
    });

    it('keeps a secret whose incoming value is null, and deletes one whose name is omitted', async () => {
        await store.replaceOrg('env-admin', [
            { name: 'SECRET_A', value: 'a', isSecret: true },
            { name: 'SECRET_B', value: 'b', isSecret: true },
            { name: 'PLAIN', value: 'p', isSecret: false },
        ]);

        // SECRET_B is omitted entirely — deleted. SECRET_A is sent back with a null value — kept.
        await store.replaceOrg('env-admin', [
            { name: 'SECRET_A', value: null, isSecret: true },
            { name: 'PLAIN', value: 'p2', isSecret: false },
        ]);

        const rows = await store.listOrg();
        expect(rows.map((row) => row.name).sort()).toEqual(['PLAIN', 'SECRET_A']);
    });

    it('never echoes a secret value from list, but resolveFor returns it', async () => {
        await store.replaceOrg('env-admin', [
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
        await store.replaceOrg('env-admin', [
            { name: 'LEVEL', value: 'org', isSecret: false },
            { name: 'ONLY_ORG', value: 'o', isSecret: false },
        ]);
        await store.replaceWorkspace(ALICE, [{ name: 'LEVEL', value: 'workspace', isSecret: false }]);
        await store.replaceRepo('env-admin', githubRepo(`${REPO.owner}/${REPO.name}`), [
            { name: 'LEVEL', value: 'repo', isSecret: false },
            { name: 'ONLY_REPO', value: 'r', isSecret: false },
        ]);

        // All three contribute, repo winning the collision.
        expect(await store.resolveFor({ userId: ALICE, repo: githubRepo(`${REPO.owner}/${REPO.name}`) })).toEqual({
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

    it('namesFor answers the names resolveFor would carry, Claude Code’s from one scope, reading no secret', async () => {
        await store.replaceOrg('env-admin', [
            { name: 'ANTHROPIC_API_KEY', value: 'org-key', isSecret: true },
            { name: 'ONLY_ORG', value: 'o', isSecret: false },
        ]);
        await store.replaceWorkspace(ALICE, [{ name: 'OPENROUTER_API_KEY', value: 'mine', isSecret: true }]);
        await store.replaceRepo('env-admin', githubRepo('acme/other'), [
            { name: 'OPENAI_API_KEY', value: 'x', isSecret: true },
        ]);
        const unreadable = createEnvVarStore({
            sql,
            orgId: ORG,
            secrets: faultySecrets(secrets, { readActive: () => Promise.reject(new Error('no secret is read')) }),
            secretLog: () => {},
        });
        const target = { userId: ALICE, repo: githubRepo(`${REPO.owner}/${REPO.name}`) };

        expect((await unreadable.namesFor(target)).sort()).toEqual([
            'ANTHROPIC_API_KEY',
            'ONLY_ORG',
            'OPENROUTER_API_KEY',
        ]);
        expect((await unreadable.namesFor(target, { agentType: 'claude-code' })).sort()).toEqual(
            Object.keys(await store.resolveFor(target, sql, { agentType: 'claude-code' })).sort()
        );
        expect(await unreadable.namesFor(target, { agentType: 'claude-code' })).not.toContain('ANTHROPIC_API_KEY');
    });

    it('groups the repo scopes for the page', async () => {
        await store.replaceRepo('env-admin', githubRepo(`${REPO.owner}/${REPO.name}`), [
            { name: 'R', value: '1', isSecret: false },
        ]);
        // Created with its real value, then echoed without it — the write-only contract.
        await store.replaceRepo('env-admin', githubRepo('Other/repo'), [
            { name: 'S', value: 'hidden', isSecret: true },
        ]);

        const repos = await store.listRepos();
        expect(repos).toEqual([
            { repo: githubRepo('Bellows-AI/bellows.ai'), vars: [expect.objectContaining({ name: 'R', value: '1' })] },
            {
                repo: githubRepo('Other/repo'),
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
        {
            name: 'refuses a secret holding a plaintext value, at the row',
            insert: () => sql`
                insert into env_var (org_id, name, value, is_secret) values (${ORG}, 'PLAIN_SECRET', 'leak', true)
            `,
            check: /env_var_secret_form_ck/,
        },
    ])('$name', async ({ insert, check }) => {
        await expect(insert()).rejects.toThrow(check);
    });
});

describe.skipIf(!enabled)('the GitHub reservation migration (072)', () => {
    it('deletes stored GITHUB_TOKEN and GH_TOKEN rows in every scope and keeps the rest', async () => {
        await store.replaceOrg('env-admin', [
            { name: 'GITHUB_TOKEN', value: 'ghp_org', isSecret: true },
            { name: 'KEEP_ORG', value: '1', isSecret: false },
        ]);
        await store.replaceWorkspace(ALICE, [{ name: 'GH_TOKEN', value: 'ghp_mine', isSecret: true }]);
        await store.replaceRepo('env-admin', githubRepo(`${REPO.owner}/${REPO.name}`), [
            { name: 'GITHUB_TOKEN', value: 'ghp_repo', isSecret: true },
        ]);

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

const REPO_SCOPE = { kind: 'repo', repo: githubRepo(`${REPO.owner}/${REPO.name}`) } as const;
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

describe.skipIf(!enabled)('encrypted environment secrets (the one stored format)', () => {
    it('resolves an encrypted secret in each scope, precedence kept', async () => {
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'LEVEL' }, 'org-secret');
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'ONLY_ORG' }, 'o');
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: WORKSPACE_SCOPE, name: 'LEVEL' }, 'ws-secret');
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: REPO_SCOPE, name: 'REPO_ONLY' }, 'ünï-✓');

        expect(await store.resolveFor({ userId: ALICE, repo: githubRepo(`${REPO.owner}/${REPO.name}`) })).toEqual({
            LEVEL: 'ws-secret',
            ONLY_ORG: 'o',
            REPO_ONLY: 'ünï-✓',
        });
        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({ LEVEL: 'org-secret', ONLY_ORG: 'o' });
    });

    it('resolves non-secret and encrypted rows together', async () => {
        await store.replaceOrg('env-admin', [{ name: 'PLAIN', value: 'p', isSecret: false }]);
        await seedEncryptedRow(sql, secrets, { orgId: ORG, scope: ORG_SCOPE, name: 'NEW_SECRET' }, 'enc');

        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({ PLAIN: 'p', NEW_SECRET: 'enc' });
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
            secretLog: () => {},
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
            secretLog: () => {},
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

    // 112's check refuses these rows at insert, so each case lifts it inside a transaction that always rolls back.
    it.each([
        { label: 'a secret with no reference and no value', is: true, value: null },
        { label: 'a non-secret with a null value', is: false, value: null },
        { label: 'a secret holding a plaintext value and no reference', is: true, value: 'leak' },
    ])('a malformed row rejects: $label', async ({ is, value }) => {
        const ROLLBACK = new Error('rollback');
        let error: EnvSecretError | undefined;
        await sql
            .begin(async (tx) => {
                await tx`alter table env_var drop constraint if exists env_var_secret_form_ck`;
                await tx`insert into env_var (org_id, name, value, is_secret) values (${ORG}, 'BAD', ${value}, ${is})`;
                error = await rejection(store.resolveFor({ userId: null, repo: null }, tx));
                throw ROLLBACK;
            })
            .catch((e: unknown) => {
                if (e !== ROLLBACK) throw e;
            });
        expect(error).toMatchObject({ envName: 'BAD', code: 'malformed-row' });
        expect(error?.message).not.toContain('leak');
    });
});

const POLL_MS = 10;
const BARRIER_WAIT_MS = 5000;

/**
 * Starts both writers while a third connection holds `env_var` against every write, waits until both are parked on
 * a lock, then lets them go together: without a scope lock both reach the table at once.
 */
async function race(a: () => Promise<void>, b: () => Promise<void>): Promise<unknown[]> {
    const blocker = await sql.reserve();
    await blocker`begin`;
    await blocker`lock table env_var in exclusive mode`;
    const runs = [a(), b()].map((run) =>
        run.then(
            () => null,
            (error: unknown) => error
        )
    );
    try {
        const deadline = Date.now() + BARRIER_WAIT_MS;
        for (;;) {
            const [row] = await sql<{ n: number }[]>`
                select count(*)::int as n from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'
            `;
            if ((row?.n ?? 0) >= 2) break;
            if (Date.now() > deadline) throw new Error('the two writers never both waited');
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
    } finally {
        await blocker`commit`;
        blocker.release();
    }
    return Promise.all(runs);
}

const orgNames = async () => (await store.listOrg()).map((row) => row.name).sort();

describe.skipIf(!enabled)('concurrent writes to one scope', () => {
    it('two whole-list replaces serialize: the scope ends as one of them, never a union', async () => {
        await store.replaceOrg('env-admin', [{ name: 'SEED', value: 's', isSecret: false }]);

        const errors = await race(
            () => store.replaceOrg('env-admin', [{ name: 'FROM_A', value: 'a', isSecret: false }]),
            () => store.replaceOrg('env-admin', [{ name: 'FROM_B', value: 'b', isSecret: false }])
        );

        expect(errors).toEqual([null, null]);
        expect([['FROM_A'], ['FROM_B']]).toContainEqual(await orgNames());
    });

    it('a whole-list replace and a single-name upsert both succeed and end in one serial order', async () => {
        await store.replaceOrg('env-admin', [{ name: 'SEED', value: 's', isSecret: false }]);

        const errors = await race(
            () => store.replaceOrg('env-admin', [{ name: 'WHOLE', value: 'w', isSecret: false }]),
            () =>
                store.writeScoped(
                    { kind: 'org' },
                    { upsert: [{ name: 'ONE', value: '1', isSecret: true }], remove: [] },
                    'env-admin'
                )
        );

        expect(errors).toEqual([null, null]);
        // Replace then upsert keeps both; upsert then replace leaves the replace's list alone.
        expect([['ONE', 'WHOLE'], ['WHOLE']]).toContainEqual(await orgNames());
    });

    it('a write that cannot take the scope lock in time fails rather than hangs, replace and single-name alike', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered: () => void = () => {};
        const holding = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const holder = store.writeScoped(
            { kind: 'org' },
            { upsert: [{ name: 'HOLDER', value: 'h', isSecret: false }], remove: [] },
            'env-admin',
            {
                alsoInTx: async () => {
                    entered();
                    await held;
                },
            }
        );
        await holding;
        const impatient = createEnvVarStore({ sql, orgId: ORG, secrets, secretLog: () => {}, lockTimeoutMs: 200 });

        const single = await impatient
            .writeScoped(
                { kind: 'org' },
                { upsert: [{ name: 'LATE', value: 'l', isSecret: false }], remove: [] },
                'env-admin'
            )
            .then(
                () => null,
                (error: unknown) => error
            );
        const whole = await impatient.replaceOrg('env-admin', [{ name: 'LATE', value: 'l', isSecret: false }]).then(
            () => null,
            (error: unknown) => error
        );
        release();
        await holder;

        expect(single).toMatchObject({ code: '55P03' });
        expect(whole).toMatchObject({ code: '55P03' });
        expect(await orgNames()).toEqual(['HOLDER']);
    });

    it('locks one scope only: another scope writes while it is held', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let entered: () => void = () => {};
        const holding = new Promise<void>((resolve) => {
            entered = resolve;
        });
        const holder = store.writeScoped({ kind: 'org' }, { upsert: [], remove: [] }, 'env-admin', {
            alsoInTx: async () => {
                entered();
                await held;
            },
        });
        await holding;
        const impatient = createEnvVarStore({ sql, orgId: ORG, secrets, secretLog: () => {}, lockTimeoutMs: 200 });

        await impatient.replaceWorkspace(ALICE, [{ name: 'MINE', value: 'm', isSecret: false }]);
        release();
        await holder;

        expect((await store.listWorkspace(ALICE)).map((row) => row.name)).toEqual(['MINE']);
    });
});

describe.skipIf(!enabled)('a single-name write', () => {
    it('upserts and removes only the names it touches', async () => {
        await store.replaceOrg('env-admin', [
            { name: 'KEEP_SECRET', value: 'ks', isSecret: true },
            { name: 'KEEP_PLAIN', value: 'kp', isSecret: false },
            { name: 'CHANGE', value: 'old', isSecret: false },
            { name: 'DROP', value: 'd', isSecret: true },
        ]);

        await store.writeScoped(
            { kind: 'org' },
            { upsert: [{ name: 'CHANGE', value: 'new', isSecret: true }], remove: ['DROP'] },
            'env-admin'
        );

        expect(await store.resolveFor({ userId: null, repo: null })).toEqual({
            KEEP_SECRET: 'ks',
            KEEP_PLAIN: 'kp',
            CHANGE: 'new',
        });
    });

    it('hands the validator the list the scope would hold, read under the lock, and stores nothing on a refusal', async () => {
        await store.replaceOrg('env-admin', [
            { name: 'STORED_SECRET', value: 's', isSecret: true },
            { name: 'STORED_PLAIN', value: 'p', isSecret: false },
        ]);
        const seen: unknown[] = [];

        const error = await store
            .writeScoped(
                { kind: 'org' },
                { upsert: [{ name: 'NEW', value: 'n', isSecret: false }], remove: ['STORED_PLAIN'] },
                'env-admin',
                {
                    validate: (resulting) => {
                        seen.push(resulting);
                        return 'refused for the test';
                    },
                }
            )
            .then(
                () => null,
                (e: unknown) => e
            );

        expect(error).toBeInstanceOf(EnvScopeRefusal);
        expect((error as EnvScopeRefusal).reason).toBe('refused for the test');
        expect(seen).toEqual([
            [
                { name: 'STORED_SECRET', value: null, isSecret: true },
                { name: 'NEW', value: 'n', isSecret: false },
            ],
        ]);
        expect(await orgNames()).toEqual(['STORED_PLAIN', 'STORED_SECRET']);
    });

    it('audits env.write with the names the scope holds, never a value', async () => {
        await store.writeScoped(
            { kind: 'workspace', userId: ALICE },
            { upsert: [{ name: 'API_KEY', value: 'audit-must-not-hold-this', isSecret: true }], remove: [] },
            ALICE
        );

        const rows = await sql<{ actor_id: string; target: string; detail: unknown }[]>`
            select actor_id, target, detail from audit_event where org_id = ${ORG} and action = 'env.write'
        `;
        expect(rows).toEqual([{ actor_id: ALICE, target: `workspace/${ALICE}`, detail: { names: ['API_KEY'] } }]);
        expect(JSON.stringify(rows)).not.toContain('audit-must-not-hold-this');
    });
});
