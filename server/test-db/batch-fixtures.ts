import { expect } from 'vitest';
import type { Sql } from 'postgres';
import { resolveBatchPlan, validateBatchPlan, type BatchPlan, type PrFacts } from '@factory-ai/core';
import type { BatchStore } from '../src/db/batches/batch-store.js';
import type { PrLifecycleStore } from '../src/db/pr-lifecycle-store.js';
import { startRow } from './fixtures.js';

/** Builders the batch-* db suites share; each suite binds them to its own stores and author. */

/** The one target repo every batch suite plans against. */
export const BATCH_REPO = 'acme/web';

/** A task whose gate is the PR its run publishes. */
export const prTask = (key: string) => ({
    key,
    objective: `do ${key}`,
    acceptance: `${key} works`,
    verification: 'npm test',
    completion: { kind: 'pr' },
});

/** A validated one-target plan; `extra` overrides concurrency or adds budgets. Throws on a refusal. */
export function batchPlan(title: string, stages: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
    const result = validateBatchPlan({
        planVersion: 1,
        title,
        targets: [{ key: 'web', repo: BATCH_REPO }],
        defaultTarget: 'web',
        executor: 'claude',
        concurrency: 2,
        ...extra,
        stages,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.plan;
}

/** A frozen batch, not yet dispatched: start queues nothing, reconcile is dispatch. */
export async function startBatch(store: BatchStore, source: BatchPlan, startedBy: string): Promise<string> {
    const { id } = await store.create(source, startedBy);
    const started = await store.start({
        id,
        version: 1,
        plan: resolveBatchPlan(source, { [BATCH_REPO]: 'main' }),
        startedBy,
    });
    expect(started).toMatchObject({ result: 'ok' });
    return id;
}

export const rootOf = async (store: BatchStore, id: string, key: string): Promise<string> =>
    (await store.get(id))!.tasks.find((t) => t.key === key)!.rootJobId!;

/** The thread's newest job, whatever a retry has added. */
export async function headOf(sql: Sql, root: string) {
    const [row] = await sql<{ id: string; status: string }[]>`
        select id, status from job where root_job_id = ${root} order by created_at desc, id desc limit 1
    `;
    return row!;
}

export async function setSucceeded(sql: Sql, root: string) {
    const head = await headOf(sql, root);
    await startRow(sql, head.id);
    await sql`update job set status = 'succeeded', finished_at = now(), lease_token = null where id = ${head.id}`;
}

export const jobCount = async (sql: Sql) => Number((await sql`select count(*) from job`)[0]!.count);

/** Records the PR a task's thread published, as the verdict's publication does. */
export const recordPr = (
    prs: PrLifecycleStore,
    root: string,
    prNumber: number,
    { repo = BATCH_REPO, base = 'main' }: { repo?: string; base?: string } = {}
) =>
    prs.recordPublication({
        root,
        repo,
        prNumber,
        prUrl: `https://github.com/${repo}/pull/${prNumber}`,
        headBranch: `factory/${root}`,
        baseBranch: base,
    });

export const checks = (state: 'passing' | 'failing' | 'pending') => [
    { name: 'build', state, url: 'https://ci/1', detail: null },
];

/** What the fake GitHub answers for an open, mergeable, green PR unless `extra` says otherwise. */
export const facts = (number: number, extra: Partial<PrFacts> = {}): PrFacts => ({
    repo: BATCH_REPO,
    number,
    url: `https://github.com/${BATCH_REPO}/pull/${number}`,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    updatedAt: null,
    baseBranch: 'main',
    headSha: 'h1',
    targetSha: 't1',
    mergeable: true,
    requiredContexts: ['build'],
    requiredApprovals: 0,
    approvals: 0,
    checks: checks('passing'),
    ...extra,
});
