import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { ExecutorConnectionRefusedError } from '../src/db/executor-connection-selection.js';
import { createProviderConnectionStore } from '../src/db/provider-connection-store.js';
import {
    createUserExecutorStore,
    ExecutorDefaultProtectedError,
    ExecutorIdentityError,
    ExecutorSuspendedError,
    type ExecutorDefault,
    type ResolvedDefault,
    type UserExecutorStore,
} from '../src/db/user-executor-store.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';
import { testSecretDeps } from './env-secrets-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: UserExecutorStore;

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;
const ABSENT = randomUUID();

const db = useTestDb({
    orgs: [ORG],
    users: [ALICE_USER, BOB_USER],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
});

describe.skipIf(!enabled)('the user executor store', () => {
    it('accepts an opencode executor at the row', async () => {
        // 013 rewrote user_executor_type_ck to add opencode; this is the check at the row, the
        // same way user-repo-store.test.ts asserts its name rules.
        await store.replace(ALICE, [{ name: 'main', type: 'opencode', config: { model: 'x' } }]);

        expect(await store.list(ALICE)).toEqual([expect.objectContaining({ name: 'main', type: 'opencode' })]);
    });

    it.each<{ name: string; insert: () => Promise<unknown>; check: RegExp }>([
        {
            name: 'still refuses a type outside the list',
            insert: () => sql`
                insert into executor_profile (org_id, user_id, name, type, config)
                values (${ORG}, ${ALICE}, 'x', 'codex', '{}'::jsonb)
            `,
            check: /user_executor_type_ck/,
        },
        ...[-1, 11].map((rounds) => ({
            name: `refuses a gate_fix_rounds outside 0..10 at the row (${rounds})`,
            insert: () => sql`
                insert into executor_profile (org_id, user_id, name, type, config, gate_fix_rounds)
                values (${ORG}, ${ALICE}, 'main', 'claude-code', '{}'::jsonb, ${rounds})
            `,
            check: /user_executor_gate_fix_rounds_ck/,
        })),
    ])('$name', async ({ insert, check }) => {
        await expect(insert()).rejects.toThrow(check);
    });

    it('answers the pasted config for a named row, and null when no row matches', async () => {
        const config = { model: 'zai-coding-plan/glm-5.3-flash', provider: { 'zai-coding-plan': {} } };
        await store.replace(ALICE, [{ name: 'main', type: 'opencode', config }]);

        expect(await store.configFor(ALICE, 'main')).toEqual({
            type: 'opencode',
            config,
            gateFixRounds: 3,
            suspended: false,
            runnerClass: null,
        });
        expect(await store.configFor(ALICE, 'deleted')).toBeNull();
        // Another member's row is not this member's answer.
        expect(await store.configFor(ABSENT, 'main')).toBeNull();
    });

    it('stores and lists gateFixRounds, the column default filling an omitted value', async () => {
        await store.replace(ALICE, [
            { name: 'main', type: 'claude-code', config: {} },
            { name: 'heavy', type: 'claude-code', config: {}, gateFixRounds: 7 },
        ]);

        expect(await store.list(ALICE)).toEqual([
            expect.objectContaining({ name: 'main', gateFixRounds: 3 }),
            expect.objectContaining({ name: 'heavy', gateFixRounds: 7 }),
        ]);
        expect(await store.listWithConfigs(ALICE)).toEqual([
            expect.objectContaining({ name: 'main', gateFixRounds: 3 }),
            expect.objectContaining({ name: 'heavy', gateFixRounds: 7 }),
        ]);
        // The claim-time read carries it too, though the claim itself ignores it — the default
        // workflow's round limit freezes onto the thread at launch, never at claim.
        expect(await store.configFor(ALICE, 'heavy')).toEqual({
            type: 'claude-code',
            config: {},
            gateFixRounds: 7,
            suspended: false,
            runnerClass: null,
        });
    });

    it('reads whether a pasted config overrides a connection from the stored markers, on every list read', async () => {
        await store.replace(ALICE, [
            { name: 'plain', type: 'opencode', config: { model: 'anthropic/claude-sonnet-4-5' } },
            { name: 'keyed', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: 'sk-test-override' } } },
            { name: 'ref', type: 'opencode', config: { provider: { p: { options: { apiKey: '{env:MY_KEY}' } } } } },
            {
                name: 'endpoint',
                type: 'opencode',
                config: { provider: { p: { options: { baseURL: 'https://x.test' } } } },
            },
        ]);
        const flags = (rows: { name: string; configOverridesConnection?: boolean }[]) =>
            Object.fromEntries(rows.map((row) => [row.name, row.configOverridesConnection]));
        const expected = { plain: false, keyed: true, ref: true, endpoint: true };
        expect(flags(await store.list(ALICE))).toEqual(expected);
        expect(flags(await store.listWithConfigs(ALICE))).toEqual(expected);
        await store.createOrg({
            name: 'org-keyed',
            type: 'claude-code',
            config: { env: { ANTHROPIC_API_KEY: 'sk-test-org' } },
            createdBy: ALICE,
        });
        expect(flags(await store.listOrg())).toEqual({ 'org-keyed': true });
        expect(flags(await store.listOrgWithConfigs())).toEqual({ 'org-keyed': true });
    });

    /**
     * The list comes back in the order it was saved, and that is a stored `position` (041), not an
     * inference. It used to be inferred from `created_at asc, name asc`, which could never work:
     * `replace` is one transaction, postgres' `now()` is the transaction's start time, so every row
     * of a save carries the same created_at and the name tiebreak always decides. The list was
     * alphabetical whatever the member arranged — and the composer autoselects the resolved
     * default's first fallback, so the alphabetically-first row was the one new tasks silently ran
     * with.
     *
     * Saved deliberately in reverse alphabetical order: under the old ORDER BY this case comes back
     * exactly backwards, so it fails loudly rather than passing by coincidence.
     */
    it('lists in the order the member saved, not alphabetically', async () => {
        await store.replace(ALICE, [
            { name: 'zulu', type: 'claude-code', config: {} },
            { name: 'mike', type: 'claude-code', config: {} },
            { name: 'alpha', type: 'claude-code', config: {} },
        ]);

        expect((await store.list(ALICE)).map((executor) => executor.name)).toEqual(['zulu', 'mike', 'alpha']);
        // The edit dialog's read is the same list, so it must agree — it had its own copy of the
        // ORDER BY, and a fix to one that missed the other would reorder the dialog alone.
        expect((await store.listWithConfigs(ALICE)).map((executor) => executor.name)).toEqual([
            'zulu',
            'mike',
            'alpha',
        ]);
    });

    it('keys every personal row with a surrogate id that survives until the next replace', async () => {
        await store.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);

        const rows = await store.list(ALICE);
        expect(rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe.skipIf(!enabled)('organization-scoped executor profiles (issue 391)', () => {
    it('stores an org-scope row and lists it apart from any member’s personal rows', async () => {
        const created = await store.createOrg({
            name: 'team-runner',
            type: 'claude-code',
            config: { model: 'claude-sonnet-4-5' },
            createdBy: ALICE,
        });
        expect(created).toEqual(
            expect.objectContaining({ name: 'team-runner', type: 'claude-code', createdBy: ALICE })
        );
        expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

        const orgRows = await store.listOrg();
        expect(orgRows.map((row) => row.name)).toEqual(['team-runner']);
        // The org row belongs to the organization, not to its creator: it appears in no member's
        // personal list.
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual([]);
        expect((await store.list(BOB)).map((row) => row.name)).toEqual([]);
        // The creator is an audit fact, not an ownership: another admin may edit or delete it.
        expect((await store.listOrgWithConfigs())[0]).toEqual(
            expect.objectContaining({ name: 'team-runner', createdBy: ALICE, config: { model: 'claude-sonnet-4-5' } })
        );
    });

    it('allows the same name in both scopes and refuses a duplicate within one scope', async () => {
        await store.createOrg({ name: 'main', type: 'claude-code', config: {}, createdBy: ALICE });
        // The personal scope is a different ownership: the same name coexists.
        await store.replace(ALICE, [{ name: 'main', type: 'opencode', config: { model: 'personal' } }]);

        await expect(
            store.createOrg({ name: 'main', type: 'claude-code', config: {}, createdBy: ALICE })
        ).rejects.toThrow(/executor_profile_name_uk/);
        // Within the personal scope the owner is the uniqueness: ALICE cannot hold 'main' twice,
        // while BOB's own 'main' is a different ownership and stays legal.
        await expect(
            sql`
                insert into executor_profile (org_id, user_id, name, type, config)
                values (${ORG}, ${ALICE}, 'main', 'claude-code', '{}'::jsonb)
            `
        ).rejects.toThrow(/executor_profile_name_uk/);
        await store.replace(BOB, [{ name: 'main', type: 'claude-code', config: {} }]);
    });

    it('resolves configFor in the stamped scope only — same name, two rows, no silent switch', async () => {
        await store.replace(ALICE, [{ name: 'main', type: 'opencode', config: { model: 'personal' } }]);
        await store.createOrg({ name: 'main', type: 'claude-code', config: { model: 'shared' }, createdBy: ALICE });

        expect((await store.configFor(ALICE, 'main', 'user'))?.config).toEqual({ model: 'personal' });
        expect((await store.configFor(ALICE, 'main', 'org'))?.config).toEqual({ model: 'shared' });
        // The org row resolves for ANY member of the organization — that is the feature.
        expect((await store.configFor(BOB, 'main', 'org'))?.config).toEqual({ model: 'shared' });
        // A personal row never resolves for another member, whatever its name.
        expect(await store.configFor(BOB, 'main', 'user')).toBeNull();
    });

    it('replaces only the caller’s personal rows; org rows survive a personal PUT', async () => {
        await store.createOrg({ name: 'shared', type: 'claude-code', config: { model: 'shared' }, createdBy: ALICE });
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);

        await store.replace(ALICE, [{ name: 'other', type: 'claude-code', config: {} }]);

        expect((await store.list(ALICE)).map((row) => row.name)).toEqual(['other']);
        expect((await store.listOrg()).map((row) => row.name)).toEqual(['shared']);
    });

    it('edits, renames and deletes an org row by id, and counts them for the cap', async () => {
        const created = await store.createOrg({
            name: 'team',
            type: 'claude-code',
            config: {},
            createdBy: ALICE,
        });

        const renamed = await store.updateOrg(created.id, { name: 'team-runner', config: { model: 'm' } });
        expect(renamed).toEqual(expect.objectContaining({ name: 'team-runner', config: { model: 'm' } }));

        const rows = await store.listOrg();
        expect(rows.map((row) => row.name)).toEqual(['team-runner']);
        expect(await store.orgCount()).toBe(1);

        expect(await store.deleteOrg(created.id)).toBe(true);
        expect(await store.orgCount()).toBe(0);
        expect(await store.deleteOrg(created.id)).toBe(false);
    });

    it('updateOrg answers null for an id that is not an org row of this organization', async () => {
        await store.replace(ALICE, [{ name: 'personal', type: 'claude-code', config: {} }]);
        const personal = (await store.listWithConfigs(ALICE))[0]!;
        // A personal row is not addressable through the org CRUD surface — the scopes are
        // different ownerships, and the route layer only ever sends org ids here.
        expect(await store.updateOrg(personal.id, { name: 'hijack' })).toBeNull();
        expect(await store.deleteOrg(personal.id)).toBe(false);
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual(['personal']);
    });

    it('promotes the caller’s own personal row to org scope and demotes back', async () => {
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: { model: 'm' } }]);
        const personal = (await store.list(ALICE))[0]!;

        const promoted = await store.changeScope(personal.id, 'org', ALICE);
        expect(promoted).toEqual(expect.objectContaining({ name: 'mine', createdBy: ALICE }));
        expect((await store.listOrg()).map((row) => row.name)).toEqual(['mine']);
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual([]);

        const orgRow = (await store.listOrg())[0]!;
        const demoted = await store.changeScope(orgRow.id, 'user', ALICE);
        expect(demoted).toEqual(expect.objectContaining({ name: 'mine' }));
        expect((await store.listOrg()).map((row) => row.name)).toEqual([]);
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual(['mine']);
    });

    it('changeScope only moves the caller’s own personal row up', async () => {
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);
        await store.replace(BOB, [{ name: 'theirs', type: 'claude-code', config: {} }]);
        const aliceRow = (await store.list(ALICE))[0]!;
        const bobRow = (await store.list(BOB))[0]!;

        // Alice cannot promote Bob's row through the scope route — and Bob's row is untouched.
        expect(await store.changeScope(bobRow.id, 'org', ALICE)).toBeNull();
        expect((await store.list(BOB)).map((row) => row.name)).toEqual(['theirs']);
        expect(await store.changeScope(aliceRow.id, 'org', ALICE)).not.toBeNull();
    });

    it('refuses a scope change whose target name is taken in that scope', async () => {
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);
        await store.createOrg({ name: 'mine', type: 'claude-code', config: {}, createdBy: ALICE });
        const personal = (await store.list(ALICE))[0]!;

        // The org scope already holds "mine" — promoting would collide with the name index.
        await expect(store.changeScope(personal.id, 'org', ALICE)).rejects.toThrow(/executor_profile_name_uk/);
        // Nothing moved.
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual(['mine']);
    });

    it("stores and returns an org profile's runnerClass", async () => {
        const created = await store.createOrg({
            name: 'sandboxed',
            type: 'claude-code',
            config: {},
            runnerClass: 'kata',
            createdBy: ALICE,
        });
        expect(created.runnerClass).toBe('kata');
        expect((await store.listOrg())[0]?.runnerClass).toBe('kata');
        expect((await store.listOrgWithConfigs())[0]?.runnerClass).toBe('kata');
        // The claim-time read carries it, for any member selecting the org row.
        expect((await store.configFor(BOB, 'sandboxed', 'org'))?.runnerClass).toBe('kata');

        // An edit that does not name the class keeps it; an explicit null clears it.
        expect((await store.updateOrg(created.id, { config: { model: 'm' } }))?.runnerClass).toBe('kata');
        expect((await store.updateOrg(created.id, { runnerClass: null }))?.runnerClass).toBeNull();
        expect((await store.configFor(BOB, 'sandboxed', 'org'))?.runnerClass).toBeNull();

        // A profile created without one names no class: the driver's default.
        const plain = await store.createOrg({ name: 'plain', type: 'claude-code', config: {}, createdBy: ALICE });
        expect(plain.runnerClass).toBeNull();
    });

    it('never stores a runnerClass on a personal row: a demotion clears it and the row check refuses one', async () => {
        const created = await store.createOrg({
            name: 'sandboxed',
            type: 'claude-code',
            config: {},
            runnerClass: 'kata',
            createdBy: ALICE,
        });
        const demoted = await store.changeScope(created.id, 'user', ALICE);
        expect(demoted?.runnerClass).toBeNull();
        expect((await store.list(ALICE))[0]?.runnerClass).toBeNull();
        expect((await store.configFor(ALICE, 'sandboxed', 'user'))?.runnerClass).toBeNull();

        await expect(
            sql`
                insert into executor_profile (org_id, user_id, name, type, config, runner_class)
                values (${ORG}, ${BOB}, 'personal', 'claude-code', '{}'::jsonb, 'kata')
            `
        ).rejects.toThrow(/executor_profile_runner_class_ck/);
    });
});

