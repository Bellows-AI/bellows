import { UUID } from '../identifiers.js';
import type { JobStatus, TaskState } from './jobs/job-store-types.js';

/**
 * The task read model's pure half: the terminal set and the cursor that pages `GET /api/tasks`.
 * The buckets, navigation and ordering are the store's SQL (`job-store-reads.ts`).
 */

/** The terminal set: the statuses a run ends with. `dead` is the board's verdict, never a worker's. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'dead', 'stopped'];

/**
 * The pagination cursor: the keyset position plus the exact query it was minted under, so a
 * cursor cannot silently be reused with different filters — that would answer page 2 of a
 * different question. Base64url JSON: opaque to a client, trivially auditable here.
 */
export interface TaskCursor {
    v: number;
    sort: 'newest' | 'oldest';
    state: TaskState;
    q?: string | undefined;
    repo?: string | undefined;
    author?: string | undefined;
    /** The keyset position: the last returned row's activity stamp and root id. */
    activityAt: string;
    rootId: string;
}

const CURSOR_VERSION = 1;

/** The filters a cursor binds — the fields of `TaskListFilters` the store normalizes before use. */
export type TaskCursorFilters = Pick<TaskCursor, 'sort' | 'state' | 'q' | 'repo' | 'author'>;

export function encodeCursor(payload: Omit<TaskCursor, 'v'>): string {
    const cursor: TaskCursor = { v: CURSOR_VERSION, ...payload };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor issued by this endpoint, or null for anything a client may have invented:
 * malformed, version-stale, minted under a different sort, or carrying filters that differ from
 * the request's normalized ones — an absent filter is itself a bound value.
 */
export function decodeCursor(raw: string, expected: TaskCursorFilters): TaskCursor | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const cursor = parsed as Record<string, unknown>;
    if (cursor.v !== CURSOR_VERSION) return null;
    if (cursor.sort !== expected.sort || cursor.state !== expected.state) return null;
    for (const key of ['q', 'repo', 'author'] as const) {
        if (cursor[key] !== expected[key]) return null;
    }
    // The minted shape is exact ISO — a parseable-but-non-ISO stamp would survive here and die
    // later at the SQL cast, a 503 where BAD_CURSOR is the truthful answer.
    const stamp = typeof cursor.activityAt === 'string' ? new Date(cursor.activityAt) : null;
    if (stamp === null || Number.isNaN(stamp.getTime()) || stamp.toISOString() !== cursor.activityAt) {
        return null;
    }
    if (typeof cursor.rootId !== 'string' || !UUID.test(cursor.rootId)) return null;
    return cursor as unknown as TaskCursor;
}
