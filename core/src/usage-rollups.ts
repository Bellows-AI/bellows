import { resolveOwnership, sessionKeyId } from './usage-ownership.js';
import type { UsageInput } from './usage.js';
import type { SessionRollup, TelemetryInput, UserRef } from './types.js';

/** A non-token field total of one owned session, keyed by the canonical metric field name. */
export interface SessionFieldTotal {
    agent: string;
    sessionId: string;
    field: string;
    value: number;
}

/** The slice of the usage facts the per-session view reads. */
export interface RollupFacts extends UsageInput {
    users: readonly UserRef[];
    fields: readonly SessionFieldTotal[];
}

/**
 * The per-session view the dashboard aggregates for everything that is not a token figure
 * (counts, active time, lines, edits). One rollup per OWNED session key (agent, session id): the
 * owner decides repo, author and task, never a join on the session id alone. A key with an
 * unresolved or excluded owner has no rollup; its usage is a diagnostic of the usage reducer.
 * A removed task keeps its author and task key: the removal is the usage report's marker.
 */
export function rollupsFromFacts(facts: RollupFacts): TelemetryInput {
    const owners = resolveOwnership(
        facts,
        facts.spans.map((s) => ({ agent: s.agent, sessionId: s.sessionId }))
    );
    const users = new Map<string, UserRef>(facts.users.map((u) => [u.id, u]));
    const fieldsOf = new Map<string, Map<string, number>>();
    for (const row of facts.fields) {
        const id = sessionKeyId(row.agent, row.sessionId);
        const values = fieldsOf.get(id) ?? new Map<string, number>();
        values.set(row.field, row.value);
        fieldsOf.set(id, values);
    }

    const sessions: SessionRollup[] = [];
    for (const span of facts.spans) {
        const id = sessionKeyId(span.agent, span.sessionId);
        const owner = owners.get(id);
        if (owner?.status !== 'resolved') continue;
        // Absent fields stay null: nothing measured is not the same as zero.
        const get = (field: string): number | null => fieldsOf.get(id)?.get(field) ?? null;
        sessions.push({
            sessionId: span.sessionId,
            agent: span.agent,
            repo: owner.repo,
            hook: owner.hook,
            user: owner.authorId === null ? null : (users.get(owner.authorId) ?? null),
            taskKey: owner.taskId,
            firstSeen: span.firstSeen,
            lastSeen: span.lastSeen,
            linesAdded: get('lines_added'),
            linesRemoved: get('lines_removed'),
            editsAccepted: get('edits_accept'),
            editsRejected: get('edits_reject'),
            activeSeconds: get('active_seconds'),
            commits: get('commits'),
        });
    }
    const from = sessions.map((s) => s.firstSeen).sort();
    const to = sessions.map((s) => s.lastSeen).sort();
    return { sessions, coverage: { from: from[0] ?? null, to: to.at(-1) ?? null } };
}
