import { randomUUID } from 'node:crypto';
import type { Fragment, Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimAuthorFor } from '../src/db/jobs/job-store-claim-author.js';
import type { Claim } from '../src/db/jobs/job-store-types.js';
import { orgSql } from '../src/db/org-sql.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretDeps } from './env-secrets-harness.js';
import { expireLease } from './fixtures.js';
import {
    type Board,
    bearer,
    type Harness,
    HOST,
    type Org,
    resetHarness,
    startHarness,
} from './gitlab-board-harness.js';
import { useTestDb } from './harness.js';

/**
 * A GitLab task's commit author is the member's GitLab identity (docs/connections.md), read at claim from the profile
 * captured when the member linked: name, else username; commit email, else public email, else the id-qualified noreply
 * address of the host. The committer stays the bot, and a takeover names the same author. The fake GitLab is the only
 * boundary faked.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const LEASE_SECONDS = 60;

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let org: Org;
let grp: string;
let boards: Board[];

beforeAll(async () => {
    if (!enabled) return;
    h = await startHarness(() => db.sql);
});
beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    boards = [];
    await resetHarness(h, sql);
    org = await h.newOrg();
    grp = `g${randomUUID().slice(0, 8)}`;
    await createUserExecutorStore({ sql, orgId: org.id, ...testSecretDeps(sql) }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: org.adminId,
    });
    await h.fake.control('gitlab/projects', { path: `${grp}/web` });
});
afterEach(async () => {
    if (enabled) await Promise.all(boards.map((board) => board.close()));
});
afterAll(async () => {
    await h?.stop();
});

const repo = () => ({ forge: 'gitlab', host: HOST, path: `${grp}/web` });

/** The member links as a fresh login whose `/user` profile is `fields`; the board and the login. */
async function linked(fields: Record<string, unknown>) {
    const login = `m-${randomUUID().slice(0, 8)}`;
    await h.fake.control('gitlab/user-profile', { login, fields });
    const board = await h.board();
    boards.push(board);
    const connectionId = await h.connect(org, { groups: [grp] });
    expect((await board.activate(org, connectionId)).result).toBe('activated');
    expect((await board.link(org, connectionId, login)).result).toBe('linked');
    const picked = await board.app.inject({
        method: 'PUT',
        url: `/api/org/gitlab-connections/${connectionId}/tracked-repos`,
        headers: bearer(org.admin),
        payload: { paths: [`${grp}/web`] },
    });
    expect(picked.statusCode).toBe(OK);
    const [connection] = await sql<{ id: string }[]>`select id from forge_connection where org_id = ${org.id}`;
    return { board, login, connectionId: connection!.id };
}

const accountId = async (login: string) =>
    (
        await sql<{ external_account_id: string }[]>`
            select external_account_id from integration_grant
            where org_id = ${org.id} and provider like 'gitlab:%' and forge_profile ->> 'username' = ${login}
        `
    )[0]!.external_account_id;