describe.skipIf(!enabled)('removing and suspending profiles by id (issue 440)', () => {
    it('removes only the caller’s own personal row; another member’s, an org row and an unknown id match nothing', async () => {
        await store.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await store.replace(BOB, [{ name: 'main', type: 'claude-code', config: {} }]);
        const org = await store.createOrg({ name: 'main', type: 'claude-code', config: {}, createdBy: ALICE });
        const alice = (await store.list(ALICE))[0]!;
        const bob = (await store.list(BOB))[0]!;

        expect(await store.removePersonal(BOB, alice.id)).toBe(false);
        expect(await store.removePersonal(ALICE, org.id)).toBe(false);
        expect(await store.removePersonal(ALICE, ABSENT)).toBe(false);
        expect(await store.removePersonal(ALICE, alice.id)).toBe(true);

        expect(await store.list(ALICE)).toEqual([]);
        expect((await store.list(BOB)).map((row) => row.id)).toEqual([bob.id]);
        expect((await store.listOrg()).map((row) => row.id)).toEqual([org.id]);
    });

    it('suspends and resumes by id with the same ownership boundary, keeping config and ownership', async () => {
        await store.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { model: 'x' } }]);
        const org = await store.createOrg({ name: 'main', type: 'claude-code', config: {}, createdBy: ALICE });
        const mine = (await store.list(ALICE))[0]!;

        expect(await store.setPersonalSuspended(BOB, mine.id, true)).toBeNull();
        expect(await store.setPersonalSuspended(ALICE, org.id, true)).toBeNull();
        expect(await store.setOrgSuspended(mine.id, true)).toBeNull();
        expect((await store.list(ALICE))[0]!.suspended).toBe(false);

        expect((await store.setPersonalSuspended(ALICE, mine.id, true))?.suspended).toBe(true);
        expect((await store.setOrgSuspended(org.id, true))?.suspended).toBe(true);
        // Same-name scope isolation: each scope's flag is its own, and the config survives.
        expect(await store.configFor(ALICE, 'main', 'user')).toMatchObject({ config: { model: 'x' }, suspended: true });
        expect(await store.configFor(ALICE, 'main', 'org')).toMatchObject({ suspended: true });
        await store.setPersonalSuspended(ALICE, mine.id, false);
        expect((await store.configFor(ALICE, 'main', 'user'))?.suspended).toBe(false);
        expect((await store.configFor(ALICE, 'main', 'org'))?.suspended).toBe(true);
    });

    it('keeps a row suspended through a whole-list replace, and lets an entry say otherwise', async () => {
        await store.replace(ALICE, [
            { name: 'a', type: 'claude-code', config: {} },
            { name: 'b', type: 'claude-code', config: {} },
        ]);
        await store.setPersonalSuspended(ALICE, (await store.list(ALICE))[0]!.id, true);

        await store.replace(ALICE, [
            { name: 'a', type: 'claude-code', config: {}, gateFixRounds: 2 },
            { name: 'b', type: 'claude-code', config: {} },
        ]);
        expect((await store.list(ALICE)).map((row) => [row.name, row.suspended])).toEqual([
            ['a', true],
            ['b', false],
        ]);

        await store.replace(ALICE, [
            { name: 'a2', type: 'claude-code', config: {}, suspended: true },
            { name: 'b', type: 'claude-code', config: {}, suspended: false },
        ]);
        expect((await store.list(ALICE)).map((row) => [row.name, row.suspended])).toEqual([
            ['a2', true],
            ['b', false],
        ]);
    });
});

