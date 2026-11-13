import type { Sql } from 'postgres';
import { startIntervalLoop } from '../interval-loop.js';

/** Blocks of the points partition one transaction visits: about 8 MB of heap, so no batch holds its rows for long. */
export const BACKFILL_BATCH_BLOCKS = 1024;
/** How often a replica looks again; once the cursor is done a look is one row read. */
export const METRIC_POINT_ORG_BACKFILL_INTERVAL_MS = 600_000;

export interface BackfillPass {
    /** The cursor has passed the last block: nothing is visited again. */
    done: boolean;
    /** Points this pass gave an org. */
    updated: number;
}

/**
 * Gives every point stored before `metric_point.org_id` existed (145_metric_point_org.sql) the one organization its
 * session evidence names (`metric_point_org_of`); a point no single organization's evidence names keeps a null org and
 * stays out of every view and usage read. The migration cannot do this: it runs in the boot's one transaction, and a
 * table-wide update there would hold the largest table's lock for the whole of it.
 *
 * Bounded and resumable: one transaction per block range of the single partition, the cursor row advanced in the same
 * transaction, so a lost board resumes where its last batch committed. Replicas take turns on the cursor row's lock;
 * one that finds it held leaves the work to the holder. Rows added since the column existed already carry an org (an
 * older board's insert takes one from the fill trigger), so a done cursor is never reopened.
 */
export async function backfillMetricPointOrgs(
    sql: Sql,
    { batchBlocks = BACKFILL_BATCH_BLOCKS, signal }: { batchBlocks?: number; signal?: AbortSignal } = {}
): Promise<BackfillPass> {
    await sql`insert into metric_point_org_backfill default values on conflict do nothing`;
    let updated = 0;
    for (;;) {
        signal?.throwIfAborted();
        const step = await sql.begin(async (tx) => {
            const [cursor] = await tx<{ next_block: string; done_at: Date | null }[]>`
                select next_block, done_at from metric_point_org_backfill for update skip locked
            `;
            if (!cursor) return 'busy' as const;
            if (cursor.done_at) return 'done' as const;
            // The one DEFAULT partition holds every row (001_init.sql); a ctid names a row within it.
            const [size] = await tx<{ blocks: string }[]>`
                select pg_relation_size('metric_point_default') / current_setting('block_size')::bigint as blocks
            `;
            const from = Number(cursor.next_block);
            if (from >= Number(size?.blocks ?? 0)) {
                await tx`update metric_point_org_backfill set done_at = now()`;
                return 'done' as const;
            }
            const to = from + batchBlocks;
            const range = tx`mp.ctid >= ${`(${from},0)`}::tid and mp.ctid < ${`(${to},0)`}::tid`;
            const result = await tx`
                with resolved as (
                    select session_id, metric_point_org_of(session_id) as org_id
                    from (
                        select distinct mp.session_id from metric_point_default mp
                        where ${range} and mp.org_id is null and mp.session_id is not null
                    ) pending
                )
                update metric_point_default mp set org_id = r.org_id
                from resolved r
                where ${range} and mp.org_id is null and mp.session_id = r.session_id and r.org_id is not null
            `;
            await tx`update metric_point_org_backfill set next_block = ${to}`;
            return result.count;
        });
        if (step === 'busy') return { done: false, updated };
        if (step === 'done') return { done: true, updated };
        updated += step;
    }
}

/** The backfill on every replica, after the migrations; a failed pass is retried on the next tick. */
export function startMetricPointOrgBackfill({ sql }: { sql: Sql }): () => Promise<void> {
    return startIntervalLoop(
        'metric-point-org-backfill',
        (signal) => backfillMetricPointOrgs(sql, { signal }),
        METRIC_POINT_ORG_BACKFILL_INTERVAL_MS
    );
}
