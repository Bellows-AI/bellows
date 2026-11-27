import type { TransactionSql } from 'postgres';
import { type AuditEntry, recordAudit } from './audit-log.js';
import { revokeGrantIfOrphaned } from './connection-grants.js';

/**
 * THE way the board ends a member's connection on its own account, never the member's (a disconnect is theirs,
 * `connection-store.ts`): the member left the organization, the provider no longer lets the account reach the
 * site, or the provider refused the refresh for good. In the caller's transaction it disconnects the connections
 * (credential and stored label gone), writes one `connection.revoke` audit row each, and revokes every grant left
 * with no active connection, so the secret is destroyed by the next recovery pass (`integration-recovery.ts`).
 * The membership removal (`auth/member-removal.ts`) and the site access re-check (`integrations/site-access.ts`)
 * both call it; BEL-601's account reports are meant to as well.
 *
 * Lock order is the one of `connection-bindings.ts`: member rows, then the grant, then the connection. No thread
 * root is locked: a binding that lands on a connection revoked meanwhile is refused at use like any disconnected one.
 * `server/test-db/connection-revocation.test.ts`.
 */

/** Why the board ended the connection; written to the audit row. */
export type RevocationReason = 'member-removed' | 'site-access-lost' | 'grant-refused';

export type RevocationTarget =
    /** Every active OAuth connection a member holds in `orgIds`. */
    | { kind: 'leaver'; userId: string; orgIds: readonly string[] }
    /** Every active connection under one grant: the provider refused the grant itself. */
    | { kind: 'grant'; orgId: string; grantId: string }
    /** One connection: its site is gone from the account's accessible resources. */
    | { kind: 'connection'; orgId: string; connectionId: string };

export interface RevocationResult {
    /** The connections this call ended. */
    connectionIds: string[];
    /** The grants it left with nothing active and so revoked. */
    revokedGrantIds: string[];
}

interface Candidate {
    id: string;
    org_id: string;
    grant_id: string | null;
}

export async function revokeConnectionsInTx(
    tx: TransactionSql,
    target: RevocationTarget,
    cause: { actor: AuditEntry['actor']; reason: RevocationReason }
): Promise<RevocationResult> {
    const orgIds = target.kind === 'leaver' ? [...target.orgIds] : [target.orgId];
    const scope =
        target.kind === 'leaver'
            ? tx`principal_user_id = ${target.userId}`
            : target.kind === 'grant'
              ? tx`grant_id = ${target.grantId}`
              : tx`id = ${target.connectionId}`;
    const found = await tx<Candidate[]>`
        select id, org_id, grant_id from connector_connection
        where org_id = any(${orgIds}::text[]) and status = 'active' and credential = 'oauth_grant' and ${scope}
    `;
    // A grant with no connection left in it (it was found by its own id) is still the caller's to retire.
    const grants = new Map<string, string>();
    for (const row of found) if (row.grant_id) grants.set(row.grant_id, row.org_id);
    if (target.kind === 'grant') grants.set(target.grantId, target.orgId);
    for (const [grantId, orgId] of [...grants].sort(([a], [b]) => (a < b ? -1 : 1))) {
        await tx`select id from integration_grant where id = ${grantId} and org_id = ${orgId} for update`;
    }
    const ended = await tx<{ id: string; org_id: string; site: string }[]>`
        update connector_connection
        set status = 'disconnected', disconnected_at = now(), api_token = null, email = ''
        where id = any(${found.map((row) => row.id)}::uuid[]) and status = 'active'
        returning id, org_id, site
    `;
    for (const row of ended) {
        await recordAudit(tx, {
            orgId: row.org_id,
            actor: cause.actor,
            action: 'connection.revoke',
            target: row.id,
            detail: { reason: cause.reason, site: row.site },
        });
    }
    const revokedGrantIds: string[] = [];
    for (const [grantId, orgId] of grants) {
        if (await revokeGrantIfOrphaned(tx, orgId, grantId)) revokedGrantIds.push(grantId);
    }
    return { connectionIds: ended.map((row) => row.id), revokedGrantIds };
}
