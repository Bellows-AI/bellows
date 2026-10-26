import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Launch } from '@factory-ai/core';
import { account, randomGithubId, testOrg } from './fixtures.js';

/**
 * Builds the rows the usage reader joins, through plain inserts, with every identifier generated
 * per call: organizations, accounts, sessions and repositories each carry a unique marker, so a
 * test can search a whole payload for a name that must not be in it. Shared by the token
 * reconciliation, telemetry and stats-scope suites.
 */
export interface World {
    sql: Sql;
    org(): string;
    /** A unique session id (or repo / login) carrying `label`. */
    marker(label: string): string;
    user(label: string): Promise<{ id: string; login: string }>;
    job(row: JobRow): Promise<string>;
    execution(row: ExecutionRow): Promise<void>;
    branch(row: { org: string; agent?: string; session: string; repo: string }): Promise<void>;
    point(row: PointRow): Promise<void>;
}

export interface JobRow {
    org: string;
    id?: string;
    root?: string;
    parent?: string;
    author?: string | null;
    repo?: string | null;
    /** Names the job a review row reviews. */
    reviewOf?: string;
    status?: string;
}

export interface ExecutionRow {
    org: string;
    job: string;
    claim?: number;
    root: string;
    requestingJob?: string;
    requestingRoot?: string;
    author?: string | null;
    repo?: string | null;
    agent?: string | null;
    launch?: Launch;
    adopts?: number;
    origin?: 'claim' | 'backfill';
    /** Null is the backfill row with no known start. */
    start: string | null;
    end?: string | null;
    removed?: boolean;
    sessions: { id: string; agent?: string | null; origin?: 'inferred_at_claim' | 'reported' | 'backfill' }[];
}

export interface PointRow {
    session: string | null;
    field: string;
    value: number;
    time: string;
    agent?: string;
    temporality?: 'delta' | 'cumulative' | 'unspecified';
    startTime?: string;
    source?: 'otel' | 'transcript';
    attrs?: Record<string, string>;
}

const FIELD_METRIC = 'claude_code.token.usage';

export function createWorld(sql: Sql): World {
    const marker = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;
    return {
        sql,
        org: testOrg,
        marker,
        async user(label) {
            const login = marker(label);
            return { id: await account(sql, randomGithubId(), login), login };
        },
        async job(row) {
            const id = row.id ?? randomUUID();
            const root = row.root ?? id;
            const base = [
                row.org,
                id,
                row.status ?? 'succeeded',
                root,
                row.parent ?? null,
                row.author ?? null,
            ] as const;
            if (row.reviewOf) {
                await sql`
                    insert into job (org_id, id, command, status, root_job_id, parent_job_id, created_by, repo,
                                     created_at, review_of, review_key, review_profile, review_spec, review_revision,
                                     review_ref)
                    values (${base[0]}, ${base[1]}, 'review', ${base[2]}, ${base[3]}, ${base[4]}, ${base[5]},
                            ${row.repo ?? null}, now(), ${row.reviewOf}, ${marker('key')}, 'security', '{}'::jsonb,
                            'head:abc', ${`refs/factory/review/${id}`})
                `;
            } else {
                await sql`
                    insert into job (org_id, id, command, status, root_job_id, parent_job_id, created_by, repo, created_at)
                    values (${base[0]}, ${base[1]}, 'work', ${base[2]}, ${base[3]}, ${base[4]}, ${base[5]},
                            ${row.repo ?? null}, now())
                `;
            }
            return id;
        },
        async execution(row) {
            const claim = row.claim ?? 1;
            await sql`insert into job_execution ${sql({
                org_id: row.org,
                job_id: row.job,
                claim_seq: claim,
                root_job_id: row.root,
                requesting_job_id: row.requestingJob ?? null,
                requesting_root_job_id: row.requestingRoot ?? null,
                author_id: row.author ?? null,
                repo: row.repo ?? null,
                agent: row.agent ?? null,
                launch: row.launch ?? 'observed',
                adopts_claim_seq: row.adopts ?? null,
                origin: row.origin ?? 'claim',
                created_at: row.start === null ? null : new Date(row.start),
                ended_at: row.end ? new Date(row.end) : null,
                removed_at: row.removed ? new Date() : null,
            })}`;
            for (const s of row.sessions) {
                await sql`insert into job_execution_session ${sql({
                    org_id: row.org,
                    job_id: row.job,
                    claim_seq: claim,
                    session_id: s.id,
                    agent: s.agent ?? null,
                    origin: s.origin ?? 'reported',
                })}`;
            }
        },
        async branch(row) {
            await sql`insert into session_branch ${sql({
                org_id: row.org,
                agent: row.agent ?? 'claude-code',
                session_id: row.session,
                repo: row.repo,
                branch: 'main',
                head_sha: null,
                first_seen: new Date('2026-09-01T00:00:00Z'),
                last_seen: new Date('2026-09-30T00:00:00Z'),
                samples: 1,
            })}`;
        },
        async point(row) {
            await sql`insert into metric_point ${sql({
                agent: row.agent ?? 'claude-code',
                source: row.source ?? 'otel',
                metric: FIELD_METRIC,
                field: row.field,
                session_id: row.session,
                value: row.value,
                temporality: row.temporality ?? 'delta',
                start_time: row.startTime ? new Date(row.startTime) : null,
                time: new Date(row.time),
                attrs: { type: row.field.slice('tokens_'.length), ...row.attrs },
            })}`;
        },
    };
}
