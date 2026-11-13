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
}

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
    };
}

async function listOrganizations(sql: Sql): Promise<OperatorOrgView[]> {
    return sql<OperatorOrgView[]>`select id, name, status from organization order by id`;
}

/**
 * Moves the org to the action's status under a row lock, with one `operator` audit row per change; a status that
 * already holds changes and records nothing.
 */
async function setOrgStatus(
    sql: Sql,
    orgId: string,
    action: OperatorAction,
    operatorId: string
): Promise<OrgStatusChange> {
    return sql.begin(async (tx) => {
        const [org] = await tx<OperatorOrgView[]>`
            select id, name, status from organization where id = ${orgId} for no key update
        `;
        if (!org) return { outcome: 'missing' as const };
        const to = STATUS_OF[action];
        if (org.status === to) return { outcome: 'unchanged' as const, org };
        if (org.status === 'refused' && action === 'suspend') return { outcome: 'refused' as const, org };
        // The operator's activate is the decision to keep the org: it lifts an uninstall's deletion deadline too.
        await tx`
            update organization set status = ${to},
                delete_after = case when ${to} = 'active' then null else delete_after end
            where id = ${orgId}
        `;
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
 * An uninstall (`deleted`) or a GitHub suspension (`suspend`) suspends an active org and sets its deletion deadline
 * once — a refused org stays refused — and keeps every row. An `unsuspend` lifts only what an installation set: an
 * org with a deadline is cleared of it and a suspended one reactivated; the operator's suspension or refusal (no
 * deadline) is left alone. A replay changes nothing and records nothing.
 */
/**
 * Where an installation action moves an org whose row reads `status` and whether it has a deadline; null when it
 * changes nothing. A lifting moves only a suspended org; a suspension only an active one, a refusal staying put.
 */
function installationMove(status: OrgStatus, hasDeadline: boolean, action: InstallationAction): OrgStatus | null {
    if (action === 'unsuspend') return hasDeadline ? (status === 'suspended' ? 'active' : status) : null;
    if (hasDeadline) return null;
    return status === 'active' ? 'suspended' : status;
}

async function setInstallationStatus(sql: Sql, orgId: string, action: InstallationAction): Promise<OrgStatusChange> {
    return sql.begin(async (tx) => {
        const [org] = await tx<(OperatorOrgView & { delete_after: Date | null })[]>`
            select id, name, status, delete_after from organization where id = ${orgId} for no key update
        `;
        if (!org) return { outcome: 'missing' as const };
        const { delete_after: deadline, ...view } = org;
        const to = installationMove(view.status, deadline !== null, action);
        if (to === null) return { outcome: 'unchanged' as const, org: view };
        const lifting = action === 'unsuspend';
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
                from: view.status,
                to,
                source: `installation.${action}`,
                deleteAfter: updated?.delete_after?.toISOString() ?? null,
            },
        });
        return { outcome: 'changed' as const, org: { ...view, status: to } };
    });
}
