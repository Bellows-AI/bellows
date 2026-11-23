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

/** The scalar subquery: `'live'`, `'broken'` or null (no grant). Operands are columns (fragments) or values. */
export const grantStandingExpr = (sql: Db, who: { orgId: Operand; userId: Operand; forge: Operand }): Fragment => sql`(
    select case when g.status = 'active' and g.secret_ref is not null and g.secret_version is not null
                     and g.secret_wedged_at is null then 'live' else 'broken' end
    from integration_grant g
    where g.org_id = ${who.orgId} and g.principal_user_id = ${who.userId} and g.provider = ${who.forge}
      and g.status <> 'revoked'
    order by g.updated_at desc
    limit 1
)`;

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
