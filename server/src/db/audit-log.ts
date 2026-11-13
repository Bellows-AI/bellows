import type { Sql, TransactionSql } from 'postgres';

/**
 * The organization's audit log (docs/persistence.md, `138_audit_event.sql`): an append-only row per audited action,
 * written by `recordAudit` inside the action's own transaction, so an action never commits without its row and a
 * rolled-back one leaves none. `detail` names what changed and never a credential value.
 */

/** Who acted. `operator` is the board operator's principal; `system` is the board itself. */
export type AuditActorKind = 'user' | 'org_token' | 'operator' | 'system';

export type AuditAction =
    | 'auth.sign_in'
    | 'token.personal.mint'
    | 'token.personal.revoke'
    | 'token.org.mint'
    | 'token.org.revoke'
    | 'member.role'
    | 'member.remove'
    | 'member.restore'
    | 'env.write'
    | 'connection.connect'
    | 'connection.disconnect'
    | 'connection.access'
    | 'task.admin_action';

/** Names and flags only: a value here is never a token, secret or credential. */
export type AuditDetail = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export interface AuditEntry {
    orgId: string;
    actor: { kind: AuditActorKind; id: string | null };
    action: AuditAction;
    target: string | null;
    detail?: AuditDetail;
}

/** A user's action — every audited write a person makes over HTTP. */
export const userActor = (userId: string): AuditEntry['actor'] => ({ kind: 'user', id: userId });

/** Appends one row inside the caller's transaction. */
export async function recordAudit(tx: TransactionSql, entry: AuditEntry): Promise<void> {
    await tx`
        insert into audit_event (org_id, actor_kind, actor_id, action, target, detail)
        values (${entry.orgId}, ${entry.actor.kind}, ${entry.actor.id}, ${entry.action}, ${entry.target},
                ${tx.json((entry.detail ?? {}) as never)})
    `;
}

/** One exported row, as `GET /api/audit` streams it. `actorLogin` is the acting user's login, when a user acted. */
export interface AuditEventView {
    id: string;
    at: string;
    actorKind: AuditActorKind;
    actorId: string | null;
    actorLogin: string | null;
    action: string;
    target: string | null;
    detail: Record<string, unknown>;
}

/** `[from, to)`: `to` is exclusive. */
export interface AuditRange {
    from: Date;
    to: Date;
}

interface Row {
    id: string;
    at: Date;
    actor_kind: AuditActorKind;
    actor_id: string | null;
    actor_login: string | null;
    action: string;
    target: string | null;
    detail: Record<string, unknown>;
}

/** Rows per cursor fetch: the export holds one batch in memory, never the range. */
const BATCH = 200;

/**
 * The org's rows in `range`, oldest first, read through a cursor. Stopping the iteration early (a `break`, a
 * `return()` from a destroyed stream) or a failed fetch closes the cursor and releases its connection.
 */
export async function* readAuditEvents(sql: Sql, orgId: string, range: AuditRange): AsyncGenerator<AuditEventView> {
    const cursor = sql<Row[]>`
        select a.id, a.at, a.actor_kind, a.actor_id, u.github_login as actor_login, a.action, a.target, a.detail
        from audit_event a
        left join app_user u on a.actor_kind = 'user' and u.id::text = a.actor_id
        where a.org_id = ${orgId} and a.at >= ${range.from} and a.at < ${range.to}
        order by a.at, a.id
    `.cursor(BATCH);
    for await (const rows of cursor) {
        for (const row of rows) {
            yield {
                id: row.id,
                at: row.at.toISOString(),
                actorKind: row.actor_kind,
                actorId: row.actor_id,
                actorLogin: row.actor_login,
                action: row.action,
                target: row.target,
                detail: row.detail,
            };
        }
    }
}
