import type { Fragment, Sql, TransactionSql } from 'postgres';
import { grantStandingExpr } from './forge-grant-standing.js';

type Db = Sql | TransactionSql;

/**
 * The forge start gate's wait, as an open row of `job_integration_requirement` (docs/connections.md): provider
 * `forge`, target the forge (`github`), source `create`. The claim opens it when the thread starter's grant is not
 * live and closes it the moment it is; a re-link closes it early for the page. It is never dismissed.
 */
export const FORGE_PROVIDER = 'forge';

/** Why the thread waits: no grant, a grant needing reconnect, or a starter that no longer exists. */
export type ForgeRequirementReason = 'missing' | 'reconnect' | 'starter-removed';

/** Opens the root's forge requirement, or restates its reason when one is already open. */
export async function openForgeRequirement(
    db: Db,
    args: { orgId: string; rootJobId: string; forge: string; reason: ForgeRequirementReason }
): Promise<void> {
    await db`
        insert into job_integration_requirement (org_id, root_job_id, provider, reason, target, source)
        values (${args.orgId}, ${args.rootJobId}, ${FORGE_PROVIDER}, ${args.reason}, ${args.forge}, 'create')
        on conflict (org_id, root_job_id, provider) where satisfied_at is null
        do update set reason = excluded.reason, target = excluded.target
    `;
}

/** Closes the root's open forge requirement as bound by its starter: the grant is live. */
export async function closeForgeRequirement(
    db: Db,
    args: { orgId: string; rootJobId: string; userId: string }
): Promise<void> {
    await db`
        update job_integration_requirement
        set satisfied_at = now(), outcome = 'bound', closed_by = ${args.userId}
        where org_id = ${args.orgId} and root_job_id = ${args.rootJobId} and provider = ${FORGE_PROVIDER}
          and satisfied_at is null
    `;
}

/**
 * A member's grant became live again: closes every open forge requirement of the member's threads on that forge in the
 * org. Takes no lock beyond the requirement rows; the claim heals whatever this misses.
 */
export async function closeForgeRequirementsOfMember(
    db: Db,
    args: { orgId: string; userId: string; forge: string }
): Promise<void> {
    await db`
        update job_integration_requirement q
        set satisfied_at = now(), outcome = 'bound', closed_by = ${args.userId}
        from job root
        where q.org_id = ${args.orgId} and q.provider = ${FORGE_PROVIDER} and q.target = ${args.forge}
          and q.satisfied_at is null
          and root.org_id = q.org_id and root.id = q.root_job_id and root.execution_user_id = ${args.userId}
    `;
}

/**
 * The claimability predicate's exception (`job-store-claim.ts`): `requirement` (an alias for a
 * `job_integration_requirement` row) is a forge wait the claim ignores — the gate is off, or the thread starter's grant
 * is live now, so the acquire closes it. A missing starter or grant is not live and the wait holds.
 */
export const forgeWaitIgnored = (sql: Sql, gateOn: boolean, requirement: Fragment): Fragment => sql`(
    ${requirement}.provider = ${FORGE_PROVIDER}
    and (not ${gateOn}::boolean or coalesce(${grantStandingExpr(sql, {
        orgId: sql`${requirement}.org_id`,
        userId: sql`(select r.execution_user_id from job r
                     where r.org_id = ${requirement}.org_id and r.id = ${requirement}.root_job_id)`,
        forge: sql`${requirement}.target`,
    })} = 'live', false))
)`;
