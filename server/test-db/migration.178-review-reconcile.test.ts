import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { testOrg } from './fixtures.js';
import { assertTestDatabase } from './harness.js';

/**
 * 178 renames the review block's id inside every stored graph (`workflow.definition`, `job.workflow_snapshot`).
 * The rewrite is structural: only a node's `runtime.block` changes, never prompt text, and a value the file cannot
 * read is left alone.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const MIGRATION = '178_review_reconcile_block.sql';
const DIR = new URL('../migrations/', import.meta.url);
const OLD = 'builtin/github-review-reconcile';
const NEW = 'builtin/review-reconcile';
let admin: Sql;
let pool: Sql;
let schema: string;
const org = testOrg();
const root = randomUUID();

const graph = (block: string) => ({
    entry: 'review--collect',
    nodes: [
        { name: 'review--collect', kind: 'agent', prompt: 'collect' },
        {
            name: 'review--wait',
            kind: 'agent',
            prompt: 'wait',
            runtime: { runtime: 'pr-delivery-wait', block, params: {} },
        },
    ],
    edges: [{ from: 'review--collect', to: 'review--wait', when: 'succeeded' }],
});
const mentioning = {
    entry: 'a',
    nodes: [
        {
            name: 'a',
            kind: 'agent',
            prompt: `never run ${OLD} here`,
            runtime: { runtime: 'x', block: 'builtin/other' },
        },
    ],
    edges: [],
};
const autofix = {
    entry: 'a',
    nodes: [{ name: 'a', kind: 'agent', prompt: 'merge-conflict', block: 'builtin/merge-conflict-autofix' }],
    edges: [],
};
const malformed = [
    { name: 'not-object', value: `["${OLD}"]` },
    { name: 'nodes-not-array', value: JSON.stringify({ nodes: OLD }) },
    { name: 'runtime-string', value: JSON.stringify({ nodes: [{ name: 'n', runtime: OLD }] }) },
];

const definitionOf = async (name: string): Promise<unknown> =>
    (await pool<{ definition: unknown }[]>`select definition from workflow where name = ${name}`)[0]!.definition;
const snapshotOf = async (id: string): Promise<unknown> =>
    (await pool<{ snapshot: unknown }[]>`select workflow_snapshot as snapshot from job where id = ${id}`)[0]!.snapshot;

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
    const put = async (name: string, definition: unknown) =>
        pool`insert into workflow (org_id, name, definition) values (${org}, ${name}, ${pool.json(definition as never)}::jsonb)`;
    await put('old', graph(OLD));
    await put('mentioning', mentioning);
    await put('autofix', autofix);
    for (const m of malformed)
        await pool`insert into workflow (org_id, name, definition) values (${org}, ${m.name}, ${pool.json(JSON.parse(m.value))}::jsonb)`;
    await pool`insert into job (org_id, id, command, root_job_id, workflow_snapshot)
               values (${org}, ${root}, 'work', ${root}, ${pool.json(graph(OLD) as never)}::jsonb)`;
    await pool.unsafe(readFileSync(new URL(MIGRATION, DIR), 'utf8'));
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

describe.runIf(enabled)('178: the review block id in stored graphs', () => {
    it('renames runtime.block in a definition and a frozen snapshot, changing nothing else', async () => {
        const patchedBack = (value: unknown) => {
            const copy = structuredClone(value) as ReturnType<typeof graph>;
            (copy.nodes[1] as { runtime: { block: string } }).runtime.block = OLD;
            return copy;
        };
        const definition = await definitionOf('old');
        const snapshot = await snapshotOf(root);
        expect((definition as ReturnType<typeof graph>).nodes[1]).toMatchObject({ runtime: { block: NEW } });
        expect((snapshot as ReturnType<typeof graph>).nodes[1]).toMatchObject({ runtime: { block: NEW } });
        expect(patchedBack(definition)).toEqual(graph(OLD));
        expect(patchedBack(snapshot)).toEqual(graph(OLD));
    });

    it('leaves a prompt that names the old id, another block and a definition with no runtime alone', async () => {
        expect(await definitionOf('mentioning')).toEqual(mentioning);
        expect(await definitionOf('autofix')).toEqual(autofix);
    });

    it('leaves a value it cannot read as it was', async () => {
        for (const m of malformed) expect(await definitionOf(m.name)).toEqual(JSON.parse(m.value));
    });

    it('leaves no runtime object naming the old block', async () => {
        const rows = await pool`
            select 1 from workflow where definition::text ~ '"block": "builtin/github-review-reconcile"'
            union all
            select 1 from job where workflow_snapshot::text ~ '"block": "builtin/github-review-reconcile"'`;
        expect(rows).toHaveLength(0);
    });
});
