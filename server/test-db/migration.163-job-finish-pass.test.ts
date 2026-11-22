import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DEFAULT_GATE_FIX_ROUNDS } from '@factory-ai/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { testOrg } from './fixtures.js';
import { assertTestDatabase } from './harness.js';

/**
 * 163 freezes the gate round cap on every thread root: a root that carries none — a workflow root, one from before
 * 162, one that resolved no profile — reads the default afterwards, and a root can no longer be stored without one.
 * It also adds `job_finish_pass` and lets `job_gate_run` record a `finish` pass.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const MIGRATION = '163_job_finish_pass.sql';
const DIR = new URL('../migrations/', import.meta.url);
let admin: Sql;
let pool: Sql;
let schema: string;
const org = testOrg();
const root = randomUUID();
const capped = randomUUID();
const followUp = randomUUID();

const capOf = async (id: string): Promise<number | null> =>
    (await pool<{ cap: number | null }[]>`select gate_fix_rounds as cap from job where id = ${id}`)[0]!.cap;

beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    pool = postgres(url as string, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
    const earlier = readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && name < MIGRATION)
        .sort();
    for (const name of earlier) await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
    await pool`insert into organization (id, name) values (${org}, ${org})`;
    await pool`insert into job (org_id, id, command, root_job_id) values (${org}, ${root}, 'work', ${root})`;
    await pool`insert into job (org_id, id, command, root_job_id, gate_fix_rounds)
               values (${org}, ${capped}, 'work', ${capped}, 0)`;
    await pool`insert into job (org_id, id, command, root_job_id, parent_job_id)
               values (${org}, ${followUp}, 'more', ${root}, ${root})`;
    await pool.unsafe(readFileSync(new URL(MIGRATION, DIR), 'utf8'));
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

describe.runIf(enabled)('163: the round cap on every root, and the finish-pass record', () => {
    it('gives a root that carried no cap the default, and leaves a frozen cap and a follow-up row as they were', async () => {
        expect(await capOf(root)).toBe(DEFAULT_GATE_FIX_ROUNDS);
        expect(await capOf(capped)).toBe(0);
        expect(await capOf(followUp)).toBeNull();
    });

    it('refuses a root stored with no cap', async () => {
        const id = randomUUID();
        await expect(
            pool`insert into job (org_id, id, command, root_job_id, gate_fix_rounds)
                 values (${org}, ${id}, 'work', ${id}, null)`
        ).rejects.toThrow(/job_root_gate_fix_rounds_ck/);
    });

    it('lets a gate run record a finish pass', async () => {
        await pool`
            insert into job_gate_run (org_id, job_id, execution_id, run_claim_seq, claim_seq, gate, identity, filtered,
                                      source, outcome)
            values (${org}, ${root}, ${randomUUID()}, 1, 1, 'test', ${'a'.repeat(64)}, false, 'finish', 'passed')`;
        await expect(
            pool`
                insert into job_gate_run (org_id, job_id, execution_id, run_claim_seq, claim_seq, gate, identity,
                                          filtered, source, outcome)
                values (${org}, ${root}, ${randomUUID()}, 1, 1, 'test', ${'a'.repeat(64)}, false, 'cron', 'passed')`
        ).rejects.toThrow(/check constraint/);
    });

    it('applies twice without error', async () => {
        await pool.unsafe(readFileSync(new URL(MIGRATION, DIR), 'utf8'));
        expect(await capOf(root)).toBe(DEFAULT_GATE_FIX_ROUNDS);
    });
});
