import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { migrate } from '../src/db/migrate.js';
import { assertTestDatabase } from './harness.js';

/** Issue #845: 085 upgrades a database that stops at 084, and applying it again changes nothing. */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '085_job_execution.sql';
let admin: Sql;
let pool: Sql;
let schema: string;

const run = () => migrate(pool, { attempts: 1, log: () => {} });
const tables = () =>
    pool<{ t: string }[]>`
        select table_name as t from information_schema.tables
        where table_schema = ${schema} and table_name like 'job\_execution%' order by 1`;

beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    pool = postgres(url as string, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

describe.skipIf(!enabled)('085_job_execution', () => {
    it('upgrades from 084, and a repeated application is a no-op', async () => {
        await run();
        // Put the schema back at 084.
        await pool.unsafe('drop table job_execution_session, job_execution');
        await pool`delete from schema_migrations where version = ${VERSION}`;
        expect(await tables()).toEqual([]);

        await run();
        expect(await tables()).toEqual([{ t: 'job_execution' }, { t: 'job_execution_session' }]);

        await pool`insert into job_execution (org_id, job_id, claim_seq, root_job_id) values ('o', ${randomUUID()}, 1, ${randomUUID()})`;
        await run();
        const [count] = await pool<{ n: number }[]>`select count(*)::int as n from job_execution`;
        expect(count!.n).toBe(1);
    });

    it('re-applies its own SQL over a live schema, keeping rows and the launch guards', async () => {
        await run();
        const file = readFileSync(new URL('../migrations/085_job_execution.sql', import.meta.url), 'utf8');
        const job = randomUUID();
        await pool`insert into job_execution (org_id, job_id, claim_seq, root_job_id, launch) values ('o', ${job}, 3, ${randomUUID()}, 'observed')`;

        await pool.unsafe(file);
        await pool.unsafe(file);

        const [row] = await pool<{ launch: string }[]>`select launch from job_execution where job_id = ${job}`;
        expect(row?.launch).toBe('observed');
        await expect(pool`update job_execution set launch = 'requested' where job_id = ${job}`).rejects.toThrow(
            /not a forward move/
        );
    });

    it('refuses a launch state outside the enum', async () => {
        await run();
        await expect(
            pool`insert into job_execution (org_id, job_id, claim_seq, root_job_id, launch) values ('o', ${randomUUID()}, 2, ${randomUUID()}, 'started')`
        ).rejects.toThrow(/check constraint|job_execution_launch_check/);
    });

    describe('backfill', () => {
        const seed = async (over: {
            claimSeq: number;
            interruptions?: unknown[];
            session?: string | null;
            reviewOf?: string;
            root?: string;
            status?: string;
        }) => {
            const id = randomUUID();
            const [author] = await pool<{ id: string }[]>`
                insert into app_user (github_user_id, github_login) values (${Math.floor(Math.random() * 1e9)}, ${`u${id}`})
                returning id`;
            await pool`
                insert into job (org_id, id, root_job_id, command, status, claim_seq, interruptions, session_id, review_of, repo, created_by,
                                 review_key, review_profile, review_spec, review_revision, review_ref)
                values ('o', ${id}, ${over.root ?? id}, 'x', ${over.status ?? 'succeeded'}, ${over.claimSeq},
                        ${pool.json((over.interruptions ?? []) as never)}, ${over.session ?? null}, ${over.reviewOf ?? null}, 'acme/web', ${author!.id},
                        ${over.reviewOf ? 'k' : null}, ${over.reviewOf ? 'p' : null}, ${over.reviewOf ? pool.json({}) : null},
                        ${over.reviewOf ? 'r' : null}, ${over.reviewOf ? 'ref' : null})`;
            return id;
        };
        const rewind = async () => {
            await run();
            await pool`delete from job_execution_session`;
            await pool`delete from job_execution`;
            await pool`delete from schema_migrations where version = ${VERSION}`;
        };
        const rows = (id: string) =>
            pool<
                {
                    claim_seq: string;
                    launch: string;
                    origin: string;
                    created_at: Date | null;
                    ended_at: Date | null;
                    resumed: boolean;
                    requesting_root_job_id: string | null;
                }[]
            >`select claim_seq, launch, origin, created_at, ended_at, resumed, requesting_root_job_id
              from job_execution where job_id = ${id} order by claim_seq`;

        it('files only what the retained row proves: its claims, its session, no boundary', async () => {
            await run();
            const session = randomUUID();
            const history = await seed({
                claimSeq: 4,
                session,
                interruptions: [
                    { at: 'x', reason: 'lease-expired', claimSeq: 1 },
                    { at: 'y', reason: 'adopted', claimSeq: 3 },
                    { at: 'z', reason: 'lease-expired', claimSeq: 3 },
                    { reason: 'malformed' },
                    { reason: 'out of range', claimSeq: 9 },
                    { reason: 'fraction', claimSeq: 3.5 },
                    { reason: 'huge', claimSeq: 1e20 },
                    { reason: 'negative', claimSeq: -2 },
                ],
            });
            const unclaimed = await seed({ claimSeq: 0 });
            const requester = await seed({ claimSeq: 1 });
            const review = await seed({ claimSeq: 2, reviewOf: requester });
            await rewind();

            await run();

            expect(await rows(history)).toMatchObject([{ claim_seq: '1' }, { claim_seq: '3' }, { claim_seq: '4' }]);
            for (const r of await rows(history)) {
                expect(r).toMatchObject({
                    launch: 'unknown',
                    origin: 'backfill',
                    created_at: null,
                    ended_at: null,
                    resumed: false,
                });
            }
            expect(await rows(unclaimed)).toEqual([]);
            expect(await rows(review)).toMatchObject([{ claim_seq: '2', requesting_root_job_id: requester }]);
            const sessions = await pool<{ claim_seq: string; session_id: string; origin: string }[]>`
                select claim_seq, session_id, origin from job_execution_session where job_id = ${history}`;
            expect(sessions).toEqual([{ claim_seq: '4', session_id: session, origin: 'backfill' }]);
        });

        it('is idempotent, and later job moves invent no end for a backfilled claim', async () => {
            await run();
            const id = await seed({ claimSeq: 2, session: randomUUID(), status: 'running' });
            await rewind();
            await run();
            const first = await rows(id);

            await pool.unsafe(readFileSync(new URL('../migrations/085_job_execution.sql', import.meta.url), 'utf8'));
            expect(await rows(id)).toEqual(first);
            const [n] = await pool<
                { n: number }[]
            >`select count(*)::int as n from job_execution_session where job_id = ${id}`;
            expect(n!.n).toBe(1);

            await pool`update job set status = 'succeeded' where id = ${id}`;
            expect(await rows(id)).toEqual(first);
        });

        it('refuses a claim row without a start unless it is a backfill', async () => {
            await run();
            await expect(
                pool`insert into job_execution (org_id, job_id, claim_seq, root_job_id, created_at) values ('o', ${randomUUID()}, 1, ${randomUUID()}, null)`
            ).rejects.toThrow(/job_execution_start_known/);
        });
    });
});
