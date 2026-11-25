import { FORGE_REQUIREMENT_PROVIDER } from '@factory-ai/core';
import type { Fragment, Sql, TransactionSql } from 'postgres';
import { grantStandingExpr } from './forge-grant-standing.js';

type Db = Sql | TransactionSql;

/**
 * The forge start gate's wait, as an open row of `job_integration_requirement` (docs/connections.md): provider
 * `forge`, target the forge (`github`), source `create`. The claim opens it when the thread starter's grant is not
 * live and closes it the moment it is; a re-link closes it early for the page. It is never dismissed.
 *
 * `forge-access` is the exception: the board's PR route opens it when the member's own token is refused (they cannot
 * write to the repository), so a live grant says nothing about it. Only a successful member write closes it
 * (`closeForgeAccessWait`), and the claim's hand-back defers the row by `FORGE_ACCESS_RETRY_SECONDS` to retry.
 */

export const FORGE_ACCESS_REASON = 'forge-access';
/** How long a handed-back `forge-access` wait stays out of the claim before the publish is retried. */
export const FORGE_ACCESS_RETRY_SECONDS = 600;

/** Why the thread waits: no grant, a grant needing reconnect, a starter that no longer exists, or no write access. */
export type ForgeRequirementReason = 'missing' | 'reconnect' | 'starter-removed' | typeof FORGE_ACCESS_REASON;

/** Opens the root's forge requirement, or restates its reason when one is already open (never over `forge-access`). */
export async function openForgeRequirement(
    db: Db,
    args: { orgId: string; rootJobId: string; forge: string; reason: ForgeRequirementReason }
): Promise<void> {
    await db`
        insert into job_integration_requirement (org_id, root_job_id, provider, reason, target, source)
        values (${args.orgId}, ${args.rootJobId}, ${FORGE_REQUIREMENT_PROVIDER}, ${args.reason}, ${args.forge}, 'create')
        on conflict (org_id, root_job_id, provider) where satisfied_at is null
        do update set target = excluded.target,
            -- An open write-access wait survives a later grant failure: only a successful member write ends it.
            reason = case when job_integration_requirement.reason = ${FORGE_ACCESS_REASON}
                          then job_integration_requirement.reason else excluded.reason end
    `;
}

/**
 * Opens the root's forge requirement as a RUNTIME wait of a running attempt: the attempt asked for the member's
 * credential and the grant cannot serve (docs/gitlab.md). It is the same open row, with the asking attempt on it, so the
 * heartbeat tells that attempt (and a takeover of it) to stop and hand the task back (`requirementWaitOf`). A re-link
 * closes it bound; a `forge-access` reason already open is kept.
 */
export async function openRuntimeForgeRequirement(
    db: Db,
    args: {
        orgId: string;
        rootJobId: string;
        askedJobId: string;
        claimSeq: number;
        forge: string;
        reason: ForgeRequirementReason;
    }
): Promise<void> {
    await db`
        insert into job_integration_requirement
            (org_id, root_job_id, provider, reason, target, source, asked_job_id, asked_claim_seq, hand_back_pending)
        values (${args.orgId}, ${args.rootJobId}, ${FORGE_REQUIREMENT_PROVIDER}, ${args.reason}, ${args.forge}, 'runtime',
                ${args.askedJobId}, ${args.claimSeq}, true)
        on conflict (org_id, root_job_id, provider) where satisfied_at is null
        do update set target = excluded.target, source = 'runtime', asked_job_id = excluded.asked_job_id,
            asked_claim_seq = excluded.asked_claim_seq, hand_back_pending = true,
            reason = case when job_integration_requirement.reason = ${FORGE_ACCESS_REASON}
                          then job_integration_requirement.reason else excluded.reason end
    `;
}

/** Closes the root's open grant wait as bound by its starter: the grant is live. A live grant is no evidence of write access. */
export async function closeForgeRequirement(
    db: Db,
    args: { orgId: string; rootJobId: string; userId: string }
): Promise<void> {
    await db`
        update job_integration_requirement
        set satisfied_at = now(), outcome = 'bound', closed_by = ${args.userId}
        where org_id = ${args.orgId} and root_job_id = ${args.rootJobId} and provider = ${FORGE_REQUIREMENT_PROVIDER}
          and satisfied_at is null and reason <> ${FORGE_ACCESS_REASON}
    `;
}

/** Closes the root's open forge wait, whatever its reason: the member's own write just succeeded. */
export async function closeForgeAccessWait(
    db: Db,
    args: { orgId: string; rootJobId: string; userId: string }
): Promise<void> {
    await db`
        update job_integration_requirement
        set satisfied_at = now(), outcome = 'bound', closed_by = ${args.userId}
        where org_id = ${args.orgId} and root_job_id = ${args.rootJobId} and provider = ${FORGE_REQUIREMENT_PROVIDER}
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
        where q.org_id = ${args.orgId} and q.provider = ${FORGE_REQUIREMENT_PROVIDER} and q.target = ${args.forge}
          and q.satisfied_at is null and q.reason <> ${FORGE_ACCESS_REASON}
          and root.org_id = q.org_id and root.id = q.root_job_id and root.execution_user_id = ${args.userId}
    `;
}

/**
 * The claimability predicate's exception (`job-store-claim.ts`): `requirement` (an alias for a
 * `job_integration_requirement` row) is a forge wait the claim ignores — the gate is off, or the thread starter's grant
 * is live now, so the acquire closes it. A missing starter or grant is not live and the wait holds.
 */
export const forgeWaitIgnored = (sql: Sql, gateOn: boolean, requirement: Fragment): Fragment => sql`(
    ${requirement}.provider = ${FORGE_REQUIREMENT_PROVIDER}
    and (not ${gateOn}::boolean or coalesce(${grantStandingExpr(sql, {
        orgId: sql`${requirement}.org_id`,
        userId: sql`(select r.execution_user_id from job r
                     where r.org_id = ${requirement}.org_id and r.id = ${requirement}.root_job_id)`,
        forge: sql`${requirement}.target`,
    })} = 'live', false))
)`;
