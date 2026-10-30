import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConnectionStore } from '../src/db/connection-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim } from '../src/db/jobs/job-store-types.js';
import { createIntegrationRuntime } from '../src/integrations/integration-recovery.js';
import { jiraRegistration } from '../src/integrations/providers/jira.js';
import { contextOfSession } from '../src/integrations/trusted-context.js';
import { type FakeAtlassian, startFakeAtlassian } from '../test/fake-atlassian.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { bindConnections, lineageHarness, newRoot } from './integration-store-faults.js';
import {
    accountOf,
    begin,
    codeCalls,
    connectionsOf,
    grantsOf,
    hostOf,
    jiraRuntime,
    newTag,
    READ_SCOPE,
    resolveAs,
    script,
    WRITE_SCOPE,
} from './jira-rig.js';

/**
 * BEL-61 slice 2: the Jira connect flow end to end on a database. The real runtime is composed as main.ts does it,
 * with the real Jira hooks pointed at a scripted Atlassian: the only boundary faked.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('jira-alice');
const BOB = testUser('jira-bob');
const CAROL = testUser('jira-carol');
const db = useTestDb({ orgs: [ORG], users: [ALICE, BOB, CAROL], max: 14 });

let fake: FakeAtlassian;
beforeEach(async () => {
    if (enabled) fake = await startFakeAtlassian();
});
afterEach(async () => {
    if (enabled) await fake.close();
});

const authRow = async (id: string) =>
    (
        await db.sql<
            { status: string; failure: string | null; requested_access: string | null; expected_site: string | null }[]
        >`
            select status, failure, requested_access, expected_site from integration_authorization where id = ${id}
        `
    )[0]!;

describe.skipIf(!enabled)('jira authorization', () => {
    it('users A and B in one org connect their own Atlassian accounts; each list, and each binding, is their own', async () => {
        const [a, b] = [newTag(), newTag()];
        const runtime = jiraRuntime(db.sql, fake);
        script(fake, { tag: a });
        expect(await (await begin(runtime, ORG, ALICE.id)).complete()).toMatchObject({ ok: true });
        script(fake, { tag: b });
        expect(await (await begin(runtime, ORG, BOB.id)).complete()).toMatchObject({ ok: true });

        const store = createConnectionStore({ sql: db.sql, orgId: ORG });
        const aliceList = (await store.list(ALICE.id)).filter(
            (c) => c.site.endsWith(`-${a}.atlassian.net`) || c.site.endsWith(`-${b}.atlassian.net`)
        );
        const bobList = (await store.list(BOB.id)).filter(
            (c) => c.site.endsWith(`-${a}.atlassian.net`) || c.site.endsWith(`-${b}.atlassian.net`)
        );
        expect(aliceList.map((c) => [c.site, c.account])).toEqual([[hostOf(a, 'one'), `${a}@example.com`]]);
        expect(bobList.map((c) => [c.site, c.account])).toEqual([[hostOf(b, 'one'), `${b}@example.com`]]);

        const [connA] = await connectionsOf(db.sql, a);
        const [connB] = await connectionsOf(db.sql, b);
        const rootA = await newRoot(db.sql, ORG, ALICE.id);
        const rootB = await newRoot(db.sql, ORG, BOB.id);
        await bindConnections(db.sql, { orgId: ORG, rootJobId: rootA, userId: ALICE.id }, [connA!.id]);
        await bindConnections(db.sql, { orgId: ORG, rootJobId: rootB, userId: BOB.id }, [connB!.id]);
        expect(await resolveAs(runtime, ORG, ALICE.id, { rootJobId: rootA, connectionId: connA!.id })).toMatchObject({
            ok: true,
            credential: { accessToken: `${a}-access` },
        });
        expect(await resolveAs(runtime, ORG, BOB.id, { rootJobId: rootB, connectionId: connB!.id })).toMatchObject({
            ok: true,
            credential: { accessToken: `${b}-access` },
        });
        expect(await resolveAs(runtime, ORG, BOB.id, { rootJobId: rootA, connectionId: connA!.id })).toEqual({
            ok: false,
            outcome: { outcome: 'forbidden', reason: 'principal-mismatch' },
        });
    });

    it("A's callback with B's session consumes nothing and the state stays pending", async () => {
        const tag = newTag();
        script(fake, { tag });
        const runtime = jiraRuntime(db.sql, fake);
        const started = await begin(runtime, ORG, ALICE.id);
        const asBob = contextOfSession({ user: { id: BOB.id } }, ORG);
        expect(await started.complete({}, asBob)).toMatchObject({ ok: false, failure: 'state-mismatch' });
        expect(codeCalls(fake)).toBe(0);
        expect((await authRow(started.authorizationId)).status).toBe('pending');
        expect(await started.complete()).toMatchObject({ ok: true });
    });

    it('a replayed callback answers replayed and exchanges once', async () => {
        const tag = newTag();
        script(fake, { tag });
        const started = await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id);
        expect(await started.complete()).toMatchObject({ ok: true });
        expect(await started.complete()).toMatchObject({ ok: false, failure: 'replayed' });
        expect(codeCalls(fake)).toBe(1);
    });

    it('denied consent is failed/denied with no exchange', async () => {
        const tag = newTag();
        script(fake, { tag });
        const started = await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id);
        expect(await started.complete({ code: undefined, error: 'access_denied' })).toMatchObject({
            ok: false,
            failure: 'denied',
        });
        expect(codeCalls(fake)).toBe(0);
        expect(await authRow(started.authorizationId)).toMatchObject({ status: 'failed', failure: 'denied' });
    });

    it('an expected site absent from the accessible sites is site-mismatch: no grant, no connection, tokens dropped', async () => {
        const tag = newTag();
        script(fake, { tag, sites: ['one'] });
        const started = await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id, { site: hostOf(tag, 'gone') });
        expect(await started.complete()).toMatchObject({ ok: false, failure: 'site-mismatch' });
        expect(await authRow(started.authorizationId)).toMatchObject({
            status: 'failed',
            failure: 'site-mismatch',
            expected_site: hostOf(tag, 'gone'),
            requested_access: 'read',
        });
        expect(await grantsOf(db.sql, tag)).toHaveLength(0);
        expect(await connectionsOf(db.sql, tag)).toHaveLength(0);
        expect(codeCalls(fake)).toBe(1);
    });

    it('an expected site present among two makes exactly one connection, for that site', async () => {
        const tag = newTag();
        script(fake, { tag, sites: ['one', 'two'] });
        const started = await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id, {
            site: `https://${hostOf(tag, 'two')}/`,
        });
        expect(await started.complete()).toMatchObject({ ok: true });
        expect((await connectionsOf(db.sql, tag)).map((c) => c.site)).toEqual([hostOf(tag, 'two')]);
    });

    it('no expected site and two accessible sites make two connections under one grant', async () => {
        const tag = newTag();
        script(fake, { tag, sites: ['one', 'two'] });
        expect(await (await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id)).complete()).toMatchObject({ ok: true });
        const connections = await connectionsOf(db.sql, tag);
        expect(connections.map((c) => c.site)).toEqual([hostOf(tag, 'one'), hostOf(tag, 'two')]);
        expect(new Set(connections.map((c) => c.grant_id)).size).toBe(1);
        expect(await grantsOf(db.sql, tag)).toHaveLength(1);
    });

    it('write consent asked but a token without write:jira-work gives a read connection; the grant holds the token scope', async () => {
        const tag = newTag();
        script(fake, { tag, scope: READ_SCOPE });
        const started = await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id, { access: 'write' });
        expect(started.scopes).toContain('write:jira-work');
        expect(await started.complete()).toMatchObject({ ok: true });
        expect((await connectionsOf(db.sql, tag)).map((c) => c.access)).toEqual(['read']);
        expect((await grantsOf(db.sql, tag))[0]!.authority.scopes).toEqual(READ_SCOPE.split(' ').sort());
    });

    it("write consent granted gives a write connection; the grant authority is the token's scope, not the requested list", async () => {
        const tag = newTag();
        script(fake, { tag, scope: 'read:jira-work write:jira-work' });
        expect(
            await (await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id, { access: 'write' })).complete()
        ).toMatchObject({
            ok: true,
        });
        expect((await connectionsOf(db.sql, tag)).map((c) => c.access)).toEqual(['write']);
        expect((await grantsOf(db.sql, tag))[0]!.authority.scopes).toEqual(['read:jira-work', 'write:jira-work']);
    });

    it('a reconnect with a different Atlassian account is identity-mismatch and changes nothing; the claim is released', async () => {
        const [tag, other] = [newTag(), newTag()];
        const runtime = jiraRuntime(db.sql, fake);
        script(fake, { tag });
        await (await begin(runtime, ORG, ALICE.id)).complete();
        const [connection] = await connectionsOf(db.sql, tag);
        const before = await grantsOf(db.sql, tag);

        const reconnect = await begin(runtime, ORG, ALICE.id, { connectionId: connection!.id });
        script(fake, { tag: other });
        expect(await reconnect.complete()).toMatchObject({ ok: false, failure: 'identity-mismatch' });

        const after = await grantsOf(db.sql, tag);
        expect(after).toEqual(before);
        expect(after[0]!.lineage_claim).toBeNull();
        expect(await connectionsOf(db.sql, tag)).toEqual([connection]);
        expect(await grantsOf(db.sql, other)).toHaveLength(0);
    });

    it('a reconnect requests the existing write scope even when read access is asked', async () => {
        const tag = newTag();
        const runtime = jiraRuntime(db.sql, fake);
        script(fake, { tag, scope: WRITE_SCOPE });
        await (await begin(runtime, ORG, ALICE.id, { access: 'write' })).complete();
        const [connection] = await connectionsOf(db.sql, tag);

        const reconnect = await begin(runtime, ORG, ALICE.id, { connectionId: connection!.id, access: 'read' });
        expect(reconnect.scopes).toContain('write:jira-work');
        const fresh = await begin(runtime, ORG, BOB.id, { access: 'read' });
        expect(fresh.scopes).not.toContain('write:jira-work');
    });

    it('a write upgrade through a second connection of the same grant refuses an earlier read binding and serves a later one', async () => {
        const tag = newTag();
        const runtime = jiraRuntime(db.sql, fake);
        script(fake, { tag, sites: ['one', 'two'], scope: READ_SCOPE });
        await (await begin(runtime, ORG, ALICE.id)).complete();
        const [one, two] = await connectionsOf(db.sql, tag);
        const earlier = await newRoot(db.sql, ORG, ALICE.id);
        await bindConnections(db.sql, { orgId: ORG, rootJobId: earlier, userId: ALICE.id }, [one!.id]);

        script(fake, { tag, sites: ['one', 'two'], scope: WRITE_SCOPE });
        const upgrade = await begin(runtime, ORG, ALICE.id, { connectionId: two!.id, access: 'write' });
        expect(await upgrade.complete()).toMatchObject({ ok: true });

        const refused = await resolveAs(runtime, ORG, ALICE.id, { rootJobId: earlier, connectionId: one!.id });
        expect(refused).toEqual({ ok: false, outcome: { outcome: 'forbidden', reason: 'binding-ceiling-exceeded' } });
        expect(JSON.stringify(refused)).not.toContain(`${tag}-access`);

        const later = await newRoot(db.sql, ORG, ALICE.id);
        await bindConnections(db.sql, { orgId: ORG, rootJobId: later, userId: ALICE.id }, [one!.id]);
        const served = await resolveAs(runtime, ORG, ALICE.id, { rootJobId: later, connectionId: one!.id });
        expect(served).toMatchObject({ ok: true });
        if (served.ok) expect(served.credential.authority.scopes).toContain('write:jira-work');
    });

    it('an upgrade sets access write on every active connection of the grant, by reconnect and by a second connect', async () => {
        const tag = newTag();
        const runtime = jiraRuntime(db.sql, fake);
        script(fake, { tag, sites: ['one', 'two'], scope: READ_SCOPE });
        await (await begin(runtime, ORG, ALICE.id)).complete();
        const [one] = await connectionsOf(db.sql, tag);
        expect((await connectionsOf(db.sql, tag)).map((c) => c.access)).toEqual(['read', 'read']);

        script(fake, { tag, sites: ['one', 'two'], scope: WRITE_SCOPE });
        const reconnect = await begin(runtime, ORG, ALICE.id, { connectionId: one!.id, access: 'write' });
        expect(await reconnect.complete()).toMatchObject({ ok: true, connectionId: one!.id });
        expect((await connectionsOf(db.sql, tag)).map((c) => c.access)).toEqual(['write', 'write']);

        // A consent that comes back read-only narrows the grant, so every connection of it follows.
        script(fake, { tag, sites: ['one', 'two'], scope: READ_SCOPE });
        expect(await (await begin(runtime, ORG, ALICE.id)).complete()).toMatchObject({ ok: true });
        expect((await connectionsOf(db.sql, tag)).map((c) => c.access)).toEqual(['read', 'read']);
        script(fake, { tag, sites: ['one', 'two'], scope: WRITE_SCOPE });
        expect(await (await begin(runtime, ORG, ALICE.id, { access: 'write' })).complete()).toMatchObject({ ok: true });
        expect((await connectionsOf(db.sql, tag)).map((c) => c.access)).toEqual(['write', 'write']);
    });

    it('a reconnect attaches a site discovered since and keeps the connection it was started from', async () => {
        const tag = newTag();
        const runtime = jiraRuntime(db.sql, fake);
        script(fake, { tag, sites: ['one'] });
        await (await begin(runtime, ORG, ALICE.id)).complete();
        const [one] = await connectionsOf(db.sql, tag);

        script(fake, { tag, sites: ['one', 'two'] });
        const reconnect = await begin(runtime, ORG, ALICE.id, { connectionId: one!.id });
        expect(await reconnect.complete()).toMatchObject({ ok: true, connectionId: one!.id });
        const connections = await connectionsOf(db.sql, tag);
        expect(connections.map((c) => [c.site, c.status])).toEqual([
            [hostOf(tag, 'one'), 'active'],
            [hostOf(tag, 'two'), 'active'],
        ]);
        expect(connections.find((c) => c.site === hostOf(tag, 'one'))!.id).toBe(one!.id);
    });

    it('an explicit connect to a site disconnected earlier makes a new active connection for it, beside the other site', async () => {
        const tag = newTag();
        const runtime = jiraRuntime(db.sql, fake);
        script(fake, { tag, sites: ['one', 'two'] });
        await (await begin(runtime, ORG, ALICE.id)).complete();
        const [a, b] = await connectionsOf(db.sql, tag);
        await db.sql`update connector_connection set status = 'disconnected' where id = ${a!.id}`;

        const again = await begin(runtime, ORG, ALICE.id, { site: `https://${hostOf(tag, 'one')}/` });
        const done = await again.complete();
        expect(done).toMatchObject({ ok: true });
        const rows = await connectionsOf(db.sql, tag);
        const ofA = rows.filter((c) => c.site === hostOf(tag, 'one'));
        expect(ofA.map((c) => c.status).sort()).toEqual(['active', 'disconnected']);
        expect(ofA.find((c) => c.status === 'active')!.id).not.toBe(a!.id);
        expect(rows.find((c) => c.site === hostOf(tag, 'two'))).toMatchObject({ id: b!.id, status: 'active' });
    });

    it('a reconnect or an all-sites connect leaves a site disconnected earlier disconnected', async () => {
        const tag = newTag();
        const runtime = jiraRuntime(db.sql, fake);
        script(fake, { tag, sites: ['one', 'two'] });
        await (await begin(runtime, ORG, ALICE.id)).complete();
        const [a, b] = await connectionsOf(db.sql, tag);
        await db.sql`update connector_connection set status = 'disconnected' where id = ${a!.id}`;

        expect(await (await begin(runtime, ORG, ALICE.id, { connectionId: b!.id })).complete()).toMatchObject({
            ok: true,
            connectionId: b!.id,
        });
        expect(await (await begin(runtime, ORG, ALICE.id)).complete()).toMatchObject({ ok: true });
        const rows = await connectionsOf(db.sql, tag);
        expect(rows.map((c) => [c.id, c.status])).toEqual([
            [a!.id, 'disconnected'],
            [b!.id, 'active'],
        ]);
    });

    it('start is refused when Jira is not configured, and when the client is missing', async () => {
        const unconfigured = jiraRuntime(db.sql, fake, { configured: false });
        const ctx = contextOfSession({ user: { id: ALICE.id } }, ORG);
        expect(await unconfigured.flowOf(ORG).startAuthorization(ctx, { provider: 'jira' })).toEqual({
            ok: false,
            reason: 'unknown-provider',
        });
        const registration = jiraRegistration({
            clientId: 'client-1',
            clientSecret: 'client-secret-1',
            authorizeUrl: fake.authorizeUrl,
            tokenUrl: fake.tokenUrl,
            apiOrigin: fake.origin,
        });
        const noClient = createIntegrationRuntime({
            sql: db.sql,
            secrets: lineageHarness(db.sql).open(),
            providers: registration.providers,
            clients: () => undefined,
            callbackOrigin: 'https://board.example.test',
        });
        expect(await noClient.flowOf(ORG).startAuthorization(ctx, { provider: 'jira' })).toEqual({
            ok: false,
            reason: 'not-configured',
        });
    });

    it('start refuses a bad access and a bad site', async () => {
        const runtime = jiraRuntime(db.sql, fake);
        const ctx = contextOfSession({ user: { id: ALICE.id } }, ORG);
        const flow = runtime.flowOf(ORG);
        expect(await flow.startAuthorization(ctx, { provider: 'jira', access: 'admin' as never })).toEqual({
            ok: false,
            reason: 'bad-input',
        });
        expect(await flow.startAuthorization(ctx, { provider: 'jira', site: 'example.com' })).toEqual({
            ok: false,
            reason: 'bad-input',
        });
    });

    it('a queued root with an open jira requirement is bound by the existing bind route, not by the callback', async () => {
        const tag = newTag();
        const jobs = createJobStore({ sql: db.sql, orgId: ORG });
        const created = await jobs.create('do the work', CAROL.id, { repo: null, executor: null, skills: ['jira'] });
        if (typeof created === 'string') throw new Error(created);
        const drain = async (): Promise<string[]> => {
            const ids: string[] = [];
            for (
                let claim = (await jobs.claim('w', 60)) as Claim | null;
                claim;
                claim = (await jobs.claim('w', 60)) as Claim | null
            ) {
                ids.push(claim.id);
            }
            return ids;
        };
        expect(await drain()).not.toContain(created.id);

        script(fake, { tag });
        const runtime = jiraRuntime(db.sql, fake);
        expect(await (await begin(runtime, ORG, CAROL.id)).complete()).toMatchObject({ ok: true });
        const bindings = () =>
            db.sql`select 1 from job_connection_binding where org_id = ${ORG} and root_job_id = ${created.id}`;
        expect(await bindings()).toHaveLength(0);
        expect(await drain()).not.toContain(created.id);

        const [connection] = await connectionsOf(db.sql, tag);
        const [row] = await db.sql<{ rev: number }[]>`
            select binding_revision as rev from job where org_id = ${ORG} and id = ${created.id}
        `;
        expect(
            await jobs.bindConnection(created.id, { connectionId: connection!.id, bindingRevision: row!.rev }, CAROL.id)
        ).toMatchObject({ ok: true });
        expect(await drain()).toContain(created.id);
    });
    describe('with a jobId', () => {
        const jobs = () => createJobStore({ sql: db.sql, orgId: ORG });
        /** A running root of `userId` that asked for Jira with nothing to bind: an open runtime requirement. */
        const askedRoot = async (userId: string, target?: string) => {
            const created = await jobs().create('do the work', userId, { repo: null, executor: null });
            if (typeof created === 'string') throw new Error(created);
            const claim = (await jobs().claim('w', 60)) as Claim | null;
            if (claim?.id !== created.id) throw new Error('expected the new root to be claimed');
            expect(await jobs().requireConnection(claim.id, claim.leaseToken, 'jira', target)).toMatchObject({
                answer: 'waiting',
            });
            return claim;
        };
        const requirements = (id: string) =>
            db.sql<{ outcome: string | null; satisfied_at: Date | null }[]>`
                select outcome, satisfied_at from job_integration_requirement where root_job_id = ${id}
            `;
        const bindings = (id: string) =>
            db.sql<{ connection_id: string }[]>`
                select connection_id from job_connection_binding where org_id = ${ORG} and root_job_id = ${id}
            `;

        it('start stores the jobId on the authorization row; a malformed one is refused', async () => {
            const claim = await askedRoot(ALICE.id);
            const runtime = jiraRuntime(db.sql, fake);
            const started = await begin(runtime, ORG, ALICE.id, { jobId: claim.id });
            const [row] = await db.sql<{ bind_job_id: string | null }[]>`
                select bind_job_id from integration_authorization where id = ${started.authorizationId}
            `;
            expect(row!.bind_job_id).toBe(claim.id);
            await expect(begin(runtime, ORG, ALICE.id, { jobId: 'not-a-uuid' })).rejects.toThrow('bad-input');
        });

        it('the callback binds the new connection to the task and satisfies the open runtime requirement', async () => {
            const tag = newTag();
            const claim = await askedRoot(ALICE.id);
            script(fake, { tag });
            const done = await (await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id, { jobId: claim.id })).complete();
            expect(done).toMatchObject({ ok: true });
            const [connection] = await connectionsOf(db.sql, tag);
            expect((await bindings(claim.id)).map((b) => b.connection_id)).toEqual([connection!.id]);
            expect(await requirements(claim.id)).toMatchObject([{ outcome: 'bound' }]);
        });

        it('an authorization that discovers several sites binds none and leaves the requirement open as ambiguous', async () => {
            const tag = newTag();
            const claim = await askedRoot(ALICE.id);
            script(fake, { tag, sites: ['one', 'two'] });
            const done = await (await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id, { jobId: claim.id })).complete();
            expect(done).toMatchObject({ ok: true });
            expect(await connectionsOf(db.sql, tag)).toHaveLength(2);
            expect(await bindings(claim.id)).toEqual([]);
            const rows = await db.sql<{ reason: string; satisfied_at: Date | null }[]>`
                select reason, satisfied_at from job_integration_requirement where root_job_id = ${claim.id}
            `;
            expect(rows).toMatchObject([{ reason: 'ambiguous', satisfied_at: null }]);
        });

        it('a connection that does not match the requirement target is made but not bound; one that does is bound', async () => {
            const tag = newTag();
            const miss = await askedRoot(ALICE.id, hostOf(tag, 'two'));
            script(fake, { tag, sites: ['one'] });
            expect(
                await (await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id, { jobId: miss.id })).complete()
            ).toMatchObject({ ok: true });
            expect(await bindings(miss.id)).toEqual([]);
            expect(await requirements(miss.id)).toMatchObject([{ outcome: null }]);

            const tag2 = newTag();
            const hit = await askedRoot(CAROL.id, hostOf(tag2, 'one'));
            script(fake, { tag: tag2, sites: ['one'] });
            await (await begin(jiraRuntime(db.sql, fake), ORG, CAROL.id, { jobId: hit.id })).complete();
            expect(await bindings(hit.id)).toHaveLength(1);
            expect(await requirements(hit.id)).toMatchObject([{ outcome: 'bound' }]);
        });

        it('two made connections, one matching the requirement target: binds it, no ambiguous flip', async () => {
            const tag = newTag();
            const claim = await askedRoot(ALICE.id, hostOf(tag, 'two'));
            script(fake, { tag, sites: ['one', 'two'] });
            await (await begin(jiraRuntime(db.sql, fake), ORG, ALICE.id, { jobId: claim.id })).complete();
            expect(await bindings(claim.id)).toHaveLength(1);
            expect(await requirements(claim.id)).toMatchObject([{ outcome: 'bound' }]);
        });

        it('a refused bind (another user is the execution user) still completes the connection', async () => {
            const tag = newTag();
            const claim = await askedRoot(CAROL.id);
            script(fake, { tag });
            const done = await (await begin(jiraRuntime(db.sql, fake), ORG, BOB.id, { jobId: claim.id })).complete();
            expect(done).toMatchObject({ ok: true });
            expect(await connectionsOf(db.sql, tag)).toHaveLength(1);
            expect(await bindings(claim.id)).toHaveLength(0);
            expect(await requirements(claim.id)).toMatchObject([{ outcome: null }]);
        });

        it('a reconnect with jobId leaves the binding usable and satisfies a reconnect requirement', async () => {
            const tag = newTag();
            const runtime = jiraRuntime(db.sql, fake);
            script(fake, { tag });
            await (await begin(runtime, ORG, ALICE.id)).complete();
            const [connection] = await connectionsOf(db.sql, tag);
            const created = await jobs().create('do the work', ALICE.id, { repo: null, executor: null });
            if (typeof created === 'string') throw new Error(created);
            const [rev] = await db.sql<{ rev: number }[]>`
                select binding_revision as rev from job where id = ${created.id}
            `;
            expect(
                await jobs().bindConnection(
                    created.id,
                    { connectionId: connection!.id, bindingRevision: rev!.rev },
                    ALICE.id
                )
            ).toMatchObject({ ok: true });
            const claim = (await jobs().claim('w', 60)) as Claim | null;
            if (claim?.id !== created.id) throw new Error('expected the new root to be claimed');
            await db.sql`
                update integration_grant set status = 'reconnect_required' where external_account_id = ${accountOf(tag)}
            `;
            expect(await jobs().requireConnection(claim.id, claim.leaseToken, 'jira')).toMatchObject({
                answer: 'waiting',
            });

            const reconnect = await begin(runtime, ORG, ALICE.id, { connectionId: connection!.id, jobId: claim.id });
            expect(await reconnect.complete()).toMatchObject({ ok: true, connectionId: connection!.id });

            expect(await requirements(claim.id)).toMatchObject([{ outcome: 'bound' }]);
            expect(
                await resolveAs(runtime, ORG, ALICE.id, { rootJobId: claim.id, connectionId: connection!.id })
            ).toMatchObject({
                ok: true,
            });
        });
    });
});
