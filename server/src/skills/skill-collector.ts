import type { Sql } from 'postgres';
import type { ArtifactBackend } from '../artifacts/backend.js';
import type { ObjectStore } from '../artifacts/object-store.js';
import type { ServerMetrics } from '../metrics.js';
import { lockObjectKey, skillKeyNamespace } from '../db/skill-store.js';
import { startIntervalLoop } from '../interval-loop.js';

/**
 * The skill retention sweep (docs/skills.md). A version is removed only when (a) its skill was soft-deleted at least
 * `retentionDays` ago AND (b) no job
 * references it (`findReferencedVersions`, which reads `job.skill_pin`). The object follows its last row, under
 * the same per-key lock the writer takes, so a writer re-creating the same content cannot lose its object. Any query
 * that fails aborts the pass and any object delete that is unconfirmed leaves its row: nothing unconfirmed is deleted.
 */

export const SKILL_COLLECT_INTERVAL_MS = 3_600_000;
const BATCH = 100;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Which of these version ids a job row still pins (`job.skill_pin`, 129). Every status counts: a retry of a terminal job
 * copies the pin. A failure here must throw, never answer an empty set: the pass aborts and nothing is deleted.
 */
export async function findReferencedVersions(sql: Sql, versionIds: string[]): Promise<Set<string>> {
    if (versionIds.length === 0) return new Set();
    const rows = await sql<{ id: string }[]>`
        select v.id::text as id
        from unnest(${sql.array(versionIds)}::uuid[]) as v(id)
        where exists (
            select 1 from job j
            where j.skill_pin <> '[]'::jsonb
              and j.skill_pin @> jsonb_build_array(jsonb_build_object('versionId', v.id::text))
        )
    `;
    return new Set(rows.map((row) => row.id));
}

export interface SkillCollectSummary {
    /** Version rows removed. */
    versions: number;
    /** Objects deleted (the last row naming them went). */
    objects: number;
    /** Soft-deleted skill rows removed once nothing was left under them. */
    skills: number;
    /** Candidates left for the next pass. */
    failed: number;
}

export interface SkillCollector {
    collect(options?: { signal?: AbortSignal; deadlineMs?: number }): Promise<SkillCollectSummary>;
}

interface Candidate {
    id: string;
    object_key: string;
}

export function createSkillCollector({
    sql,
    objects,
    prefix,
    retentionDays,
    referenced = (ids) => findReferencedVersions(sql, ids),
}: {
    sql: Sql;
    objects: ObjectStore;
    prefix: string;
    retentionDays: number;
    /** Tests only: replaces the job-reference query. */
    referenced?: (versionIds: string[]) => Promise<Set<string>>;
}): SkillCollector {
    const namespace = skillKeyNamespace(prefix);

    /** The one eligibility rule, restated inside the delete so a racing writer or restore loses cleanly. */
    const eligible = sql`(
        (s.deleted_at is not null and s.deleted_at < now() - make_interval(days => ${retentionDays}))
    )`;

    /** One candidate: row first, then (if it was the last name for the key) the object, all under the key's lock. */
    async function sweepOne(row: Candidate): Promise<{ objectDeleted: boolean } | 'skipped'> {
        if (!row.object_key.startsWith(namespace)) throw new Error('object key outside the skill namespace');
        return sql.begin(async (tx) => {
            await lockObjectKey(tx, row.object_key);
            const gone = await tx`
                delete from skill_version v using skill s
                where v.id = ${row.id} and s.id = v.skill_id and ${eligible}
                returning v.id
            `;
            if (gone.length === 0) return 'skipped';
            const [other] = await tx`select 1 from skill_version where object_key = ${row.object_key} limit 1`;
            if (other) return { objectDeleted: false };
            // A throw rolls the row delete back: the next pass retries both.
            await objects.delete(row.object_key);
            return { objectDeleted: true };
        });
    }

    /** One candidate into the summary: a throw (unconfirmed delete, foreign key) leaves the row for the next pass. */
    async function tally(row: Candidate, summary: SkillCollectSummary): Promise<void> {
        try {
            const outcome = await sweepOne(row);
            if (outcome === 'skipped') return;
            summary.versions++;
            if (outcome.objectDeleted) summary.objects++;
        } catch {
            summary.failed++;
        }
    }

    /** Sweeps one page of candidates; returns how many rows the page held. */
    async function sweepPage(last: string, summary: SkillCollectSummary, live: () => boolean): Promise<Candidate[]> {
        const batch = await sql<Candidate[]>`
            select v.id, v.object_key from skill_version v join skill s on s.id = v.skill_id
            where v.id > ${last} and ${eligible}
            order by v.id limit ${BATCH}
        `;
        if (batch.length === 0) return batch;
        // A failed or timed-out reference check aborts the pass: unreferenced is never assumed.
        const pinned = await referenced(batch.map((r) => r.id));
        for (const row of batch.filter((r) => !pinned.has(r.id))) {
            if (!live()) break;
            await tally(row, summary);
        }
        return batch;
    }

    return {
        async collect({ signal, deadlineMs = SKILL_COLLECT_INTERVAL_MS } = {}) {
            const deadline = Date.now() + deadlineMs;
            const live = (): boolean => !signal?.aborted && Date.now() < deadline;
            const summary: SkillCollectSummary = { versions: 0, objects: 0, skills: 0, failed: 0 };
            for (let last = NIL_UUID; live(); ) {
                const batch = await sweepPage(last, summary, live);
                if (batch.length < BATCH) break;
                last = batch[batch.length - 1]!.id;
            }
            const emptied = await sql`
                delete from skill s
                where s.deleted_at < now() - make_interval(days => ${retentionDays})
                  and not exists (select 1 from skill_version v where v.skill_id = s.id)
                returning s.id
            `;
            summary.skills = emptied.length;
            return summary;
        },
    };
}

/** Runs a metered collect pass on an interval on every replica; never overlaps itself and never throws out of the loop. */
export function startSkillSweep({
    sql,
    ready,
    artifacts,
    metrics,
    retentionDays,
    intervalMs = SKILL_COLLECT_INTERVAL_MS,
}: {
    sql: Sql;
    ready: Promise<unknown>;
    artifacts: ArtifactBackend;
    metrics: Pick<ServerMetrics, 'timedPass'>;
    /** `ArtifactsConfig.retentionDays`: how long a deleted skill's versions stay. */
    retentionDays: number;
    intervalMs?: number;
}): () => Promise<void> {
    const collector = createSkillCollector({
        sql,
        objects: artifacts.objects,
        prefix: artifacts.prefix,
        retentionDays,
    });
    return startIntervalLoop(
        'skills',
        async (signal) => {
            await ready;
            await metrics.timedPass('skill_collect', () => collector.collect({ signal }));
        },
        intervalMs,
        { onError: (e) => console.error(`[skills] collect failed: ${e.message}`) }
    );
}
