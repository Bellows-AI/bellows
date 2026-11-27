import type { Fragment, Sql, TransactionSql } from 'postgres';

/**
 * Where a member stands on a forge, defined once in SQL (docs/connections.md): the member's newest non-revoked grant
 * is `live` when it is active with a stored secret that is not wedged, `broken` otherwise, and the member has none
 * (`missing`) when there is no such row. Everything that asks — the grant store's `standing`, the claim's forge hold,
 * the claimability predicate — reads this expression, never a copy of it.
 */
export type GrantStanding = 'live' | 'broken' | 'missing';

type Operand = Fragment | string;
type Db = Sql | TransactionSql;

/** `live` or `broken` for the grant row `g`: the one definition of a usable grant. */
const standingOf = (sql: Db): Fragment => sql`case when g.status = 'active' and g.secret_ref is not null
    and g.secret_version is not null and g.secret_wedged_at is null then 'live' else 'broken' end`;

/** The member's newest non-revoked grant on the forge (the row the standing judges), with a total order on ties. */
const newestGrant = (sql: Db, who: { orgId: Operand; userId: Operand; forge: Operand }): Fragment => sql`
    from integration_grant g
    where g.org_id = ${who.orgId} and g.principal_user_id = ${who.userId} and g.provider = ${who.forge}
      and g.status <> 'revoked'
      and (g.forge_connection_id is null or exists (
          select 1 from forge_connection c
          where c.org_id = g.org_id and c.id = g.forge_connection_id and c.removed_at is null and c.active
      ))
    order by g.updated_at desc, g.id desc
    limit 1`;

/** The scalar subquery: `'live'`, `'broken'` or null (no grant). Operands are columns (fragments) or values. */
export const grantStandingExpr = (sql: Db, who: { orgId: Operand; userId: Operand; forge: Operand }): Fragment =>
    sql`(select ${standingOf(sql)} ${newestGrant(sql, who)})`;

/** The row the standing judged and what it holds, read in one statement: null when the member has no such grant. */
export async function readGrantStandingRow(
    db: Db,
    who: { orgId: string; userId: string; forge: string }
): Promise<{ standing: 'live' | 'broken'; externalAccountId: string; forgeProfile: unknown } | null> {
    const [row] = await db<{ standing: 'live' | 'broken'; external_account_id: string; forge_profile: unknown }[]>`
        select ${standingOf(db)} as standing, g.external_account_id, g.forge_profile ${newestGrant(db, who)}
    `;
    return row
        ? { standing: row.standing, externalAccountId: row.external_account_id, forgeProfile: row.forge_profile }
        : null;
}

/** Reads the standing inside a claim's transaction. */
export type ForgeStandingReader = (
    tx: TransactionSql,
    who: { orgId: string; userId: string; forge: string }
) => Promise<GrantStanding>;

/** The standing on `db`'s org scope (the claim's transaction, or an org-scoped pool). A failed read throws. */
export async function readGrantStanding(
    db: Db,
    who: { orgId: string; userId: string; forge: string }
): Promise<GrantStanding> {
    const [row] = await db<{ standing: 'live' | 'broken' | null }[]>`select ${grantStandingExpr(db, who)} as standing`;
    if (!row) throw new Error('the grant standing read returned no row');
    return row.standing ?? 'missing';
}
