/**
 * The board operator's routes (`GET /api/operator/orgs`, `POST /api/operator/orgs/:id/<action|delete>`, and the
 * driver credentials under `/api/operator/driver-credentials`), over whatever
 * `send` does to fetch one authenticated path. The shapes are copied, since the CLI imports nothing of the board's.
 */
import { CONTENT_TYPE_HEADER, JSON_CONTENT_TYPE } from './http.js';

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

/** A driver credential as the operator sees it; never its token. `pool` reaches every organization. */
export interface DriverCredential {
    id: string;
    label: string;
    pool: boolean;
    orgs: string[];
    createdAt: string;
    createdBy: string | null;
    revokedAt: string | null;
    expiresAt: string | null;
    rotatedFrom: string | null;
}

/** An issued credential and its token, which the board shows this once. */
export interface IssuedCredential {
    credential: DriverCredential;
    token: string;
}

/** A rotation: the successor and its token, and the replaced credential with the end of its overlap window. */
export interface RotatedCredential extends IssuedCredential {
    previous: DriverCredential;
}

export interface RevokedCredential {
    revoked: boolean;
    credential: DriverCredential;
}

export interface OperatorRoutes {
    /** Every organization with its status; the board operator only. */
    operatorOrgs(): Promise<OperatorOrg[]>;
    /** The board operator's suspend, refuse or activate of one organization. */
    operatorAction(orgId: string, action: OperatorAction): Promise<OperatorChange>;
    /** Queues the purge of a suspended or refused organization; the board refuses an active one. */
    operatorDelete(orgId: string): Promise<OperatorDelete>;
    /** Every driver credential; the board operator only. */
    driverCredentials(): Promise<DriverCredential[]>;
    /** `orgs` null issues a pool credential. */
    issueDriverCredential(label: string, orgs: readonly string[] | null): Promise<IssuedCredential>;
    revokeDriverCredential(id: string): Promise<RevokedCredential>;
    /** `overlapSeconds` undefined leaves the window to the board's default. */
    rotateDriverCredential(id: string, overlapSeconds: number | undefined): Promise<RotatedCredential>;
}

const CREDENTIALS = '/api/operator/driver-credentials';

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
        async driverCredentials() {
            return ((await send(CREDENTIALS, { headers: authHeaders() })) as { credentials: DriverCredential[] })
                .credentials;
        },
        async issueDriverCredential(label, orgs) {
            return (await send(CREDENTIALS, {
                method: 'POST',
                headers: { ...authHeaders(), [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE },
                body: JSON.stringify(orgs === null ? { label, pool: true } : { label, orgs }),
            })) as IssuedCredential;
        },
        async revokeDriverCredential(id) {
            return (await send(`${CREDENTIALS}/${encodeURIComponent(id)}/revoke`, {
                method: 'POST',
                headers: authHeaders(),
            })) as RevokedCredential;
        },
        async rotateDriverCredential(id, overlapSeconds) {
            return (await send(`${CREDENTIALS}/${encodeURIComponent(id)}/rotate`, {
                method: 'POST',
                headers: { ...authHeaders(), [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE },
                body: JSON.stringify(overlapSeconds === undefined ? {} : { overlapSeconds }),
            })) as RotatedCredential;
        },
    };
}
