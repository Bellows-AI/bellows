import {
    resolveOwnership,
    sessionKeyId,
    type SessionRollup,
    type TelemetryInput,
    type TokenTotals,
    type UserRef,
} from '@factory-ai/core';
import type { CanonicalField } from './metric-map.js';
import type { UsageFacts } from './usage-facts.js';

/** Fields absent stay null: nothing measured is not the same as zero. */
function pick(values: Map<CanonicalField, number>) {
    const get = (field: CanonicalField) => values.get(field) ?? null;
    const tokens: TokenTotals = {
        input: get('tokens_input'),
        output: get('tokens_output'),
        cacheRead: get('tokens_cacheRead'),
        cacheCreation: get('tokens_cacheCreation'),
    };
    return {
        tokens,
        linesAdded: get('lines_added'),
        linesRemoved: get('lines_removed'),
        editsAccepted: get('edits_accept'),
        editsRejected: get('edits_reject'),
        activeSeconds: get('active_seconds'),
        commits: get('commits'),
    };
}

/**
 * The per-session view the dashboard still aggregates. One rollup per OWNED session key
 * (agent, session id): the owner decides repo, author and task, never a join on the session id
 * alone. A key with an unresolved or excluded owner has no rollup; its usage is a diagnostic of
 * the usage reducer, not a session.
 *
 * A removed task keeps its tokens in the totals but names neither task nor author, as before:
 * the canonical removed state is the usage report's (D3).
 */
export function rollupsFromFacts(facts: UsageFacts): TelemetryInput {
    const owners = resolveOwnership(
        facts,
        facts.spans.map((s) => ({ agent: s.agent, sessionId: s.sessionId }))
    );
    const users = new Map<string, UserRef>(facts.users.map((u) => [u.id, u]));
    const fieldsOf = new Map<string, Map<CanonicalField, number>>();
    for (const row of facts.fields) {
        const id = sessionKeyId(row.agent, row.sessionId);
        const values = fieldsOf.get(id) ?? new Map<CanonicalField, number>();
        values.set(row.field, row.value);
        fieldsOf.set(id, values);
    }

    const sessions: SessionRollup[] = [];
    for (const span of facts.spans) {
        const id = sessionKeyId(span.agent, span.sessionId);
        const owner = owners.get(id);
        if (owner?.status !== 'resolved') continue;
        sessions.push({
            sessionId: span.sessionId,
            agent: span.agent,
            repo: owner.repo,
            hook: owner.hook,
            user: owner.removed || owner.authorId === null ? null : (users.get(owner.authorId) ?? null),
            taskKey: owner.removed ? null : owner.taskId,
            firstSeen: span.firstSeen,
            lastSeen: span.lastSeen,
            ...pick(fieldsOf.get(id) ?? new Map()),
        });
    }
    const from = sessions.map((s) => s.firstSeen).sort();
    const to = sessions.map((s) => s.lastSeen).sort();
    return { sessions, coverage: { from: from[0] ?? null, to: to.at(-1) ?? null } };
}