describe.skipIf(!enabled)('the per-user default preference (issue 391)', () => {
    const pref = (scope: ExecutorDefault['scope'], name: string): ExecutorDefault => ({ scope, name });
    const profile = (scope: ExecutorDefault['scope'], name: string): ResolvedDefault => ({
        kind: 'profile',
        scope,
        name,
    });

    it('stores one preference per member and reads it back', async () => {
        await store.createOrg({ name: 'shared', type: 'claude-code', config: {}, createdBy: ALICE });
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);

        await store.setDefault(ALICE, pref('org', 'shared'));
        expect(await store.defaultOf(ALICE)).toEqual(pref('org', 'shared'));
        // Per-user: Alice's preference never becomes Bob's.
        expect(await store.defaultOf(BOB)).toBeNull();

        await store.setDefault(ALICE, pref('user', 'mine'));
        expect(await store.defaultOf(ALICE)).toEqual(pref('user', 'mine'));
    });

    /** Each row refuses every named preference, and neither refusal writes the preference row. */
    it.each<{
        name: string;
        suspend: boolean;
        prefs: ExecutorDefault[];
        error?: typeof ExecutorSuspendedError;
    }>([
        {
            name: 'refuses a preference naming no accessible profile in that scope',
            suspend: false,
            prefs: [pref('user', 'ghost'), pref('org', 'ghost')],
        },
        {
            name: 'refuses a suspended profile as the preference and writes nothing (issue 440)',
            suspend: true,
            prefs: [pref('user', 'mine')],
            error: ExecutorSuspendedError,
        },
    ])('$name', async ({ suspend, prefs, error }) => {
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);
        if (suspend) await store.setPersonalSuspended(ALICE, (await store.list(ALICE))[0]!.id, true);

        for (const preference of prefs) {
            const refused = expect(store.setDefault(ALICE, preference)).rejects;
            await (error === undefined ? refused.toThrow() : refused.toBeInstanceOf(error));
        }
        expect(await store.defaultOf(ALICE)).toBeNull();
    });

    it('falls back deterministically: stored preference, first personal row, first org row, null', async () => {
        await store.createOrg({ name: 'org-a', type: 'claude-code', config: {}, createdBy: ALICE });
        await store.createOrg({ name: 'org-b', type: 'claude-code', config: {}, createdBy: ALICE });
        await store.replace(ALICE, [
            { name: 'zulu', type: 'claude-code', config: {} },
            { name: 'alpha', type: 'claude-code', config: {} },
        ]);

        // No preference: first personal row by position, then first org row by position.
        expect(await store.resolvedDefault(ALICE)).toEqual(profile('user', 'zulu'));
        expect(await store.resolvedDefault(BOB)).toEqual(profile('org', 'org-a'));

        // A stored preference wins while it still resolves — either scope.
        await store.setDefault(ALICE, pref('org', 'org-b'));
        expect(await store.resolvedDefault(ALICE)).toEqual(profile('org', 'org-b'));

        // The preferred profile is removed: the chain answers from what remains.
        const orgB = (await store.listOrg()).find((row) => row.name === 'org-b')!;
        await store.deleteOrg(orgB.id);
        expect(await store.resolvedDefault(ALICE)).toEqual(profile('user', 'zulu'));

        await store.replace(ALICE, []);
        expect(await store.resolvedDefault(ALICE)).toEqual(profile('org', 'org-a'));

        const orgA = (await store.listOrg()).find((row) => row.name === 'org-a')!;
        await store.deleteOrg(orgA.id);
        expect(await store.resolvedDefault(ALICE)).toBeNull();
    });

    it('skips suspended rows in the chain but keeps the stored preference, so resuming restores it (issue 440)', async () => {
        await store.createOrg({ name: 'org-a', type: 'claude-code', config: {}, createdBy: ALICE });
        await store.replace(ALICE, [
            { name: 'first', type: 'claude-code', config: {} },
            { name: 'second', type: 'claude-code', config: {} },
        ]);
        await store.setDefault(ALICE, pref('user', 'second'));
        const byName = async (name: string) => (await store.list(ALICE)).find((row) => row.name === name)!;

        await store.setPersonalSuspended(ALICE, (await byName('second')).id, true);
        expect(await store.resolvedDefault(ALICE)).toEqual(profile('user', 'first'));
        await store.setPersonalSuspended(ALICE, (await byName('first')).id, true);
        expect(await store.resolvedDefault(ALICE)).toEqual(profile('org', 'org-a'));
        const orgA = (await store.listOrg())[0]!;
        await store.setOrgSuspended(orgA.id, true);
        expect(await store.resolvedDefault(ALICE)).toBeNull();

        // The stored preference never moved; resuming restores it.
        expect(await store.defaultOf(ALICE)).toEqual(pref('user', 'second'));
        await store.setPersonalSuspended(ALICE, (await byName('second')).id, false);
        expect(await store.resolvedDefault(ALICE)).toEqual(profile('user', 'second'));
    });

    it('keeps the old personal default shape working: replace() no longer takes a flag', async () => {
        // 040's is_default column is gone; the preference is the whole mechanism now.
        const columns = await sql<{ column_name: string }[]>`
            select column_name from information_schema.columns
            where table_name = 'executor_profile'
        `;
        expect(columns.map((c) => c.column_name)).not.toContain('is_default');
    });
});

