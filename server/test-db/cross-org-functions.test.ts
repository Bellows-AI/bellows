import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { CROSS_ORG_FUNCTIONS, CROSS_ORG_ROLE, REQUEST_ROLE } from '../src/db/org-sql.js';
import { admissionLockKey } from '../src/db/jobs/job-store-admission.js';
import { craftJob, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The cross-org facts a single-org path needs are `security definer` functions owned by the `bypassrls` role: called
 * by the request role under one organization's setting, each answers across organizations, and each returns only a
 * count, a slot number or one boolean per id the caller passed, never a row of another organization.
 */
const orgA = testOrg();
const orgB = testOrg();
const author = testUser('cross-org-functions');
const db = useTestDb({ orgs: [orgA, orgB], users: [author] });
const enabled = Boolean(db.url);

/** Runs `fn` as the request role under `org`'s setting (none when null), then rolls back what it wrote. */
async function asRequest<T>(org: string | null, fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    return db.sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${REQUEST_ROLE}`);
        if (org !== null) await tx`select set_config('app.org_id', ${org}, true)`;
        return fn(tx);
    }) as Promise<T>;
}

const running = (org: string) => craftJob({ sql: db.sql, org, author: author.id }, { status: 'running' });

/** A session bound to `org`'s attempt, written past the execution row's foreign key. */
async function boundSession(org: string, sessionId: string, jobId = randomUUID()): Promise<string> {
    await db.sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`insert into job_execution_session (org_id, job_id, claim_seq, session_id, origin)
                 values (${org}, ${jobId}, 1, ${sessionId}, 'reported')`;
    });
    return jobId;
}

describe.skipIf(!enabled)('cross-org definer functions', () => {
    it('are security definer, owned by the cross-org role, with a pinned search_path, executable by the request role alone', async () => {
        const rows = await db.sql<
            {
                name: string;
                definer: boolean;
                owner: string;
                config: string[] | null;
                result: string;
                anyone: boolean;
                request: boolean;
            }[]
        >`
            select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
                   pg_get_function_result(p.oid) as result,
                   exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                           where x.grantee = 0 and x.privilege_type = 'EXECUTE') as anyone,
                   has_function_privilege(${REQUEST_ROLE}, p.oid, 'EXECUTE') as request
            from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any(${CROSS_ORG_FUNCTIONS as unknown as string[]})
        `;
        expect(rows.map((r) => r.name).sort()).toEqual([...CROSS_ORG_FUNCTIONS].sort());
        for (const row of rows) {
            expect(row, row.name).toMatchObject({ definer: true, owner: CROSS_ORG_ROLE, anyone: false, request: true });
            expect(row.config, row.name).toContain('search_path=pg_catalog, public, pg_temp');
            expect(row.result, row.name).toMatch(
                /^(integer|boolean\[\]|boolean|TABLE\(global_running integer, org_max integer, repo_max integer\))$/
            );
        }
    });

    it("counts every organization's running rows for the global budget under one org's setting", async () => {
        await running(orgA);
        await running(orgB);
        await running(orgB);
        const [row] = await asRequest(orgA, (tx) => tx<{ n: number }[]>`select bellows_global_running() as n`);
        expect(row!.n).toBe(3);
        const [visible] = await asRequest(orgA, (tx) => tx<{ n: number }[]>`select count(*)::int as n from job`);
        expect(visible!.n).toBe(1);
    });

    it("reports the cluster's occupancy as counts, with no setting at all", async () => {
        await running(orgA);
        await running(orgB);
        await running(orgB);
        const [row] = await asRequest(null, (tx) => tx`select * from bellows_admission_occupancy()`);
        expect(row).toEqual({ global_running: 3, org_max: 2, repo_max: 2 });
    });

    it("admits into a global slot no other organization's running row holds, moving a slotless one first", async () => {
        const other = await running(orgB);
        await db.sql`update job set admission_slot_global = 1 where id = ${other}`;
        const slotless = await running(orgB);

        expect(await asRequest(orgA, (tx) => tx`select bellows_global_admission_slot(2) as slot`)).toEqual([
            { slot: null },
        ]);
        const [taken] = await asRequest(
            orgA,
            (tx) => tx<{ slot: number }[]>`select bellows_global_admission_slot(3) as slot`
        );
        expect(taken!.slot).toBe(3);
        const [moved] = await db.sql<
            { slot: number }[]
        >`select admission_slot_global as slot from job where id = ${slotless}`;
        expect(moved!.slot).toBe(2);
    });

    it('skips a slot another claimer holds the lock of, so two claimers never share one', async () => {
        await running(orgB);
        await db.sql.begin(async (holder) => {
            await holder`select pg_advisory_xact_lock(hashtextextended(${admissionLockKey('global', '', 2)}, 0))`;
            const [row] = await asRequest(
                orgA,
                (tx) => tx<{ slot: number }[]>`select bellows_global_admission_slot(3) as slot`
            );
            // Slot 1 went to the slotless running row of org B, slot 2 is held: the claimer takes 3.
            expect(row!.slot).toBe(3);
        });
    });

    it('refuses a budget that is not a positive integer', async () => {
        const failure = await asRequest(orgA, (tx) => tx`select bellows_global_admission_slot(0)`).catch(
            (e: Error) => e
        );
        expect(String(failure)).toContain('positive');
    });

    it('names, per id the caller passed, whether another organization holds the session, and nothing else', async () => {
        await boundSession(orgB, 'theirs');
        await boundSession(orgA, 'mine');
        await db.sql`insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen, samples)
                     values (${orgB}, 'claude', 'branched', 'acme/widgets', 'main', now(), now(), 1)`;
        const [row] = await asRequest(
            orgA,
            (tx) =>
                tx<
                    { foreign: boolean[] }[]
                >`select bellows_sessions_foreign(${['theirs', 'mine', 'branched', 'unknown']}::text[]) as foreign`
        );
        expect(row!.foreign).toEqual([true, false, true, false]);
    });

    it('refuses to answer for a session without the organization setting', async () => {
        const failure = await asRequest(null, (tx) => tx`select bellows_sessions_foreign(${['x']}::text[])`).catch(
            (e: Error) => e
        );
        expect(String(failure)).toContain('app.org_id');
        const refused = await asRequest(
            null,
            (tx) => tx`select bellows_sessions_refused(null, ${['x']}::text[])`
        ).catch((e: Error) => e);
        expect(String(refused)).toContain('app.org_id');
    });

    it('refuses ingest into a session another org or another attempt holds, or another org owns', async () => {
        const job = await boundSession(orgA, 'this-attempt');
        await boundSession(orgA, 'other-attempt');
        await boundSession(orgB, 'their-attempt');
        await db.sql`insert into telemetry_session_owner (session_id, org_id) values ('their-owner', ${orgB})`;
        const [row] = await asRequest(
            orgA,
            (tx) =>
                tx<{ refused: boolean[] }[]>`
                select bellows_sessions_refused(${job}::uuid,
                    ${['this-attempt', 'other-attempt', 'their-attempt', 'their-owner', 'fresh']}::text[]) as refused
            `
        );
        expect(row!.refused).toEqual([false, true, true, true, false]);
    });

    it("names whether another organization owns one session, for the caller's org alone", async () => {
        await db.sql`insert into telemetry_session_owner (session_id, org_id) values ('theirs', ${orgB}), ('mine', ${orgA})`;
        const [row] = await asRequest(
            orgA,
            (tx) =>
                tx<{ theirs: boolean; mine: boolean; fresh: boolean }[]>`
                select bellows_session_owned_elsewhere('theirs') as theirs,
                       bellows_session_owned_elsewhere('mine') as mine,
                       bellows_session_owned_elsewhere('fresh') as fresh
            `
        );
        expect(row).toEqual({ theirs: true, mine: false, fresh: false });
        const failure = await asRequest(null, (tx) => tx`select bellows_session_owned_elsewhere('theirs')`).catch(
            (e: Error) => e
        );
        expect(String(failure)).toContain('app.org_id');
    });
});
