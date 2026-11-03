import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createConnectionStore, type ConnectionStore } from '../src/db/connection-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { useTestDb } from './harness.js';
import { legacyConnection, oauthConnection, testOrg, testUser } from './fixtures.js';

/** The managed connections (051, 094, 097): scoping and the generic view, on a real database. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const OTHER_ORG = testOrg();
const OWNER = testUser('conn-owner');
const STRANGER = testUser('conn-stranger');
/** One member per preview case: a default is judged against ALL of a member's connections, so none is shared. */
const PREVIEW_USERS = Array.from({ length: 5 }, (_, i) => testUser(`conn-preview-${i}`));

const db = useTestDb({ orgs: [ORG, OTHER_ORG], users: [OWNER, STRANGER, ...PREVIEW_USERS] });

let sql: Sql;
let store: ConnectionStore;
let otherOrgStore: ConnectionStore;
let jobs: JobStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createConnectionStore({ sql, orgId: ORG });
    otherOrgStore = createConnectionStore({ sql, orgId: OTHER_ORG });
    jobs = createJobStore({ sql, orgId: ORG });
});

const join = (user: { id: string; login: string }) =>
    sql`insert into org_membership (org_id, github_login, user_id) values (${ORG}, ${user.login}, ${user.id})
        on conflict do nothing`;

describe.skipIf(!enabled)('connection store — scoping', () => {
    it("lists the caller's own OAuth connections, never another member's or another org's", async () => {
        const mine = await oauthConnection(sql, ORG, OWNER.id);
        const theirs = await oauthConnection(sql, ORG, STRANGER.id);
        const foreign = await oauthConnection(sql, OTHER_ORG, OWNER.id);

        const views = await store.list(OWNER.id);
        const ids = views.map((c) => c.id);
        expect(ids).toContain(mine.id);
        expect(ids).not.toContain(theirs.id);
        expect(ids).not.toContain(foreign.id);
        expect(views.every((v) => v.credential === 'oauth_grant')).toBe(true);
    });

    it('never lists a legacy API-token row, org-wide or personal, active or not', async () => {
        const orgWide = await legacyConnection(sql, ORG, null);
        const personal = await legacyConnection(sql, ORG, OWNER.id);
        const gone = await legacyConnection(sql, ORG, OWNER.id, { status: 'disconnected' });
        const ids = (await store.list(OWNER.id)).map((c) => c.id);
        for (const id of [orgWide, personal, gone]) expect(ids).not.toContain(id);
        expect((await store.candidates(OWNER.id, 'jira')).map((c) => c.id)).not.toContain(personal);
    });

    it('disconnects only the connection of its owner: another member gets nothing', async () => {
        const mine = await oauthConnection(sql, ORG, OWNER.id);
        expect((await store.disconnect(mine.id, { userId: STRANGER.id })).disconnected).toBe(false);
        expect((await store.disconnect(mine.id, { userId: OWNER.id })).disconnected).toBe(true);
    });

    it('does not disconnect a legacy org row: it is not a connection any more', async () => {
        const orgWide = await legacyConnection(sql, ORG, null);
        expect((await store.disconnect(orgWide, { userId: OWNER.id })).disconnected).toBe(false);
        const [row] = await sql<{ status: string }[]>`select status from connector_connection where id = ${orgWide}`;
        expect(row!.status).toBe('active');
    });
});