describe.skipIf(!enabled)('the agent default', () => {
    const claude = { agentType: 'claude-code', model: 'claude-sonnet-4-5' } as const;
    const opencode = { agentType: 'opencode', model: 'anthropic/claude-sonnet-4-5' } as const;

    it('stores one org row and one row per member, overwrites in place and deletes by owner', async () => {
        expect(await store.agentDefaults(ALICE)).toEqual({ org: null, personal: null });

        await store.setAgentDefault(null, claude);
        await store.setAgentDefault(ALICE, opencode);
        expect(await store.agentDefaults(ALICE)).toEqual({ org: claude, personal: opencode });
        // Per member: Alice's personal default is never Bob's; the org row is everyone's.
        expect(await store.agentDefaults(BOB)).toEqual({ org: claude, personal: null });

        await store.setAgentDefault(ALICE, { agentType: 'claude-code', model: 'claude-opus-4-5' });
        expect((await store.agentDefaults(ALICE)).personal).toEqual({
            agentType: 'claude-code',
            model: 'claude-opus-4-5',
        });

        expect(await store.deleteAgentDefault(ALICE)).toBe(true);
        expect(await store.deleteAgentDefault(ALICE)).toBe(false);
        expect(await store.deleteAgentDefault(null)).toBe(true);
        expect(await store.agentDefaults(ALICE)).toEqual({ org: null, personal: null });
    });

    it('writes inside the caller’s transaction, and a rolled-back transaction writes nothing', async () => {
        await sql.begin((tx) => store.setAgentDefaultInTx(tx, ALICE, claude));
        expect((await store.agentDefaults(ALICE)).personal).toEqual(claude);

        await expect(
            sql.begin(async (tx) => {
                await store.setAgentDefaultInTx(tx, null, opencode);
                throw new Error('roll back');
            })
        ).rejects.toThrow('roll back');
        expect((await store.agentDefaults(ALICE)).org).toBeNull();
    });

    it('resolves in order: active preference, personal agent default, org agent default, first personal profile, first org profile, null', async () => {
        await store.createOrg({ name: 'org-a', type: 'claude-code', config: {}, createdBy: ALICE });
        await store.createOrg({ name: 'org-b', type: 'opencode', config: {}, createdBy: ALICE });
        await store.replace(ALICE, [{ name: 'zulu', type: 'claude-code', config: {} }]);
        await store.setDefault(ALICE, { scope: 'org', name: 'org-b' });
        await store.setAgentDefault(ALICE, opencode);
        await store.setAgentDefault(null, claude);

        // 1. The stored preference wins over both agent defaults and every profile.
        expect(await store.resolvedDefault(ALICE)).toEqual({ kind: 'profile', scope: 'org', name: 'org-b' });

        // A suspended preference is skipped to the personal agent default, not to a profile.
        const orgB = (await store.listOrg()).find((row) => row.name === 'org-b')!;
        await store.setOrgSuspended(orgB.id, true);
        // 2. The personal agent default wins over the org one and every profile.
        expect(await store.resolvedDefault(ALICE)).toEqual({ kind: 'agent', ...opencode, from: 'personal' });

        // 3. The org agent default wins over every profile; another member without a personal one gets it too.
        await store.deleteAgentDefault(ALICE);
        expect(await store.resolvedDefault(ALICE)).toEqual({ kind: 'agent', ...claude, from: 'org' });
        expect(await store.resolvedDefault(BOB)).toEqual({ kind: 'agent', ...claude, from: 'org' });

        // 4. The first active personal profile wins over the org profiles.
        await store.deleteAgentDefault(null);
        expect(await store.resolvedDefault(ALICE)).toEqual({ kind: 'profile', scope: 'user', name: 'zulu' });

        // 5. The first active org profile.
        await store.replace(ALICE, []);
        expect(await store.resolvedDefault(ALICE)).toEqual({ kind: 'profile', scope: 'org', name: 'org-a' });

        // 6. Nothing usable resolves to null.
        const orgA = (await store.listOrg()).find((row) => row.name === 'org-a')!;
        await store.setOrgSuspended(orgA.id, true);
        expect(await store.resolvedDefault(ALICE)).toBeNull();
    });
});

