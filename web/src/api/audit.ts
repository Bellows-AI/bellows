import { request } from './request.js';

/**
 * The organization's audit log, as `GET /api/audit` streams it: one JSON object per line over `[from, to)`. An admin
 * read; the section never issues it for a member.
 */

/** One row. `actorLogin` names the acting account when a person acted; `detail` names what changed, never a secret. */
export interface AuditEvent {
    id: string;
    at: string;
    actorKind: 'user' | 'org_token' | 'operator' | 'system';
    actorId: string | null;
    actorLogin: string | null;
    action: string;
    target: string | null;
    detail: Record<string, unknown>;
}

/** The parsed rows and the answer's own bytes, which an export saves unchanged. */
export interface AuditLog {
    events: AuditEvent[];
    file: Blob;
}

const DAY_MS = 86_400_000;

/** The day after a `YYYY-MM-DD`, so the picked end day is inside the half-open range. */
const nextDay = (day: string): string => new Date(Date.parse(day) + DAY_MS).toISOString().slice(0, 10);

const isEvent = (row: unknown): row is AuditEvent =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as AuditEvent).id === 'string' &&
    typeof (row as AuditEvent).at === 'string' &&
    typeof (row as AuditEvent).action === 'string';

function parseLines(text: string): AuditEvent[] | null {
    const events: AuditEvent[] = [];
    for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let row: unknown;
        try {
            row = JSON.parse(line);
        } catch {
            return null;
        }
        if (!isEvent(row)) return null;
        events.push(row);
    }
    return events;
}

export type AuditRead = { ok: true; log: AuditLog } | { ok: false; error: string; aborted?: true };

/** The log from the first day through the last, both `YYYY-MM-DD` (UTC). */
export async function readAuditLog(fromDay: string, toDay: string, signal?: AbortSignal): Promise<AuditRead> {
    const result = await request<Blob>(`/api/audit?from=${fromDay}&to=${nextDay(toDay)}`, {
        blob: true,
        verb: 'Could not read the audit log',
        ...(signal ? { signal } : {}),
    });
    if (!result.ok) return { ok: false, error: result.error, ...(result.aborted ? { aborted: true as const } : {}) };
    const events = parseLines(await result.value.text());
    if (!events) return { ok: false, error: 'The audit log answer was malformed' };
    return { ok: true, log: { events, file: result.value } };
}

/** Saves the answer as `<name>.ndjson` through an object-URL anchor. */
export function saveAuditLog(file: Blob, name: string): void {
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${name}.ndjson`;
    document.body.append(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}
