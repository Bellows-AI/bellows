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

/** In cloud mode, throws `OrgInactiveError` unless the org's row is `active`. Self-hosted: never. */
export async function refuseInactiveOrg(
    sql: Sql | TransactionSql,
    orgId: string,
    deploymentMode: DeploymentMode
): Promise<void> {
    if (deploymentMode !== CLOUD) return;
    const [row] = await sql<{ status: OrgStatus }[]>`select status from organization where id = ${orgId}`;
    if (row?.status === 'active') return;
    throw new OrgInactiveError(row ? (row.status as Exclude<OrgStatus, 'active'>) : null);
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
            select id, name, status from organization where id = ${orgId} for update
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