describe.skipIf(!enabled)('the claim author of a GitLab task', () => {
    it('is the member’s name and GitLab commit email, and again on a takeover', async () => {
        const { board } = await linked({ name: 'Dev One', commit_email: 'dev.one@example.test' });
        const { id, claim } = await board.running(org, repo());
        expect(claim.author).toEqual({ name: 'Dev One', email: 'dev.one@example.test' });

        await expireLease(sql, id);
        const takeover = (await (await board.jobs(org)).claim('worker-2', LEASE_SECONDS)) as Claim | null;
        expect(takeover).toMatchObject({ id, author: { name: 'Dev One', email: 'dev.one@example.test' } });
    });

    it('falls back to the public email when there is no commit email', async () => {
        const { board } = await linked({ name: 'Dev Two', commit_email: '', public_email: 'public@example.test' });
        const { claim } = await board.running(org, repo());
        expect(claim.author).toEqual({ name: 'Dev Two', email: 'public@example.test' });
    });

    it('falls back to the id-qualified noreply address and the username', async () => {
        const { board, login } = await linked({ name: '', commit_email: '', public_email: '' });
        const { claim } = await board.running(org, repo());
        expect(claim.author).toEqual({
            name: login,
            email: `${await accountId(login)}-${login}@users.noreply.${HOST}`,
        });
    });

    it('is omitted when the grant carries no profile', async () => {
        const { board, login } = await linked({});
        await sql`
            update integration_grant set forge_profile = null
            where org_id = ${org.id} and forge_profile ->> 'username' = ${login}
        `;
        const { claim } = await board.running(org, repo());
        expect(claim).not.toHaveProperty('author');
    });

    describe('the fence: no live grant, no author', () => {
        const target = (hostName = HOST) => ({ run_as: org.memberId, forge: 'gitlab', host: hostName });
        const authorIn = (orgId: string, row = target()) =>
            orgSql(sql, orgId).begin((tx) => claimAuthorFor(tx as never, orgId, row));
        const named = { name: 'Fenced Member', commit_email: 'fenced@example.test' };
        const setGrant = (login: string, set: Fragment) =>
            sql`update integration_grant set ${set} where org_id = ${org.id} and forge_profile ->> 'username' = ${login}`;

        it('names the member while the grant is live', async () => {
            await linked(named);
            expect(await authorIn(org.id)).toEqual({ name: 'Fenced Member', email: 'fenced@example.test' });
        });

        it('is omitted once the connection is removed', async () => {
            const { connectionId } = await linked(named);
            expect(await h.storeOf(org.id).remove(connectionId)).toBe(true);
            expect(await authorIn(org.id)).toBeNull();
        });

        it('is omitted once the connection is deactivated', async () => {
            const { connectionId } = await linked(named);
            await sql`update forge_connection set active = false where org_id = ${org.id} and id = ${connectionId}`;
            expect(await authorIn(org.id)).toBeNull();
        });

        it.each([
            ['needs reconnect', "status = 'reconnect_required'"],
            ['is revoked', "status = 'revoked'"],
            ['has no readable secret', 'secret_wedged_at = now()'],
            ['has lost its secret', 'secret_ref = null'],
        ])('is omitted when the grant %s', async (_name, change) => {
            const { login } = await linked(named);
            await sql.unsafe(
                `update integration_grant set ${change} where org_id = $1 and forge_profile ->> 'username' = $2`,
                [org.id, login]
            );
            expect(await authorIn(org.id)).toBeNull();
        });

        it('is omitted when the grant is for another host', async () => {
            const { login } = await linked(named);
            await setGrant(login, sql`provider = ${'gitlab:other.gitlab.test'}`);
            expect(await authorIn(org.id)).toBeNull();
        });

        it('is omitted for another org, whatever this org holds', async () => {
            await linked(named);
            const other = await h.newOrg();
            expect(await authorIn(other.id)).toBeNull();
        });

        it('takes the new profile after a re-link', async () => {
            const { board, login, connectionId } = await linked(named);
            await h.fake.control('gitlab/user-profile', {
                login,
                fields: { name: 'Renamed Member', commit_email: 'renamed@example.test' },
            });
            expect((await board.link(org, connectionId, login)).result).toBe('linked');
            expect(await authorIn(org.id)).toEqual({ name: 'Renamed Member', email: 'renamed@example.test' });
        });

        it('reads the profile of the very row the standing approved, on an updated_at tie', async () => {
            const { login, connectionId } = await linked(named);
            const [live] = await sql<{ id: string; updated_at: Date; forge_connection_id: string }[]>`
                select id, updated_at, forge_connection_id from integration_grant
                where org_id = ${org.id} and forge_profile ->> 'username' = ${login}`;
            // An id that sorts before (or after) the live row's: uuids compare as their hex text.
            const idOn = (side: 'before' | 'after'): string => {
                for (;;) {
                    const id = randomUUID();
                    if (side === 'before' ? id < live!.id : id > live!.id) return id;
                }
            };
            const rival = async (id: string) => {
                await sql`
                    insert into integration_grant
                        (id, org_id, principal_kind, principal_user_id, provider, external_account_id, authority,
                         status, forge_profile, forge_connection_id, updated_at)
                    values (${id}, ${org.id}, 'user', ${org.memberId}, ${`gitlab:${HOST}`}, ${`rival-${id}`},
                            ${sql.json({ scopes: [] })}, 'reconnect_required',
                            ${sql.json({ username: 'rival', name: 'Rival' })}, ${connectionId}, ${live!.updated_at})`;
            };
            // The live row sorts first on the tie: its profile, and only its, is the author.
            const behind = idOn('before');
            await rival(behind);
            expect(await authorIn(org.id)).toEqual({ name: 'Fenced Member', email: 'fenced@example.test' });
            // The rival sorts first: it is the row judged, it is not live, and nothing of the other row leaks in.
            await sql`delete from integration_grant where id = ${behind}`;
            await rival(idOn('after'));
            expect(await authorIn(org.id)).toBeNull();
        });
    });
});
