import type { Sql } from 'postgres';

/**
 * The state of a person's GitLab authorization round trip (`forge_link`, 172): inserted at the start, consumed once at
 * the callback, for its own person and organization only. A replayed, expired or foreign state consumes nothing, and
 * the three are told apart only for the person who owns the row.
 */

export type ForgeLinkPurpose = 'link' | 'activate';

export interface NewForgeLink {
    orgId: string;
    userId: string;
    connectionId: string;
    purpose: ForgeLinkPurpose;
    stateHash: string;
    returnTo: string;
    ttlMs: number;
}

export interface ForgeLink {
    id: string;
    connectionId: string;
    purpose: ForgeLinkPurpose;
    returnTo: string;
}

export interface LinkOwner {
    orgId: string;
    userId: string;
    stateHash: string;
}

export type UnconsumedLink = { failure: 'replayed' | 'expired'; returnTo: string } | { failure: 'state-mismatch' };

/** Finished links older than this are dropped by the next start in the org. */
const RETENTION = '1 day';

export async function insertForgeLink(sql: Sql, input: NewForgeLink): Promise<{ expiresAt: string }> {
    await sql`delete from forge_link where org_id = ${input.orgId} and expires_at < now() - ${RETENTION}::interval`;
    const [row] = await sql<{ expires_at: Date }[]>`
        insert into forge_link (org_id, user_id, connection_id, purpose, state_hash, return_to, expires_at)
        values (${input.orgId}, ${input.userId}, ${input.connectionId}, ${input.purpose}, ${input.stateHash},
                ${input.returnTo}, now() + (${input.ttlMs}::double precision * interval '1 millisecond'))
        returning expires_at
    `;
    return { expiresAt: row!.expires_at.toISOString() };
}

interface Raw {
    id: string;
    connection_id: string;
    purpose: ForgeLinkPurpose;
    return_to: string;
}

/** Consumes the link once, for its own person, before its time is up; null consumed nothing. */
export async function consumeForgeLink(sql: Sql, owner: LinkOwner): Promise<ForgeLink | null> {
    const [row] = await sql<Raw[]>`
        update forge_link set consumed_at = now()
        where org_id = ${owner.orgId} and user_id = ${owner.userId} and state_hash = ${owner.stateHash}
          and consumed_at is null and expires_at > now()
        returning id, connection_id, purpose, return_to
    `;
    return row ? { id: row.id, connectionId: row.connection_id, purpose: row.purpose, returnTo: row.return_to } : null;
}

/** Why a state was not consumed: another person's or an unknown state is `state-mismatch` and names no path. */
export async function classifyUnconsumedLink(sql: Sql, owner: LinkOwner): Promise<UnconsumedLink> {
    const [row] = await sql<{ return_to: string; consumed_at: Date | null }[]>`
        select return_to, consumed_at from forge_link
        where org_id = ${owner.orgId} and user_id = ${owner.userId} and state_hash = ${owner.stateHash}
    `;
    if (!row) return { failure: 'state-mismatch' };
    return { failure: row.consumed_at === null ? 'expired' : 'replayed', returnTo: row.return_to };
}
