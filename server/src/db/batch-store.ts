import type { Sql } from 'postgres';
import { recordedBatch, replayInTx, stampKey } from './batch-store-idempotency.js';
import {
    deleteChildren,
    insertChildren,
    listSummaries,
    readRecord,
    refusalOf,
    writeResolved,
} from './batch-store-rows.js';
import {
    acceptBatchTask,
    cancelBatch,
    reconcileBatch,
    reconcileOpenBatches,
    retryBatchTask,
    type RevisionOf,
    type StopThread,
} from './batch-store-schedule.js';
import { BATCH_DRAFT, BATCH_STARTED, type BatchStore } from './batch-store-types.js';

export * from './batch-store-types.js';

/**
 * Batches (059; docs/batches.md): a draft plan, edited whole, then frozen by `start`. The org is
 * bound at construction like every store here. The plan lives in `batch_target`, `batch_stage` and
 * `batch_task` rows; freeze resolves it in place inside the start transaction, and the triggers in
 * 059 refuse a write to a started plan. The SQL is in `batch-store-rows.ts`, the idempotency
 * records in `batch-store-idempotency.ts`.
 */
export function createBatchStore({
    sql,
    orgId,
    ready,
    stop,
    revisionOf,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown>;
    /** The job store's stop, which settles a cancelled batch's moving tasks. */
    stop?: StopThread;
    /** Resolves a target branch's head commit for the attempt record; absent records none. */
    revisionOf?: RevisionOf;
}): BatchStore {
    const gate = async () => {
        if (ready) await ready;
    };
    const deps = { sql, orgId, stop, revisionOf };

    return {
        async create(plan, createdBy, idempotency) {
            await gate();
            const scope = { orgId, createdBy, idempotency };
            return sql.begin(async (tx) => {
                const replayed = await replayInTx(tx, scope);
                if (replayed) {
                    const [row] = await tx<{ version: number }[]>`
                        select version from batch where org_id = ${orgId} and id = ${replayed}
                    `;
                    return { id: replayed, version: row!.version, replayed: true };
                }
                const [batch] = await tx<{ id: string; version: number }[]>`
                    insert into batch (org_id, plan_version, title, default_target, executor, policy, concurrency,
                                       created_by)
                    values (${orgId}, ${plan.planVersion}, ${plan.title}, ${plan.defaultTarget ?? null},
                            ${plan.executor ?? null}, ${plan.policy}, ${plan.concurrency}, ${createdBy})
                    returning id, version
                `;
                await insertChildren(tx, { orgId, id: batch!.id }, plan);
                await stampKey(tx, scope, batch!.id);
                return { id: batch!.id, version: batch!.version };
            });
        },

        async get(id) {
            await gate();
            return readRecord(sql, { orgId, id });
        },

        async list(rootJobId) {
            await gate();
            return listSummaries(sql, orgId, rootJobId);
        },

        async replace(id, version, plan) {
            await gate();
            return sql.begin(async (tx) => {
                const [row] = await tx<{ version: number }[]>`
                    update batch
                    set plan_version = ${plan.planVersion}, title = ${plan.title},
                        default_target = ${plan.defaultTarget ?? null}, executor = ${plan.executor ?? null},
                        policy = ${plan.policy}, concurrency = ${plan.concurrency},
                        version = version + 1, updated_at = now()
                    where org_id = ${orgId} and id = ${id} and version = ${version} and status = ${BATCH_DRAFT}
                    returning version
                `;
                if (!row) return refusalOf(tx, { orgId, id });
                await deleteChildren(tx, { orgId, id });
                await insertChildren(tx, { orgId, id }, plan);
                return { result: 'ok' as const, version: row.version };
            });
        },

        async replayOfStart(createdBy, idempotency) {
            await gate();
            return recordedBatch(sql, { orgId, createdBy, idempotency });
        },

        async start({ id, version, plan, startedBy, idempotency }) {
            await gate();
            const scope = { orgId, createdBy: startedBy, idempotency };
            return sql.begin(async (tx) => {
                if (await replayInTx(tx, scope)) return { result: 'ok' as const, replayed: true };
                // The row lock is what orders this against a concurrent replace: whichever takes it
                // second re-reads the version (or the status) and finds the other's outcome.
                const [row] = await tx<{ status: string; version: number }[]>`
                    select status, version from batch where org_id = ${orgId} and id = ${id} for update
                `;
                if (!row) return { result: 'missing' as const };
                if (row.status === BATCH_STARTED) return { result: 'started' as const };
                if (row.version !== version) return { result: 'stale' as const, version: row.version };

                await writeResolved(tx, { orgId, id }, plan);
                await tx`
                    update batch
                    set status = ${BATCH_STARTED}, started_by = ${startedBy}, started_at = now(), updated_at = now()
                    where org_id = ${orgId} and id = ${id}
                `;
                await stampKey(tx, scope, id);
                return { result: 'ok' as const };
            });
        },

        async reconcile(id) {
            await gate();
            return reconcileBatch(deps, id);
        },

        async reconcileOpen() {
            await gate();
            return reconcileOpenBatches(deps);
        },

        async cancel(id, cancelledBy) {
            await gate();
            return cancelBatch(deps, id, cancelledBy);
        },

        async retry(id, taskKey) {
            await gate();
            return retryBatchTask(deps, id, taskKey);
        },

        async accept(id, taskKey, acceptedBy) {
            await gate();
            return acceptBatchTask(deps, id, taskKey, acceptedBy);
        },
    };
}
