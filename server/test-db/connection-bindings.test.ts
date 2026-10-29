import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
    addBindingsInTx,
    applyResolutionInTx,
    bindingsOf,
    requirementsOf,
    resolveBindingsInTx,
} from '../src/db/connection-bindings.js';
import { createConnectionStore, type ConnectionStore } from '../src/db/connection-store.js';
import { useTestDb } from './harness.js';
import { legacyConnection, oauthConnection, testOrg, testUser } from './fixtures.js';

/** BEL-59: how a task's connections are chosen (explicit, personal default, requirement) and how they grow. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const ALICE = testUser('bind-alice');
const BOB = testUser('bind-bob');

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [ALICE, BOB] });

let sql: Sql;
let store: ConnectionStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createConnectionStore({ sql, orgId: ORG });
});

const connect = (orgId: string, ownerUserId: string, account = `a-${randomUUID()}@example.com`) =>
    oauthConnection(sql, orgId, ownerUserId, { account });

/** A root thread row authored by `userId`; the 094 trigger stamps its execution user. */
async function root(userId: string, orgId = ORG): Promise<string> {
    const id = randomUUID();
    await sql`insert into job (org_id, id, command, root_job_id, created_by) values (${orgId}, ${id}, 'work', ${id}, ${userId})`;
    return id;
}

const resolve = (
    userId: string,
    explicit: string[] = [],
    opts: { providers?: string[]; required?: string[]; orgId?: string } = {}
) =>
    sql.begin((tx) =>
        resolveBindingsInTx(tx, {
            orgId: opts.orgId ?? ORG,
            executionUser: userId,
            explicit,
            providers: opts.providers ?? ['jira'],
            ...(opts.required ? { required: opts.required } : {}),
        })
    );

interface AddArgs {
    rootJobId: string;
    actor: string;
    expectedRevision: number;
    connectionIds: string[];
    source?: 'follow_up' | 'requirement';
}

const add = ({ rootJobId, actor, expectedRevision, connectionIds, source = 'follow_up' }: AddArgs) =>
    sql.begin((tx) =>
        addBindingsInTx(tx, {
            orgId: ORG,
            rootJobId,
            expectedRevision,
            connectionIds,
            actor: { userId: actor },
            source,
        })
    );

