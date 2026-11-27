import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    ConfiguredDefaultUnusableError,
    ExecutorDefaultNotFoundError,
    ExecutorDefaultProtectedError,
    ExecutorSuspendedError,
    createUserExecutorStore,
    type UserExecutorStore,
} from '../src/db/user-executor-store.js';
import { testSecretDeps } from './env-secrets-harness.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The scoped, stable default-executor selection (migration 169) against Postgres: a selection names an
 * executor by its id, personal beats organization beats the legacy chain, and the executor lifecycle
 * cannot leave a selection dangling.
 */
const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;

const db = useTestDb({ orgs: [ORG], users: [ALICE_USER, BOB_USER], max: 8 });

let sql: Sql;
let store: UserExecutorStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
});

const claude = { type: 'claude-code', config: {} };
const personal = async (userId: string, name: string) => {
    const existing = await store.list(userId);
    await store.replace(userId, [
        ...existing.map((row) => ({ id: row.id, name: row.name, type: row.type, config: {} })),
        { name, ...claude },
    ]);
    return (await store.list(userId)).find((row) => row.name === name)!;
};
const legacyDefault = (userId: string, def: { scope: string; name: string }) =>
    sql`
        insert into user_executor_default (org_id, user_id, scope, name)
        values (${ORG}, ${userId}, ${def.scope}, ${def.name})
        on conflict (org_id, user_id) do update set scope = excluded.scope, name = excluded.name
    `;
const shared = (name: string) => store.createOrg({ name, ...claude, createdBy: ALICE });

