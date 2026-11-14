import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { type CommercePlanWriter, createCommercePlanWriter, type PlanPush } from '../src/db/commerce-plan-writer.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/** the inbound plan push is stored once, newest version wins, and the write decides the org exists. */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const db = useTestDb({ orgs: [ORG] });

let sql: Sql;
let writer: CommercePlanWriter;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    writer = createCommercePlanWriter({ sql, ready: Promise.resolve() });
});

const push = (overrides: Partial<PlanPush> = {}): PlanPush => ({
    plan: 'pro',
    includedMinutes: 3000,
    usedMinutes: 10,
    periodStart: new Date('2026-08-01T00:00:00Z'),
    periodEnd: new Date('2026-09-01T00:00:00Z'),
    maxRunning: 4,
    maxQueued: 50,
    maxWallSeconds: 7200,
    maxTokens: 50_000_000,
    maxStorageBytes: 10_737_418_240,
    version: 1,
    ...overrides,
});

const rows = () =>
    sql<{ plan: string; used_minutes: string; version: string; updated_at: Date }[]>`
        select plan, used_minutes, version, updated_at from org_plan where org_id = ${ORG}`;

describe.skipIf(!enabled)('commerce plan writer — database', () => {
    it('stores a first push', async () => {
        expect(await writer.put(ORG, push())).toEqual({ verdict: 'stored' });
        const [row] = await rows();
        expect(row).toMatchObject({ plan: 'pro', used_minutes: '10', version: '1' });
    });

    it('stores a push with no limits and no period', async () => {
        const open = push({
            plan: 'free',
            includedMinutes: null,
            usedMinutes: null,
            periodStart: null,
            periodEnd: null,
        });
        expect(await writer.put(ORG, open)).toEqual({ verdict: 'stored' });
    });

    it('stores the limits the push carries, and a same-version push with other limits is stale', async () => {
        await writer.put(ORG, push());
        const [row] = await sql`
            select max_running, max_queued, max_wall_seconds, max_tokens, max_storage_bytes
            from org_plan where org_id = ${ORG}`;
        expect(row).toEqual({
            max_running: 4,
            max_queued: 50,
            max_wall_seconds: 7200,
            max_tokens: '50000000',
            max_storage_bytes: '10737418240',
        });
        expect(await writer.put(ORG, push())).toEqual({ verdict: 'replayed' });
        expect(await writer.put(ORG, push({ maxQueued: 51 }))).toEqual({ verdict: 'stale', currentVersion: 1 });
        expect(await writer.put(ORG, push({ maxTokens: 1 }))).toEqual({ verdict: 'stale', currentVersion: 1 });
    });

    it("stores an Enterprise retention window, and a push that leaves it out stores the board's default", async () => {
        await writer.put(ORG, push({ plan: 'enterprise', maxRetentionDays: 400 }));
        const days = async () =>
            (await sql<{ d: number | null }[]>`select max_retention_days as d from org_plan where org_id = ${ORG}`)[0]
                ?.d;
        expect(await days()).toBe(400);
        expect(await writer.put(ORG, push({ plan: 'enterprise', maxRetentionDays: 400 }))).toEqual({
            verdict: 'replayed',
        });
        expect(await writer.put(ORG, push({ plan: 'enterprise', maxRetentionDays: 401 }))).toEqual({
            verdict: 'stale',
            currentVersion: 1,
        });
        await writer.put(ORG, push({ version: 2 }));
        expect(await days()).toBeNull();
    });

    it('a newer version overwrites', async () => {
        await writer.put(ORG, push({ version: 1 }));
        expect(await writer.put(ORG, push({ version: 2, plan: 'enterprise', usedMinutes: 99 }))).toEqual({
            verdict: 'stored',
        });
        const [row] = await rows();
        expect(row).toMatchObject({ plan: 'enterprise', used_minutes: '99', version: '2' });
    });

    it('an identical replay is replayed, not rewritten', async () => {
        await writer.put(ORG, push({ version: 3 }));
        const [before] = await rows();
        expect(await writer.put(ORG, push({ version: 3 }))).toEqual({ verdict: 'replayed' });
        const [after] = await rows();
        expect(after?.updated_at).toEqual(before?.updated_at);
    });

    it('an older version is stale and changes nothing', async () => {
        await writer.put(ORG, push({ version: 5, usedMinutes: 50 }));
        expect(await writer.put(ORG, push({ version: 4, usedMinutes: 1 }))).toEqual({
            verdict: 'stale',
            currentVersion: 5,
        });
        const [row] = await rows();
        expect(row).toMatchObject({ used_minutes: '50', version: '5' });
    });

    it('the same version with different fields is stale', async () => {
        await writer.put(ORG, push({ version: 6, usedMinutes: 60 }));
        expect(await writer.put(ORG, push({ version: 6, usedMinutes: 61 }))).toEqual({
            verdict: 'stale',
            currentVersion: 6,
        });
        expect((await rows())[0]?.used_minutes).toBe('60');
    });

    it('an unknown org is unknown_org and writes no row', async () => {
        const stranger = testOrg();
        expect(await writer.put(stranger, push())).toEqual({ verdict: 'unknown_org' });
        const found = await sql`select 1 from org_plan where org_id = ${stranger}`;
        expect(found).toHaveLength(0);
    });

    it('two concurrent pushes of one version decide once', async () => {
        const verdicts = await Promise.all([
            writer.put(ORG, push({ version: 7 })),
            writer.put(ORG, push({ version: 7 })),
        ]);
        expect(verdicts.map((v) => v.verdict).sort()).toEqual(['replayed', 'stored']);
        expect(await rows()).toHaveLength(1);
    });

    it('two concurrent pushes of different versions keep the newer', async () => {
        await Promise.all([
            writer.put(ORG, push({ version: 9, usedMinutes: 9 })),
            writer.put(ORG, push({ version: 8, usedMinutes: 8 })),
        ]);
        expect((await rows())[0]).toMatchObject({ version: '9', used_minutes: '9' });
    });

    it('refuses a plan the table would not hold', async () => {
        await expect(writer.put(ORG, push({ plan: 'platinum' as PlanPush['plan'] }))).rejects.toThrow();
        expect(await rows()).toHaveLength(0);
    });
});