describe.skipIf(!enabled)('resolving a task connections', () => {
    it('an explicit binding wins over the default', async () => {
        const dflt = await connect(ORG, ALICE.id);
        const explicit = await connect(ORG, ALICE.id);
        const result = await resolve(ALICE.id, [explicit.id]);
        expect(result).toMatchObject({ ok: true, requirements: [] });
        if (!result.ok) return;
        expect(result.bindings.map((b) => [b.connectionId, b.source])).toEqual([[explicit.id, 'explicit']]);
        expect(result.bindings.map((b) => b.connectionId)).not.toContain(dflt.id);
    });

    it('a single own candidate binds as the default', async () => {
        const lonely = await newUser('lonely');
        const mine = await connect(ORG, lonely);
        const result = await resolve(lonely);
        expect(result).toMatchObject({ ok: true, requirements: [] });
        if (!result.ok) return;
        expect(result.bindings).toEqual([
            expect.objectContaining({
                connectionId: mine.id,
                source: 'default',
                provider: 'jira',
                credential: 'oauth_grant',
            }),
        ]);
    });

    it('two own candidates bind nothing and record an ambiguous requirement', async () => {
        const user = await newUser('two');
        await connect(ORG, user);
        await connect(ORG, user);
        expect(await resolve(user)).toEqual({
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'ambiguous' }],
        });
    });

    it('no candidate records a missing requirement', async () => {
        const user = await newUser('none');
        expect(await resolve(user)).toEqual({
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'missing' }],
        });
    });

    it('a provider no skill requires binds a default but never records a requirement', async () => {
        const none = await newUser('optional');
        expect(await resolve(none, [], { required: [] })).toEqual({ ok: true, bindings: [], requirements: [] });
        const some = await newUser('optional-bound');
        const mine = await connect(ORG, some);
        const result = await resolve(some, [], { required: [] });
        expect(result).toMatchObject({ ok: true, requirements: [] });
        if (result.ok) expect(result.bindings.map((b) => b.connectionId)).toEqual([mine.id]);
    });

    it('an explicit id owned by another member is refused not-authorized, a disconnected one too', async () => {
        const theirs = await connect(ORG, BOB.id);
        expect(await resolve(ALICE.id, [theirs.id])).toEqual({ ok: false, reason: 'not-authorized' });
        const mine = await connect(ORG, ALICE.id);
        await store.disconnect(mine.id, { userId: ALICE.id });
        expect(await resolve(ALICE.id, [mine.id])).toEqual({ ok: false, reason: 'not-authorized' });
    });

    it('an explicit id from another org is refused', async () => {
        const foreign = await connect(OTHER_ORG, ALICE.id);
        expect(await resolve(ALICE.id, [foreign.id])).toEqual({ ok: false, reason: 'not-authorized' });
        expect(await resolve(ALICE.id, [randomUUID()])).toEqual({ ok: false, reason: 'not-authorized' });
    });

    it('a legacy API-token connection is never bound or defaulted, org-wide or personal', async () => {
        const user = await newUser('legacy');
        const orgWide = await legacyConnection(sql, ORG, null);
        const personal = await legacyConnection(sql, ORG, user);
        expect(await resolve(user)).toMatchObject({ ok: true, bindings: [], requirements: [{ reason: 'missing' }] });
        expect(await resolve(user, [orgWide])).toEqual({ ok: false, reason: 'not-authorized' });
        expect(await resolve(user, [personal])).toEqual({ ok: false, reason: 'not-authorized' });
    });

    it('two connections for one provider are both bindable explicitly and addressable by id', async () => {
        const a = await connect(ORG, ALICE.id);
        const b = await connect(ORG, ALICE.id);
        const result = await resolve(ALICE.id, [a.id, b.id]);
        expect(result.ok && result.bindings.map((x) => x.connectionId).sort()).toEqual([a.id, b.id].sort());
    });

    it('refuses duplicate ids and unknown providers', async () => {
        const a = await connect(ORG, ALICE.id);
        expect(await resolve(ALICE.id, [a.id, a.id])).toEqual({ ok: false, reason: 'duplicate' });
        expect(await resolve(ALICE.id, [], { providers: ['github'] })).toEqual({
            ok: false,
            reason: 'unknown-provider',
        });
    });
});

async function newUser(label: string): Promise<string> {
    const user = testUser(`bind-${label}`);
    await sql`insert into app_user (id, github_user_id, github_login) values (${user.id}, ${user.githubUserId}, ${user.login})`;
    return user.id;
}

