import type { Sql } from 'postgres';
import type { ArtifactBackend } from '../artifacts/backend.js';
import type { ObjectStore } from '../artifacts/object-store.js';
import type { ArtifactsConfig } from '../config-artifacts.js';
import type { ServerMetrics } from '../metrics.js';

/**
 * The attachment sweep (docs/persistence.md): abandoned drafts expire, files whose task is gone are
 * reconciled, and a file's object is deleted only after its row committed to `deleting`. Every step is a
 * conditional UPDATE naming the state it expects, so a racing bind (which takes only `ready` rows), another
 * replica or a restart loses cleanly. A failed query aborts the pass: nothing unconfirmed is ever deleted.
 */

/** How often a replica runs a pass. */
export const ATTACHMENT_COLLECT_INTERVAL_MS = 600_000;
const PASS_DEADLINE_MS = 300_000;
const BATCH = 100;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** Rows carry a generated key; only keys under this segment are ever deleted, whatever a row says. */
const ATTACHMENT_SEGMENT = '_attachments/';

export interface AttachmentCollectSummary {
    expired: number;
    orphaned: number;
    deleted: number;
    failed: number;
}

interface DeletingRow {
    org_id: string;
    id: string;
    object_key: string;
}

export interface AttachmentCollector {
    collect(options?: { signal?: AbortSignal; deadlineMs?: number }): Promise<AttachmentCollectSummary>;
}

export function createAttachmentCollector({
    sql,
    ready,
    objects,
    prefix,
    draftTtlHours,
}: {
    sql: Sql;
    ready: Promise<unknown>;
    objects: ObjectStore;
    prefix: string;
    draftTtlHours: number;
}): AttachmentCollector {
    const namespace = `${prefix}${ATTACHMENT_SEGMENT}`;

    /** `pending` and `ready` rows past the TTL, locked with SKIP LOCKED so a binder holding one wins. */
    const expireBatch = async (): Promise<number> =>
        (
            await sql`
                update input_attachment a set state = 'deleting', deleting_at = coalesce(a.deleting_at, now())
                from (
                    select org_id, id from input_attachment
                    where state in ('pending', 'ready') and created_at < now() - make_interval(hours => ${draftTtlHours})
                    order by created_at limit ${BATCH} for update skip locked
                ) c
                where a.org_id = c.org_id and a.id = c.id and a.state in ('pending', 'ready')
                returning a.id
            `
        ).length;

    /** `bound` rows whose job row is gone (deleted outside removeThread), judged in the update's own snapshot. */
    const orphanBatch = async (): Promise<number> =>
        (
            await sql`
                update input_attachment a set state = 'deleting', deleting_at = coalesce(a.deleting_at, now())
                from (
                    select org_id, id from input_attachment x
                    where state = 'bound'
                      and not exists (select 1 from job j where j.org_id = x.org_id and j.id = x.bound_job_id)
                    order by created_at limit ${BATCH} for update skip locked
                ) c
                where a.org_id = c.org_id and a.id = c.id and a.state = 'bound'
                  and not exists (select 1 from job j where j.org_id = a.org_id and j.id = a.bound_job_id)
                returning a.id
            `
        ).length;

    /** Runs a batch step until a short batch says nothing is left, or the pass runs out of time. */
    const drain = async (step: () => Promise<number>, live: () => boolean): Promise<number> => {
        let total = 0;
        for (let n = BATCH; n === BATCH && live(); ) {
            n = await step();
            total += n;
        }
        return total;
    };

    /** One `deleting` row: the object first, then the conditional `deleted`. Returns rows marked, or `failed`. */
    const finish = async (row: DeletingRow): Promise<number | 'failed'> => {
        // A row's key is data; a key outside the attachment namespace is never touched.
        if (!row.object_key.startsWith(namespace)) return 'failed';
        try {
            await objects.delete(row.object_key);
        } catch {
            // Unconfirmed: the row stays `deleting` and the next pass retries it.
            return 'failed';
        }
        const done = await sql`
            update input_attachment set state = 'deleted', deleted_at = now()
            where org_id = ${row.org_id} and id = ${row.id} and state = 'deleting'
            returning id
        `;
        return done.length;
    };

    return {
        async collect({ signal, deadlineMs = PASS_DEADLINE_MS } = {}) {
            await ready;
            const deadline = Date.now() + deadlineMs;
            const live = (): boolean => !signal?.aborted && Date.now() < deadline;
            const summary: AttachmentCollectSummary = { expired: 0, orphaned: 0, deleted: 0, failed: 0 };

            summary.expired = await drain(expireBatch, live);
            summary.orphaned = await drain(orphanBatch, live);

            let last = NIL_UUID;
            for (let more = true; more && live(); ) {
                const batch = await sql<DeletingRow[]>`
                    select org_id, id, object_key from input_attachment
                    where state = 'deleting' and id > ${last} order by id limit ${BATCH}
                `;
                more = batch.length === BATCH;
                for (const row of batch) {
                    last = row.id;
                    if (!live()) break;
                    const outcome = await finish(row);
                    if (outcome === 'failed') summary.failed++;
                    else summary.deleted += outcome;
                }
            }
            return summary;
        },
    };
}

/**
 * Runs a metered collect pass now and then on an interval, on every replica; never overlaps itself and never throws out of
 * the loop. The returned stop clears the timer and aborts the running pass's signal.
 */
export function startAttachmentCollector(
    collector: AttachmentCollector,
    timedPass: <T>(loop: string, fn: () => Promise<T>) => Promise<T>,
    intervalMs = ATTACHMENT_COLLECT_INTERVAL_MS
): () => void {
    const controller = new AbortController();
    let running = false;
    const tick = async () => {
        if (running || controller.signal.aborted) return;
        running = true;
        try {
            await timedPass('attachment_collect', () => collector.collect({ signal: controller.signal }));
        } catch (e) {
            console.error(`[attachments] collect failed: ${(e as Error).message}`);
        } finally {
            running = false;
        }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    return () => {
        clearInterval(timer);
        controller.abort();
    };
}

/** Builds the process's collector over the artifact backend and starts its loop (wired once, from `main.ts`). */
export function startAttachmentSweep({
    sql,
    ready,
    artifacts,
    config,
    metrics,
}: {
    sql: Sql;
    ready: Promise<unknown>;
    artifacts: ArtifactBackend;
    config: ArtifactsConfig;
    metrics: Pick<ServerMetrics, 'timedPass'>;
}): () => void {
    const collector = createAttachmentCollector({
        sql,
        ready,
        objects: artifacts.objects,
        prefix: artifacts.prefix,
        draftTtlHours: config.attachmentDraftTtlHours,
    });
    return startAttachmentCollector(collector, metrics.timedPass);
}
