/**
 * The board operator's routes (`GET /api/operator/orgs`, `POST /api/operator/orgs/:id/<action|delete>`), over whatever
 * `send` does to fetch one authenticated path. The shapes are copied, since the CLI imports nothing of the board's.
 */

/** One organization as the operator sees it. */
export interface OperatorOrg {
    id: string;
    name: string;
    status: string;
}

export type OperatorAction = 'suspend' | 'refuse' | 'activate';

/** `changed` is false when the status already held. */
export interface OperatorChange {
    changed: boolean;
    org: OperatorOrg;
}

/** `requested` is false when the org's purge was already queued. */
export interface OperatorDelete {
    requested: boolean;
    org: OperatorOrg;
}

export interface OperatorRoutes {
    /** Every organization with its status; the board operator only. */
    operatorOrgs(): Promise<OperatorOrg[]>;
    /** The board operator's suspend, refuse or activate of one organization. */
    operatorAction(orgId: string, action: OperatorAction): Promise<OperatorChange>;
    /** Queues the purge of a suspended or refused organization; the board refuses an active one. */
    operatorDelete(orgId: string): Promise<OperatorDelete>;
}

export function operatorRoutes(
    send: (path: string, init: RequestInit) => Promise<unknown>,
    authHeaders: () => Record<string, string>
): OperatorRoutes {
    return {
        async operatorOrgs() {
            return ((await send('/api/operator/orgs', { headers: authHeaders() })) as { orgs: OperatorOrg[] }).orgs;
        },
        async operatorAction(orgId, action) {
            return (await send(`/api/operator/orgs/${encodeURIComponent(orgId)}/${action}`, {
                method: 'POST',
                headers: authHeaders(),
            })) as OperatorChange;
        },
        async operatorDelete(orgId) {
            return (await send(`/api/operator/orgs/${encodeURIComponent(orgId)}/delete`, {
                method: 'POST',
                headers: authHeaders(),
            })) as OperatorDelete;
        },
    };
}
