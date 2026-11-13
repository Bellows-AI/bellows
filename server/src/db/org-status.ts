import { CLOUD, type DeploymentMode } from '@factory-ai/core';
import type { Fragment, Sql, TransactionSql } from 'postgres';
import { recordAudit } from './audit-log.js';

/**
 * An organization's status (`140_organization_status.sql`, docs/organizations.md). A cloud organization is `active`
 * from its first sign-in, on the Free plan's limits (`plan-limits.ts`); the operator (`OPERATOR_GITHUB_IDS`) suspends
 * or refuses it and reactivates it. A suspended or refused org's creates are refused and the claim offers none of its
 * queued rows; a missing row is not active. A self-hosted board has no status gate.
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
 * The claim's acquisition re-check (`job-store-connections.ts:queuedRowHeld`), under the job row and thread locks:
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

/** The claim's org filter for new work: in cloud mode the row's org must exist and be `active`. */
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
}

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
        await tx`update organization set status = ${to} where id = ${orgId}`;
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