describe.skipIf(!enabled)('executor writes and the provider connection they select', () => {
    const connections = () => createProviderConnectionStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
    const connect = (over: Partial<Parameters<ReturnType<typeof connections>['create']>[0]> = {}) =>
        connections().create({
            scope: 'personal',
            userId: ALICE,
            provider: 'anthropic',
            name: `c-${randomUUID().slice(0, 8)}`,
            baseUrl: null,
            key: 'sk-ant-store-test-key',
            ...over,
        });
    const refusal = async (write: () => Promise<unknown>) => {
        const error = await write().then(
            () => null,
            (e: unknown) => e
        );
        expect(error).toBeInstanceOf(ExecutorConnectionRefusedError);
        return (error as ExecutorConnectionRefusedError).reason;
    };

    it('all writes enforce provider scope and compatibility', async () => {
        const mine = await connect();
        const bobs = await connect({ userId: BOB });
        const org = await connect({ scope: 'org' });
        const openai = await connect({ scope: 'org', provider: 'openai' });
        const personalOpenai = await connect({ provider: 'openai' });

        // Personal whole-list PUT: own and org connections pass; another member's, unsupported pairs and unknown ids do not.
        await store.replace(ALICE, [
            { name: 'a', type: 'claude-code', config: {}, providerConnectionId: mine.id },
            { name: 'b', type: 'opencode', config: {}, providerConnectionId: org.id },
        ]);
        expect((await store.list(ALICE)).map((row) => row.providerConnectionId)).toEqual([mine.id, org.id]);
        expect(
            await refusal(() =>
                store.replace(ALICE, [{ name: 'x', type: 'claude-code', config: {}, providerConnectionId: bobs.id }])
            )
        ).toBe('missing');
        expect(
            await refusal(() =>
                store.replace(ALICE, [{ name: 'x', type: 'claude-code', config: {}, providerConnectionId: openai.id }])
            )
        ).toBe('incompatible');
        expect(
            await refusal(() =>
                store.replace(ALICE, [{ name: 'x', type: 'opencode', config: {}, providerConnectionId: randomUUID() }])
            )
        ).toBe('missing');
        // A refused save leaves the list as it was.
        expect((await store.list(ALICE)).map((row) => row.name)).toEqual(['a', 'b']);

        // Org create/update: an org connection only.
        expect(
            await refusal(() =>
                store.createOrg({
                    name: 'o1',
                    type: 'claude-code',
                    config: {},
                    createdBy: ALICE,
                    providerConnectionId: mine.id,
                })
            )
        ).toBe('scope');
        const created = await store.createOrg({
            name: 'o2',
            type: 'claude-code',
            config: {},
            createdBy: ALICE,
            providerConnectionId: org.id,
        });
        expect(created.providerConnectionId).toBe(org.id);
        expect(
            await refusal(() =>
                store.updateOrg(created.id, { type: 'claude-code', providerConnectionId: personalOpenai.id })
            )
        ).toBe('scope');
        expect(await refusal(() => store.updateOrg(created.id, { providerConnectionId: openai.id }))).toBe(
            'incompatible'
        );
        // A type change alone is a selection write too: the connection stays, the pair must still hold.
        const subscription = await connect({ scope: 'org', provider: 'subscription' });
        const claudeOnly = await store.createOrg({
            name: 'o3',
            type: 'claude-code',
            config: {},
            createdBy: ALICE,
            providerConnectionId: subscription.id,
        });
        expect(await refusal(() => store.updateOrg(claudeOnly.id, { type: 'opencode' }))).toBe('incompatible');
    });

    it('promotion refuses a personal connection', async () => {
        const mine = await connect();
        const org = await connect({ scope: 'org' });
        await store.replace(ALICE, [
            { name: 'p-personal', type: 'claude-code', config: {}, providerConnectionId: mine.id },
            { name: 'p-org', type: 'claude-code', config: {}, providerConnectionId: org.id },
        ]);
        const [personal, shared] = await store.list(ALICE);

        expect(await refusal(() => store.changeScope(personal!.id, 'org', ALICE))).toBe('scope');
        expect((await store.changeScope(shared!.id, 'org', ALICE))?.providerConnectionId).toBe(org.id);
        // Demotion into a personal list: the org connection is visible there.
        expect((await store.changeScope(shared!.id, 'user', ALICE))?.providerConnectionId).toBe(org.id);
    });

    it('connection switching requires a valid or explicitly reselected model', async () => {
        const anthropic = await connect({ provider: 'anthropic' });
        const openai = await connect({ provider: 'openai' });
        await store.replace(ALICE, [
            {
                name: 'sw',
                type: 'opencode',
                config: { model: 'anthropic/claude-x' },
                providerConnectionId: anthropic.id,
            },
        ]);

        // Switching with a model the board knows belongs to the old provider is refused ...
        expect(
            await refusal(() =>
                store.replace(ALICE, [
                    {
                        name: 'sw',
                        type: 'opencode',
                        config: { model: 'anthropic/claude-x' },
                        providerConnectionId: openai.id,
                    },
                ])
            )
        ).toBe('model');
        // ... explicit reselection passes, and so does a model with no known prefix (discovery proves nothing).
        await store.replace(ALICE, [
            { name: 'sw', type: 'opencode', config: { model: 'openai/gpt-x' }, providerConnectionId: openai.id },
        ]);
        await store.replace(ALICE, [
            { name: 'sw', type: 'opencode', config: { model: 'house-model' }, providerConnectionId: anthropic.id },
        ]);
        // Re-saving the same connection does not re-judge the model.
        await store.replace(ALICE, [
            { name: 'sw', type: 'opencode', config: { model: 'openai/gpt-x' }, providerConnectionId: anthropic.id },
        ]);
    });

    it('a row with no connection is unchanged', async () => {
        await store.replace(ALICE, [{ name: 'plain', type: 'claude-code', config: { model: 'm' } }]);
        expect((await store.list(ALICE))[0]?.providerConnectionId).toBeNull();
        // The claim-time read omits the key entirely, so a profile without a connection reads exactly as it always did.
        expect(await store.configFor(ALICE, 'plain')).not.toHaveProperty('providerConnectionId');
    });
});