describe.skipIf(!enabled)('configured default selection', () => {
    it('personal configured default precedes organization configured default', async () => {
        const org = await shared('org-default');
        const mine = await personal(ALICE, 'mine');
        await store.selectDefault(null, org.id);
        expect(await store.resolvedDefault(ALICE)).toEqual({ kind: 'profile', scope: 'org', name: 'org-default' });

        await store.selectDefault(ALICE, mine.id);
        expect(await store.resolvedDefault(ALICE)).toEqual({ kind: 'profile', scope: 'user', name: 'mine' });
        // Bob has no personal selection: the organization's applies to him.
        expect(await store.resolvedDefault(BOB)).toMatchObject({ scope: 'org', name: 'org-default' });
    });

    it('configured defaults precede legacy fallback', async () => {
        const first = await personal(ALICE, 'first');
        const chosen = await shared('chosen');
        await legacyDefault(ALICE, { scope: 'user', name: 'first' });
        await store.setAgentDefault(null, { agentType: 'opencode', model: 'x/y' });
        expect(first.id).toBeDefined();

        await store.selectDefault(null, chosen.id);
        expect(await store.resolvedDefault(ALICE)).toMatchObject({ kind: 'profile', scope: 'org', name: 'chosen' });
    });

    it('legacy resolution is unchanged without configured defaults', async () => {
        await personal(ALICE, 'first');
        const org = await shared('org-row');
        expect(await store.resolvedDefault(ALICE)).toEqual({ kind: 'profile', scope: 'user', name: 'first' });
        await legacyDefault(ALICE, { scope: 'org', name: 'org-row' });
        expect(await store.resolvedDefault(ALICE)).toEqual({ kind: 'profile', scope: 'org', name: 'org-row' });
        await store.setAgentDefault(null, { agentType: 'opencode', model: 'x/y' });
        await legacyDefault(ALICE, { scope: 'user', name: 'first' });
        expect(await store.resolvedDefault(BOB)).toMatchObject({ kind: 'agent', from: 'org' });
        expect(org.id).toBeDefined();
    });

    it('stale configured default refuses without fallback', async () => {
        const mine = await personal(ALICE, 'mine');
        await personal(ALICE, 'other');
        await store.selectDefault(ALICE, mine.id);
        await store.setAgentDefault(null, { agentType: 'opencode', model: 'x/y' });

        await store.setPersonalSuspended(ALICE, mine.id, true);
        const refused = await store.resolvedDefault(ALICE).then(
            () => null,
            (e: unknown) => e
        );
        expect(refused).toBeInstanceOf(ConfiguredDefaultUnusableError);
        expect(refused).toMatchObject({ reason: 'suspended', scope: 'user', executorName: 'mine' });

        // Resuming restores it; the selection was never dropped.
        await store.setPersonalSuspended(ALICE, mine.id, false);
        expect(await store.resolvedDefault(ALICE)).toMatchObject({ name: 'mine' });
    });

    it('refuses a target the owner may not select, and a suspended one, writing nothing', async () => {
        const org = await shared('org-row');
        const mine = await personal(ALICE, 'mine');
        const his = await personal(BOB, 'his');

        // An organization default targets organization executors only.
        await expect(store.selectDefault(null, mine.id)).rejects.toBeInstanceOf(ExecutorDefaultNotFoundError);
        // A personal default targets the member's own or an organization executor, never another member's.
        await expect(store.selectDefault(ALICE, his.id)).rejects.toBeInstanceOf(ExecutorDefaultNotFoundError);
        await expect(store.selectDefault(ALICE, randomUUID())).rejects.toBeInstanceOf(ExecutorDefaultNotFoundError);
        await expect(store.selectDefault(ALICE, org.id)).resolves.toMatchObject({ executorId: org.id, scope: 'org' });

        await store.setOrgSuspended(org.id, true);
        await expect(store.selectDefault(null, org.id)).rejects.toBeInstanceOf(ExecutorSuspendedError);
        expect(await store.selectedDefault(null)).toBeNull();
        expect(await store.selectedDefault(BOB)).toBeNull();
    });

    it('keeps one selection per owner and replaces it in place', async () => {
        const a = await shared('a');
        const b = await shared('b');
        await store.selectDefault(null, a.id);
        await store.selectDefault(null, b.id);
        const rows = await sql`select executor_id from executor_default_selection where org_id = ${ORG}`;
        expect(rows).toHaveLength(1);
        expect(await store.selectedDefault(null)).toMatchObject({ executorId: b.id, name: 'b' });
        expect(await store.clearDefault(null)).toBe(true);
        expect(await store.clearDefault(null)).toBe(false);
    });

    it('default selection racing deletion cannot create a dangling reference', async () => {
        for (let round = 0; round < 15; round += 1) {
            const row = await personal(ALICE, `race-${round}`);
            await Promise.allSettled([store.selectDefault(ALICE, row.id), store.removePersonal(ALICE, row.id)]);
            const dangling = await sql`
                select s.executor_id from executor_default_selection s
                where s.org_id = ${ORG}
                  and not exists (select 1 from executor_profile p where p.org_id = s.org_id and p.id = s.executor_id)
            `;
            expect(dangling).toEqual([]);
            await store.clearDefault(ALICE);
            await store.replace(ALICE, []);
        }
    });

    const refusal = async (write: () => Promise<unknown>) => {
        const error = await write().then(
            () => null,
            (e: unknown) => e
        );
        expect(error).toBeInstanceOf(ExecutorDefaultProtectedError);
        return error as ExecutorDefaultProtectedError;
    };

    it('refuses deleting an executor any default names, counting the selections and never naming members', async () => {
        const org = await shared('org-row');
        await store.selectDefault(null, org.id);
        await store.selectDefault(BOB, org.id);
        const refused = await refusal(() => store.deleteOrg(org.id));
        expect(refused).toMatchObject({ selections: { organization: true, members: 1 } });
        expect(refused.message).not.toContain(BOB);
        expect(await store.orgCount()).toBe(1);
        expect(await store.selectedDefault(null)).toMatchObject({ executorId: org.id });
        expect(await store.selectedDefault(BOB)).toMatchObject({ executorId: org.id });

        // A member's selection alone refuses too: it is never released silently.
        await store.clearDefault(null);
        expect(await refusal(() => store.deleteOrg(org.id))).toMatchObject({
            selections: { organization: false, members: 1 },
        });
        expect(await store.selectedDefault(BOB)).toMatchObject({ executorId: org.id });
    });

    it('deletes with an explicit clear, which clears every selection naming it in one transaction', async () => {
        const org = await shared('org-row');
        await store.selectDefault(null, org.id);
        await store.selectDefault(BOB, org.id);
        await expect(store.deleteOrg(org.id, { clear: true })).resolves.toBe(true);
        expect(await store.selectedDefault(null)).toBeNull();
        expect(await store.selectedDefault(BOB)).toBeNull();
    });

    it('deletes with an explicit replacement, re-pointing every selection, or refuses atomically', async () => {
        const gone = await shared('gone');
        const next = await shared('next');
        const suspended = await shared('suspended');
        const mine = await personal(ALICE, 'mine');
        await store.setOrgSuspended(suspended.id, true);
        await store.selectDefault(null, gone.id);
        await store.selectDefault(BOB, gone.id);

        for (const target of [mine.id, suspended.id, gone.id, randomUUID()]) {
            await expect(store.deleteOrg(gone.id, { replaceWith: target })).rejects.toThrow();
        }
        expect(await store.orgCount()).toBe(3);
        expect(await store.selectedDefault(null)).toMatchObject({ executorId: gone.id });
        expect(await store.selectedDefault(BOB)).toMatchObject({ executorId: gone.id });

        await expect(store.deleteOrg(gone.id, { replaceWith: next.id })).resolves.toBe(true);
        expect(await store.selectedDefault(null)).toMatchObject({ executorId: next.id, name: 'next' });
        expect(await store.selectedDefault(BOB)).toMatchObject({ executorId: next.id });
    });

    it('scope changes preserve valid defaults or refuse atomically', async () => {
        const mine = await personal(ALICE, 'mine');
        await store.selectDefault(ALICE, mine.id);
        // Promotion keeps the member's own selection valid: a personal default may target an org row.
        await store.changeScope(mine.id, 'org', ALICE);
        expect(await store.selectedDefault(ALICE)).toMatchObject({ executorId: mine.id, scope: 'org', name: 'mine' });

        // The organization default cannot be demoted into one member's personal list.
        await store.selectDefault(null, mine.id);
        await store.selectDefault(BOB, mine.id);
        expect(await refusal(() => store.changeScope(mine.id, 'user', ALICE))).toMatchObject({
            selections: { organization: true, members: 1 },
        });
        expect(await store.selectedDefault(null)).toMatchObject({ executorId: mine.id, scope: 'org' });
        expect((await store.listOrg()).map((row) => row.id)).toEqual([mine.id]);

        // Another member's selection refuses too, until the demotion carries an explicit clear.
        await store.clearDefault(null);
        expect(await refusal(() => store.changeScope(mine.id, 'user', ALICE))).toMatchObject({
            selections: { organization: false, members: 1 },
        });
        expect(await store.selectedDefault(BOB)).toMatchObject({ executorId: mine.id });
        await store.changeScope(mine.id, 'user', ALICE, { clear: true });
        expect(await store.selectedDefault(BOB)).toBeNull();
        // The caller's own selection stays valid on their own row.
        expect(await store.selectedDefault(ALICE)).toMatchObject({ executorId: mine.id, scope: 'user' });
    });
});