describe.skipIf(!enabled)('adding bindings to a thread', () => {
    it('applying a resolution freezes the bindings at revision 1 and stores the requirements', async () => {
        const user = await newUser('apply');
        const mine = await connect(ORG, user);
        const rootId = await root(user);
        const resolved = await resolve(user, [mine.id]);
        if (!resolved.ok) throw new Error('resolve refused');
        await sql.begin((tx) =>
            applyResolutionInTx(tx, { orgId: ORG, rootJobId: rootId, addedBy: user, resolution: resolved })
        );
        const bindings = await bindingsOf(sql, ORG, rootId);
        expect(bindings).toEqual([
            expect.objectContaining({
                connectionId: mine.id,
                revision: 1,
                source: 'explicit',
                provider: 'jira',
                live: true,
            }),
        ]);
        const [row] = await sql<{ binding_revision: number }[]>`select binding_revision from job where id = ${rootId}`;
        expect(row!.binding_revision).toBe(1);

        const other = await root(user);
        await sql.begin((tx) =>
            applyResolutionInTx(tx, {
                orgId: ORG,
                rootJobId: other,
                addedBy: user,
                resolution: { ok: true, bindings: [], requirements: [{ provider: 'jira', reason: 'missing' }] },
            })
        );
        expect(await requirementsOf(sql, ORG, other)).toEqual([
            expect.objectContaining({ provider: 'jira', reason: 'missing' }),
        ]);
        expect(await bindingsOf(sql, ORG, other)).toEqual([]);
    });

    it('a stale expected revision answers stale-revision and writes nothing', async () => {
        const user = await newUser('stale');
        const rootId = await root(user);
        const mine = await connect(ORG, user);
        expect(await add({ rootJobId: rootId, actor: user, expectedRevision: 7, connectionIds: [mine.id] })).toEqual({
            ok: false,
            reason: 'stale-revision',
        });
        expect(await bindingsOf(sql, ORG, rootId)).toEqual([]);
        const [row] = await sql<{ binding_revision: number }[]>`select binding_revision from job where id = ${rootId}`;
        expect(row!.binding_revision).toBe(0);
    });

    it('never removes or replaces earlier bindings: history is append-only and the revision increments', async () => {
        const user = await newUser('append');
        const rootId = await root(user);
        const first = await connect(ORG, user);
        const second = await connect(ORG, user);
        expect(await add({ rootJobId: rootId, actor: user, expectedRevision: 0, connectionIds: [first.id] })).toEqual({
            ok: true,
            revision: 1,
        });
        expect(await add({ rootJobId: rootId, actor: user, expectedRevision: 1, connectionIds: [second.id] })).toEqual({
            ok: true,
            revision: 2,
        });
        const bindings = await bindingsOf(sql, ORG, rootId);
        expect(bindings.map((b) => [b.connectionId, b.revision])).toEqual([
            [first.id, 1],
            [second.id, 2],
        ]);
        expect(await add({ rootJobId: rootId, actor: user, expectedRevision: 2, connectionIds: [first.id] })).toEqual({
            ok: false,
            reason: 'duplicate',
        });
    });

    it('an actor who is not the execution user is refused', async () => {
        const user = await newUser('owner');
        const rootId = await root(user);
        const bobs = await connect(ORG, BOB.id);
        expect(await add({ rootJobId: rootId, actor: BOB.id, expectedRevision: 0, connectionIds: [bobs.id] })).toEqual({
            ok: false,
            reason: 'not-execution-user',
        });
        expect(await bindingsOf(sql, ORG, rootId)).toEqual([]);
    });

    it('refuses a connection the execution user may not bind, and an unknown root', async () => {
        const user = await newUser('authz');
        const rootId = await root(user);
        const bobs = await connect(ORG, BOB.id);
        expect(await add({ rootJobId: rootId, actor: user, expectedRevision: 0, connectionIds: [bobs.id] })).toEqual({
            ok: false,
            reason: 'not-authorized',
        });
        expect(
            await add({ rootJobId: randomUUID(), actor: user, expectedRevision: 0, connectionIds: [bobs.id] })
        ).toEqual({ ok: false, reason: 'not-found' });
    });

    it('adding a binding satisfies the open requirement for that provider', async () => {
        const user = await newUser('satisfy');
        const rootId = await root(user);
        await sql.begin((tx) =>
            applyResolutionInTx(tx, {
                orgId: ORG,
                rootJobId: rootId,
                addedBy: user,
                resolution: { ok: true, bindings: [], requirements: [{ provider: 'jira', reason: 'missing' }] },
            })
        );
        expect(await requirementsOf(sql, ORG, rootId)).toHaveLength(1);
        const mine = await connect(ORG, user);
        expect(
            await add({
                rootJobId: rootId,
                actor: user,
                expectedRevision: 0,
                connectionIds: [mine.id],
                source: 'requirement',
            })
        ).toEqual({ ok: true, revision: 1 });
        expect(await requirementsOf(sql, ORG, rootId)).toEqual([]);
        const [row] = await sql<{ satisfied_revision: number | null }[]>`
            select satisfied_revision from job_integration_requirement where root_job_id = ${rootId}
        `;
        expect(row!.satisfied_revision).toBe(1);
    });

    it('a disconnected connection stays in the history as not live, with its frozen account', async () => {
        const user = await newUser('history');
        const rootId = await root(user);
        const mine = await connect(ORG, user, 'frozen@example.com');
        await add({ rootJobId: rootId, actor: user, expectedRevision: 0, connectionIds: [mine.id] });
        await store.disconnect(mine.id, { userId: user });
        expect(await bindingsOf(sql, ORG, rootId)).toEqual([
            expect.objectContaining({ connectionId: mine.id, externalAccountId: 'frozen@example.com', live: false }),
        ]);
    });
});