describe.skipIf(!enabled)('stable personal executor identities', () => {
    const connect = (over: Partial<Parameters<ReturnType<typeof createProviderConnectionStore>['create']>[0]> = {}) =>
        createProviderConnectionStore({ sql, orgId: ORG, ...testSecretDeps(sql) }).create({
            scope: 'personal',
            userId: ALICE,
            provider: 'anthropic',
            name: `c-${randomUUID().slice(0, 8)}`,
            baseUrl: null,
            key: 'sk-ant-store-test-key',
            ...over,
        });
    const idsByName = async (userId: string) => new Map((await store.list(userId)).map((row) => [row.name, row.id]));

    it('whole-list saves preserve surviving executor IDs', async () => {
        await store.replace(ALICE, [
            { name: 'a', type: 'claude-code', config: {} },
            { name: 'b', type: 'claude-code', config: {} },
        ]);
        const before = await idsByName(ALICE);
        const created = (await store.list(ALICE)).map((row) => row.createdAt);

        // Reordered, one omitted, one new: the survivors keep their identity, by name when no id is sent.
        await store.replace(ALICE, [
            { name: 'b', type: 'claude-code', config: {} },
            { name: 'c', type: 'claude-code', config: {} },
        ]);
        const after = await idsByName(ALICE);
        expect(after.get('b')).toBe(before.get('b'));
        expect(after.get('c')).toBeDefined();
        expect(after.get('c')).not.toBe(before.get('a'));
        expect([...after.keys()]).toEqual(['b', 'c']);
        expect((await store.list(ALICE))[0]!.createdAt).toBe(created[1]);

        // And by explicit id, whatever the name says.
        await store.replace(ALICE, [{ id: after.get('b')!, name: 'b', type: 'claude-code', config: {} }]);
        expect((await idsByName(ALICE)).get('b')).toBe(before.get('b'));
    });

    it('rename by ID preserves connection and default references', async () => {
        const connection = await connect();
        await store.replace(ALICE, [
            { name: 'main', type: 'claude-code', config: {}, providerConnectionId: connection.id },
        ]);
        const [row] = await store.list(ALICE);
        await store.selectDefault(ALICE, row!.id);

        await store.replace(ALICE, [{ id: row!.id, name: 'renamed', type: 'claude-code', config: {} }]);

        const [renamed] = await store.list(ALICE);
        expect(renamed).toMatchObject({ id: row!.id, name: 'renamed', providerConnectionId: connection.id });
        expect(await store.selectedDefault(ALICE)).toMatchObject({ executorId: row!.id, name: 'renamed' });
        expect(await store.resolvedDefault(ALICE)).toMatchObject({ kind: 'profile', scope: 'user', name: 'renamed' });
    });

    it('swaps two names by ID in one save', async () => {
        await store.replace(ALICE, [
            { name: 'a', type: 'claude-code', config: {} },
            { name: 'b', type: 'claude-code', config: {} },
        ]);
        const ids = await idsByName(ALICE);
        await store.replace(ALICE, [
            { id: ids.get('a')!, name: 'b', type: 'claude-code', config: {} },
            { id: ids.get('b')!, name: 'a', type: 'claude-code', config: {} },
        ]);
        const swapped = await idsByName(ALICE);
        expect(swapped.get('b')).toBe(ids.get('a'));
        expect(swapped.get('a')).toBe(ids.get('b'));
    });

    it('rejects another owners executor ID', async () => {
        await store.replace(ALICE, [{ name: 'mine', type: 'claude-code', config: {} }]);
        await store.replace(BOB, [{ name: 'his', type: 'claude-code', config: {} }]);
        const org = await store.createOrg({ name: 'shared', type: 'claude-code', config: {}, createdBy: ALICE });
        const [mine] = await store.list(ALICE);
        const [his] = await store.list(BOB);

        for (const foreign of [mine!.id, org.id, randomUUID()]) {
            await expect(
                store.replace(BOB, [{ id: foreign, name: 'his', type: 'claude-code', config: {} }])
            ).rejects.toBeInstanceOf(ExecutorIdentityError);
        }
        // The same id twice in one body is a duplicate identity.
        await expect(
            store.replace(BOB, [
                { id: his!.id, name: 'his', type: 'claude-code', config: {} },
                { id: his!.id, name: 'other', type: 'claude-code', config: {} },
            ])
        ).rejects.toBeInstanceOf(ExecutorIdentityError);
        // Nothing moved.
        expect((await store.list(BOB)).map((row) => row.id)).toEqual([his!.id]);
        expect((await store.list(ALICE)).map((row) => row.id)).toEqual([mine!.id]);
    });

    it('omitting a configured default refuses until explicitly replaced or cleared', async () => {
        await store.replace(ALICE, [
            { name: 'a', type: 'claude-code', config: {} },
            { name: 'b', type: 'claude-code', config: {} },
        ]);
        const ids = await idsByName(ALICE);
        await store.selectDefault(ALICE, ids.get('a')!);

        await expect(store.replace(ALICE, [{ name: 'b', type: 'claude-code', config: {} }])).rejects.toBeInstanceOf(
            ExecutorDefaultProtectedError
        );
        await expect(store.removePersonal(ALICE, ids.get('a')!)).rejects.toBeInstanceOf(ExecutorDefaultProtectedError);
        // The refused saves left both rows and the selection.
        expect([...(await idsByName(ALICE)).keys()]).toEqual(['a', 'b']);
        expect(await store.selectedDefault(ALICE)).toMatchObject({ executorId: ids.get('a') });

        // Replaced explicitly, the old row may go.
        await store.selectDefault(ALICE, ids.get('b')!);
        await store.replace(ALICE, [{ name: 'b', type: 'claude-code', config: {} }]);
        expect([...(await idsByName(ALICE)).keys()]).toEqual(['b']);

        // Or cleared.
        await store.clearDefault(ALICE);
        await store.replace(ALICE, []);
        expect(await store.list(ALICE)).toEqual([]);
        expect(await store.selectedDefault(ALICE)).toBeNull();
    });
});
