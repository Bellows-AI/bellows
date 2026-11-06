import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';

/**
 * BEL-269: 127 renames the seven built-in skills on every job row, keeping order and leaving other names alone.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '127_skill_factory_prefix.sql';
const DIR = new URL('../migrations/', import.meta.url);
let admin: Sql;
let pool: Sql;
let schema: string;

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

const versioned = (below: string): string[] =>
    readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && name < below)
        .sort();

describe.skipIf(!enabled)('127_skill_factory_prefix', () => {
    it('renames the built-in skills in order, and leaves other names alone', async () => {
        for (const name of versioned(VERSION)) await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
        const org = `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
        await pool`insert into organization (id, name) values (${org}, ${org})`;
        const seed = async (skills: string[]): Promise<string> => {
            const id = randomUUID();
            await pool`insert into job (org_id, id, command, root_job_id, skills) values (${org}, ${id}, 'work', ${id}, ${skills})`;
            return id;
        };
        const all = await seed(['backend-fix', 'gates', 'github', 'jira', 'pr-land', 'review', 'task-title']);
        const mixed = await seed(['jira', 'my-repo-skill', 'review']);
        const single = await seed(['github']);
        const none = await seed([]);
        const prefixed = await seed(['factory-jira']);

        await pool.unsafe(readFileSync(new URL(VERSION, DIR), 'utf8'));

        const skillsOf = async (id: string): Promise<string[]> => {
            const [row] = await pool<
                { skills: string[] }[]
            >`select skills from job where org_id = ${org} and id = ${id}`;
            return row!.skills;
        };
        expect(await skillsOf(all)).toEqual([
            'factory-fix',
            'factory-gates',
            'factory-github',
            'factory-jira',
            'factory-pr-land',
            'factory-review',
            'factory-task-title',
        ]);
        expect(await skillsOf(mixed)).toEqual(['factory-jira', 'my-repo-skill', 'factory-review']);
        expect(await skillsOf(single)).toEqual(['factory-github']);
        expect(await skillsOf(none)).toEqual([]);
        expect(await skillsOf(prefixed)).toEqual(['factory-jira']);
    });
});