describe.skipIf(!enabled)('connection store — generic view (094)', () => {
    it('shows the OAuth connection as personal to its owner, with no credential', async () => {
        const mine = await oauthConnection(sql, ORG, OWNER.id, { account: 'agent@example.com' });
        const views = await store.list(OWNER.id);
        expect(views.find((v) => v.id === mine.id)).toMatchObject({
            provider: 'jira',
            credential: 'oauth_grant',
            ownership: 'personal',
            principal: 'self',
            site: 'example.atlassian.net',
            account: 'agent@example.com',
            status: 'active',
            needsReconnect: false,
        });
        expect(JSON.stringify(views)).not.toMatch(/token|secret/i);
    });

    it('flags a connection whose grant needs reconnecting, in the list and the candidates', async () => {
        const fine = await oauthConnection(sql, ORG, OWNER.id);
        const stale = await oauthConnection(sql, ORG, OWNER.id);
        await sql`update integration_grant set status = 'reconnect_required' where id = ${stale.grantId}`;
        const views = await store.list(OWNER.id);
        expect(views.find((v) => v.id === fine.id)?.needsReconnect).toBe(false);
        expect(views.find((v) => v.id === stale.id)?.needsReconnect).toBe(true);
        const candidates = await store.candidates(OWNER.id, 'jira');
        expect(candidates.find((v) => v.id === stale.id)?.needsReconnect).toBe(true);
        expect(candidates.find((v) => v.id === fine.id)?.needsReconnect).toBe(false);
    });

    it('candidates(user, jira) excludes disconnected and other members', async () => {
        const [row] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login)
            values (${Math.floor(Math.random() * 1e9) + 1e6}, ${`conn-cand-${crypto.randomUUID()}`})
            returning id
        `;
        const user = row!.id;
        await oauthConnection(sql, ORG, STRANGER.id);
        const gone = await oauthConnection(sql, ORG, user);
        await store.disconnect(gone.id, { userId: user });
        const live = await oauthConnection(sql, ORG, user);
        expect((await store.candidates(user, 'jira')).map((c) => c.id)).toEqual([live.id]);
        expect(await store.candidates(user, 'github')).toEqual([]);
    });

    it('disconnect is soft: the row remains, api_token is null and status is disconnected', async () => {
        const mine = await oauthConnection(sql, ORG, OWNER.id);
        expect((await store.disconnect(mine.id, { userId: OWNER.id })).disconnected).toBe(true);
        const [row] = await sql<{ api_token: string | null; status: string; disconnected_at: Date | null }[]>`
            select api_token, status, disconnected_at from connector_connection where id = ${mine.id}
        `;
        expect(row).toMatchObject({ api_token: null, status: 'disconnected' });
        expect(row!.disconnected_at).not.toBeNull();
        expect((await store.list(OWNER.id)).map((v) => v.id)).not.toContain(mine.id);
        expect((await store.disconnect(mine.id, { userId: OWNER.id })).disconnected).toBe(false);
    });

    it('a binding keeps its frozen account after the connection is disconnected', async () => {
        await join(OWNER);
        const mine = await oauthConnection(sql, ORG, OWNER.id, { account: 'frozen@example.com' });
        const ref = await jobs.create('look at ABC-1', OWNER.id, {
            repo: null,
            executor: null,
            connectionIds: [mine.id],
        });
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
        await store.disconnect(mine.id, { userId: OWNER.id });
        const [binding] = await sql<{ connection_id: string; external_account_id: string; source: string }[]>`
            select connection_id, external_account_id, source from job_connection_binding where root_job_id = ${ref.id}
        `;
        expect(binding).toEqual({
            connection_id: mine.id,
            external_account_id: 'frozen@example.com',
            source: 'explicit',
        });
    });

    it('disconnecting the last connection of a grant revokes the grant; another active connection keeps it active', async () => {
        const solo = await oauthConnection(sql, ORG, OWNER.id);
        expect(await store.disconnect(solo.id, { userId: OWNER.id })).toEqual({
            disconnected: true,
            revokedGrantId: solo.grantId,
        });
        const [revoked] = await sql<
            { status: string }[]
        >`select status from integration_grant where id = ${solo.grantId}`;
        expect(revoked!.status).toBe('revoked');

        const account = `acct-${crypto.randomUUID()}`;
        const first = await oauthConnection(sql, ORG, OWNER.id, { account });
        const sibling = await oauthConnection(sql, ORG, OWNER.id, { account });
        expect(sibling.grantId).toBe(first.grantId);
        expect(await store.disconnect(first.id, { userId: OWNER.id })).toEqual({
            disconnected: true,
            revokedGrantId: null,
        });
        const [kept] = await sql<
            { status: string }[]
        >`select status from integration_grant where id = ${first.grantId}`;
        expect(kept!.status).toBe('active');
    });

    it('cross-org: a connection id from org B is invisible to org A', async () => {
        const foreign = await oauthConnection(sql, OTHER_ORG, OWNER.id);
        expect((await store.list(OWNER.id)).map((v) => v.id)).not.toContain(foreign.id);
        expect((await store.candidates(OWNER.id, 'jira')).map((v) => v.id)).not.toContain(foreign.id);
        expect((await store.disconnect(foreign.id, { userId: OWNER.id })).disconnected).toBe(false);
        expect((await otherOrgStore.list(OWNER.id)).map((v) => v.id)).toContain(foreign.id);
    });
});

describe.skipIf(!enabled)('connection store — preview', () => {
    const [DEFAULTED, AMBIGUOUS, NONE, LAPSED, EXPLICIT] = PREVIEW_USERS as [
        (typeof PREVIEW_USERS)[number],
        (typeof PREVIEW_USERS)[number],
        (typeof PREVIEW_USERS)[number],
        (typeof PREVIEW_USERS)[number],
        (typeof PREVIEW_USERS)[number],
    ];
    const ask = (user: { id: string }, explicit: string[] = []) =>
        store.preview({ executionUser: user.id, explicit, providers: ['jira'], required: ['jira'] });

    it("selects the member's one usable connection as the default, writing no binding", async () => {
        const mine = await oauthConnection(sql, ORG, DEFAULTED.id);
        const before = await sql`select 1 from job_connection_binding where org_id = ${ORG}`;
        const answer = await ask(DEFAULTED);
        expect(answer).toMatchObject({ ok: true, requirements: [] });
        expect(answer.ok && answer.bindings).toEqual([
            expect.objectContaining({ connectionId: mine.id, provider: 'jira', source: 'default' }),
        ]);
        expect(await sql`select 1 from job_connection_binding where org_id = ${ORG}`).toHaveLength(before.length);
    });

    it('reports two usable connections as ambiguous, not as missing', async () => {
        await oauthConnection(sql, ORG, AMBIGUOUS.id);
        await oauthConnection(sql, ORG, AMBIGUOUS.id);
        expect(await ask(AMBIGUOUS)).toMatchObject({
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'ambiguous' }],
        });
    });

    it("reports a member with no connection as missing, and never offers another member's", async () => {
        await oauthConnection(sql, ORG, STRANGER.id);
        expect(await ask(NONE)).toMatchObject({
            ok: true,
            bindings: [],
            requirements: [{ provider: 'jira', reason: 'missing' }],
        });
    });

    it('does not count a connection whose grant lapsed: missing here, and listed as needing reconnect', async () => {
        const lapsed = await oauthConnection(sql, ORG, LAPSED.id);
        await sql`update integration_grant set status = 'reconnect_required' where id = ${lapsed.grantId}`;
        expect(await ask(LAPSED)).toMatchObject({ ok: true, requirements: [{ provider: 'jira', reason: 'missing' }] });
        expect(await ask(LAPSED, [lapsed.id])).toEqual({ ok: false, reason: 'not-authorized' });
        expect(await store.list(LAPSED.id)).toEqual([expect.objectContaining({ id: lapsed.id, needsReconnect: true })]);
    });

    it("binds an explicit connection of the member and refuses another member's", async () => {
        const mine = await oauthConnection(sql, ORG, EXPLICIT.id);
        const theirs = await oauthConnection(sql, ORG, STRANGER.id);
        expect(await ask(EXPLICIT, [mine.id])).toMatchObject({
            ok: true,
            bindings: [expect.objectContaining({ connectionId: mine.id, source: 'explicit' })],
            requirements: [],
        });
        expect(await ask(EXPLICIT, [theirs.id])).toEqual({ ok: false, reason: 'not-authorized' });
    });
});
