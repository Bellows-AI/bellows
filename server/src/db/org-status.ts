import { CLOUD, type DeploymentMode } from '@factory-ai/core';
import type { Fragment, Sql, TransactionSql } from 'postgres';
import { recordAudit } from './audit-log.js';

/**
 * An organization's status (`140_organization_status.sql`, docs/organizations.md). A cloud organization is `active`
 * from its first sign-in, on the Free plan's limits (`plan-limits.ts`); the operator (`OPERATOR_GITHUB_IDS`) suspends
 * or refuses it and reactivates it. A suspended or refused org's creates are refused, the claim offers none of its
 * rows (a takeover included) and its running attempts are asked to hand themselves back resumably (`orgRelease`);
 * a missing row is not active. A self-hosted board has no status gate. An App uninstall or a GitHub suspension
 * suspends the org with a deletion deadline (`setInstallationStatus`) and deletes nothing.
 */

export const ORG_STATUSES = ['active', 'suspended', 'refused'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const OPERATOR_ACTIONS = ['suspend', 'refuse', 'activate'] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

const STATUS_OF: Readonly<Record<OperatorAction, OrgStatus>> = {
    suspend: 'suspended',
    refuse: 'refused',
    activate: 'active',
};

/** A create a cloud organization that is not active refuses; `status` is null when the org has no row. */
export class OrgInactiveError extends Error {
    constructor(readonly status: Exclude<OrgStatus, 'active'> | null) {
        super(`organization is ${status ?? 'unknown'}`);
        this.name = 'OrgInactiveError';
    }
}

/**
 * The org's status read under `for share`, to the end of the caller's transaction: a status change takes the row
 * `for no key update`, so it waits for the create or claim that read `active` to commit, and that create or claim
 * waits for a status change already in flight. Lock order: whatever job row or thread lock the caller holds, then
 * the organization row; a status change locks no job row. Null when the org has no row.
 */
async function lockedStatus(tx: TransactionSql, orgId: string): Promise<OrgStatus | null> {
    const [row] = await tx<{ status: OrgStatus }[]>`select status from organization where id = ${orgId} for share`;
    return row?.status ?? null;
}

/** In cloud mode, throws `OrgInactiveError` unless the org's row is `active` (held, `lockedStatus`). Self-hosted: never. */
export async function refuseInactiveOrg(
    tx: TransactionSql,
    orgId: string,
    deploymentMode: DeploymentMode
): Promise<void> {
    if (deploymentMode !== CLOUD) return;
    const status = await lockedStatus(tx, orgId);
    if (status === 'active') return;
    throw new OrgInactiveError(status);
}

/**
 * The claim's acquisition re-check (`job-store-connections.ts:rowHeld`), under the job row and thread locks:
 * in cloud mode, whether the org is still `active` (held, `lockedStatus`). An operator's suspend that landed while
 * the claim read the plan wins, and one in flight waits for the acquisition.
 */
export async function orgActiveForClaim(
    tx: TransactionSql,
    orgId: string,
    deploymentMode: DeploymentMode
): Promise<boolean> {
    return deploymentMode !== CLOUD || (await lockedStatus(tx, orgId)) === 'active';
}

/**
 * The heartbeat's release verdict: in cloud mode a running attempt of a `suspended` or `refused` org is asked to hand
 * itself back as a resumable interruption (`orgSuspended`). Only a status read as not active asks it: a missing row
 * asks nothing, and a read that throws fails the beat, which the driver treats as no verdict.
 */
export async function orgRelease(
    sql: Sql,
    orgId: string,
    deploymentMode: DeploymentMode
): Promise<'org-suspended' | null> {
    if (deploymentMode !== CLOUD) return null;
    const [row] = await sql<{ status: OrgStatus }[]>`select status from organization where id = ${orgId}`;
    return row !== undefined && row.status !== 'active' ? 'org-suspended' : null;
}

/** The claim's org filter, a takeover included: in cloud mode the row's org must exist and be `active`. */
export const activeOrgOf = (sql: Sql, deploymentMode: DeploymentMode, alias: string): Fragment =>
    deploymentMode === CLOUD
        ? sql`exists (select 1 from organization o where o.id = ${sql(alias)}.org_id and o.status = 'active')`
        : sql`true`;

/** One organization as the operator sees it. */
export interface OperatorOrgView {
    id: string;
    name: string;
    status: OrgStatus;
}

export type OrgStatusChange =
    | { outcome: 'changed' | 'unchanged'; org: OperatorOrgView }
    /** A suspend of a refused org: a refusal is lifted only by an activate. */
    | { outcome: 'refused'; org: OperatorOrgView }
    | { outcome: 'missing' };

/** The operator's half of the auth store (`auth/store.ts`): it owns the organization rows sign-in writes. */
export interface OrgStatusStore {
    /** Every organization with its status, for the operator (`routes/operator.ts`). */
    listOrganizations(): Promise<OperatorOrgView[]>;
    /** The operator's suspend, refuse or activate, with one `operator` audit row per change. */
    setOrgStatus(orgId: string, action: OperatorAction, operatorId: string): Promise<OrgStatusChange>;
    /** What a GitHub `installation` delivery does to its org (`routes/webhook.ts`), with one `system` audit row per change. */
    setInstallationStatus(orgId: string, action: InstallationAction): Promise<OrgStatusChange>;
    /** The operator's delete: queues the org's purge (`org-purge.ts`) with one `operator` audit row; never an active org. */
    requestOrgDelete(orgId: string, operatorId: string): Promise<OrgDeleteRequest>;
}

export type OrgDeleteRequest =
    /** `unchanged`: a purge was already queued. */
    | { outcome: 'requested' | 'unchanged'; org: OperatorOrgView }
    /** An active org is never purged: the operator suspends or refuses it first. */
    | { outcome: 'active'; org: OperatorOrgView }
    | { outcome: 'missing' };

/** The `installation` webhook actions that move an org: an uninstall, a GitHub suspension, and its lifting. */
export const INSTALLATION_ACTIONS = ['deleted', 'suspend', 'unsuspend'] as const;
export type InstallationAction = (typeof INSTALLATION_ACTIONS)[number];

/** How long an uninstalled or GitHub-suspended organization is kept, suspended, before it may be deleted. */
export const UNINSTALL_DELETE_WINDOW_DAYS = 30;

export function buildOrgStatusMethods(sql: Sql, gate: () => Promise<void>): OrgStatusStore {
    return {
        async listOrganizations() {
            await gate();
            return listOrganizations(sql);
        },
        async setOrgStatus(orgId, action, operatorId) {
            await gate();
            return setOrgStatus(sql, orgId, action, operatorId);
        },
        async setInstallationStatus(orgId, action) {
            await gate();
            return setInstallationStatus(sql, orgId, action);
        },
        async requestOrgDelete(orgId, operatorId) {
            await gate();
            return requestOrgDelete(sql, orgId, operatorId);
        },
    };
}

/**
 * Queues the purge of a suspended or refused org under its row lock, with one `operator` audit row; a purge already
 * queued is `unchanged` and records nothing. The purge itself re-checks the status on every pass (`org-purge.ts`).
 */
async function requestOrgDelete(sql: Sql, orgId: string, operatorId: string): Promise<OrgDeleteRequest> {
    return sql.begin(async (tx) => {
        const holds = await lockedHolds(tx, orgId);
        if (!holds) return { outcome: 'missing' as const };
        const { operator_status: _operator, delete_after: _deadline, ...org } = holds;
        if (org.status === 'active') return { outcome: 'active' as const, org };
        const queued = await tx`
            insert into org_purge (org_id, source, requested_by) values (${orgId}, 'operator', ${operatorId})
            on conflict (org_id) do nothing
            returning org_id
        `;
        if (queued.length === 0) return { outcome: 'unchanged' as const, org };
        await recordAudit(tx, {
            orgId,
            actor: { kind: 'operator', id: operatorId },
            action: 'org.delete',
            target: orgId,
            detail: { status: org.status },
        });
        return { outcome: 'requested' as const, org };
    });
}

async function listOrganizations(sql: Sql): Promise<OperatorOrgView[]> {
    return sql<OperatorOrgView[]>`select id, name, status from organization order by id`;
}

/**
 * Moves the org to the action's status under a row lock, with one `operator` audit row per change; a status that
 * already holds changes and records nothing.
 */
/** One org's two holds, read under the row lock: the operator's decision and GitHub's (a deletion deadline). */
interface OrgHolds extends OperatorOrgView {
    operator_status: OrgStatus;
    delete_after: Date | null;
}

const lockedHolds = async (tx: TransactionSql, orgId: string): Promise<OrgHolds | undefined> =>
    (
        await tx<OrgHolds[]>`
            select id, name, status, operator_status, delete_after from organization where id = ${orgId}
            for no key update
        `
    )[0];

/**
 * The effective status of two holds: active only when neither holds the org — the operator's refusal outranks any
 * suspension, and GitHub's hold suspends. Neither source ever lifts the other's.
 */
const effectiveStatus = (operator: OrgStatus, githubHold: boolean): OrgStatus =>
    operator === 'active' && githubHold ? 'suspended' : operator;

/**
 * Moves the operator's own hold under a row lock, with one `operator` audit row per change; a hold that already
 * stands changes and records nothing. The effective status follows (`effectiveStatus`): the operator's activate lifts
 * the operator's hold only, so an org GitHub still holds (uninstalled or suspended) stays suspended.
 */
async function setOrgStatus(
    sql: Sql,
    orgId: string,
    action: OperatorAction,
    operatorId: string
): Promise<OrgStatusChange> {
    return sql.begin(async (tx) => {
        const holds = await lockedHolds(tx, orgId);
        if (!holds) return { outcome: 'missing' as const };
        const { operator_status: operator, delete_after: deadline, ...org } = holds;
        const mine = STATUS_OF[action];
        if (operator === mine) return { outcome: 'unchanged' as const, org };
        if (operator === 'refused' && action === 'suspend') return { outcome: 'refused' as const, org };
        const to = effectiveStatus(mine, deadline !== null);
        await tx`update organization set operator_status = ${mine}, status = ${to} where id = ${orgId}`;
        await recordAudit(tx, {
            orgId,
            actor: { kind: 'operator', id: operatorId },
            action: `org.${action}`,
            target: orgId,
            detail: { from: org.status, to },
        });
        return { outcome: 'changed' as const, org: { ...org, status: to } };
    });
}

/**
 * GitHub's hold: an uninstall (`deleted`) or a GitHub suspension (`suspend`) sets the deletion deadline once and
 * suspends the org unless the operator refused it; every row is kept. An `unsuspend` clears GitHub's hold only — the
 * org is active again only if the operator holds it neither. A replay changes nothing and records nothing.
 */
async function setInstallationStatus(sql: Sql, orgId: string, action: InstallationAction): Promise<OrgStatusChange> {
    return sql.begin(async (tx) => {
        const holds = await lockedHolds(tx, orgId);
        if (!holds) return { outcome: 'missing' as const };
        const { operator_status: operator, delete_after: deadline, ...org } = holds;
        const lifting = action === 'unsuspend';
        if (lifting === (deadline === null)) return { outcome: 'unchanged' as const, org };
        const to = effectiveStatus(operator, !lifting);
        const deleteAfter = lifting ? null : tx`now() + make_interval(days => ${UNINSTALL_DELETE_WINDOW_DAYS}::int)`;
        const [updated] = await tx<{ delete_after: Date | null }[]>`
            update organization set status = ${to}, delete_after = ${deleteAfter}
            where id = ${orgId}
            returning delete_after
        `;
        await recordAudit(tx, {
            orgId,
            actor: { kind: 'system', id: null },
            action: lifting ? 'org.activate' : 'org.suspend',
            target: orgId,
            detail: {
                from: org.status,
                to,
                source: `installation.${action}`,
                deleteAfter: updated?.delete_after?.toISOString() ?? null,
            },
        });
        return { outcome: 'changed' as const, org: { ...org, status: to } };
    });
}
