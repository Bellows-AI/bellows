import { request } from './request.js';

/**
 * The organization's retention window, as `GET /api/org/retention` answers it (server/src/db/org-retention.ts): `days`
 * null is unlimited; `pending` is a shorter window and the moment it applies, while its 30-day notice runs.
 */
export interface Retention {
    days: number | null;
    pending: { days: number; effectiveAt: string } | null;
}

const isRetention = (body: unknown): body is Retention => {
    if (typeof body !== 'object' || body === null) return false;
    const { days, pending } = body as Retention;
    const pendingOk =
        pending === null ||
        (typeof pending === 'object' && typeof pending.days === 'number' && typeof pending.effectiveAt === 'string');
    return (days === null || typeof days === 'number') && pendingOk;
};

export type RetentionRead = { ok: true; retention: Retention } | { ok: false; error: string; aborted?: true };

export async function readRetention(signal?: AbortSignal): Promise<RetentionRead> {
    const result = await request<Retention>('/api/org/retention', {
        verb: 'Could not read the retention window',
        guard: isRetention,
        ...(signal ? { signal } : {}),
    });
    if (!result.ok) return { ok: false, error: result.error, ...(result.aborted ? { aborted: true as const } : {}) };
    return { ok: true, retention: result.value };
}

const DAY_MS = 86_400_000;

/** The day a thread settled at `settledAt` is deleted under `days`, or null when nothing deletes it. */
export function deletionDay(settledAt: string | null, days: number | null): Date | null {
    if (settledAt === null || days === null) return null;
    const at = Date.parse(settledAt);
    return Number.isNaN(at) ? null : new Date(at + days * DAY_MS);
}
