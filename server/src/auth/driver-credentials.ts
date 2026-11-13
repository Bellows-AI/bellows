/**
 * Per-driver credentials (docs/auth.md, `150_driver_credential.sql`): the board operator issues one per driver, for
 * named organizations or for the pool, and revokes or rotates it. The token (`drv_` + 32 random bytes) is returned
 * once, by the issue or the rotation that minted it; only its SHA-256 is stored. A credential resolves while it is
 * not revoked and its rotation's overlap window, if any, has not ended — both judged by the database clock, the one
 * clock every replica shares.
 */
import { randomBytes } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { hashToken } from './session.js';

export const DRIVER_CREDENTIAL_PREFIX = 'drv_';
const TOKEN_BYTES = 32;
/** How long a rotated credential keeps working beside its successor when the rotation names no window. */
export const DEFAULT_ROTATION_OVERLAP_SECONDS = 3600;
/** Seven days. */
export const MAX_ROTATION_OVERLAP_SECONDS = 604_800;
export const MAX_LABEL_LENGTH = 100;

/** A credential as the operator sees it: never the token, never its hash. */
export interface DriverCredential {
    id: string;
    label: string;
    /** True: every organization. False: only `orgs`. */
    pool: boolean;
    orgs: string[];
    createdAt: string;
    createdBy: string | null;
    revokedAt: string | null;
    expiresAt: string | null;
    rotatedFrom: string | null;
}

/** What an accepted credential may reach: `orgs` null is the pool. */
export interface DriverGrant {
    id: string;
    orgs: readonly string[] | null;
}

export type IssueOutcome =
    | { outcome: 'issued'; credential: DriverCredential; token: string }
    | { outcome: 'missing-org'; orgId: string };

export type RevokeOutcome = { outcome: 'missing' } | { outcome: 'revoked' | 'unchanged'; credential: DriverCredential };

export type RotateOutcome =
    | { outcome: 'missing' }
    /** Revoked, or already rotated: a credential has at most one successor. */
    | { outcome: 'inactive'; credential: DriverCredential }
    | { outcome: 'rotated'; credential: DriverCredential; previous: DriverCredential; token: string };

export interface DriverCredentialStore {
    /** The live credential a presented token is, or null. A database failure throws: the caller answers 503. */
    resolve(token: string): Promise<DriverGrant | null>;
    list(): Promise<DriverCredential[]>;
    /** `orgs` null issues a pool credential. */
    issue(input: { label: string; orgs: readonly string[] | null; createdBy: string }): Promise<IssueOutcome>;
    revoke(id: string): Promise<RevokeOutcome>;
    /** A successor with the same reach; the old credential works for `overlapSeconds` more. */
    rotate(id: string, overlapSeconds: number, createdBy: string): Promise<RotateOutcome>;
}

interface CredentialRow {
    id: string;
    label: string;
    pool: boolean;
    orgs: string[];
    created_at: Date;
    created_by: string | null;
    revoked_at: Date | null;
    expires_at: Date | null;
    rotated_from: string | null;
}

const iso = (at: Date | null): string | null => (at ? at.toISOString() : null);

const credentialOf = (row: CredentialRow): DriverCredential => ({
    id: row.id,
    label: row.label,
    pool: row.pool,
    orgs: [...row.orgs].sort(),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    revokedAt: iso(row.revoked_at),
    expiresAt: iso(row.expires_at),
    rotatedFrom: row.rotated_from,
});

const mint = (): string => `${DRIVER_CREDENTIAL_PREFIX}${randomBytes(TOKEN_BYTES).toString('hex')}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rowsOf(sql: Sql | TransactionSql, id: string | null): Promise<CredentialRow[]> {
    return sql<CredentialRow[]>`
        select c.id, c.label, c.pool, c.created_at, c.created_by, c.revoked_at, c.expires_at, c.rotated_from,
               coalesce(array_agg(o.org_id) filter (where o.org_id is not null), '{}') as orgs
        from driver_credential c
        left join driver_credential_org o on o.credential_id = c.id
        where ${id === null ? sql`true` : sql`c.id = ${id}`}
        group by c.id
        order by c.created_at, c.id
    `;
}

/** Inserts a credential and its organizations; the caller's transaction has checked they exist. */
async function insert(
    tx: TransactionSql,
    input: { label: string; orgs: readonly string[] | null; createdBy: string; rotatedFrom: string | null }
): Promise<{ credential: DriverCredential; token: string }> {
    const token = mint();
    const [row] = await tx<{ id: string }[]>`
        insert into driver_credential (label, token_hash, pool, created_by, rotated_from)
        values (${input.label}, ${hashToken(token)}, ${input.orgs === null}, ${input.createdBy}, ${input.rotatedFrom})
        returning id
    `;
    for (const orgId of input.orgs ?? []) {
        await tx`insert into driver_credential_org (credential_id, org_id) values (${row!.id}, ${orgId})`;
    }
    const [created] = await rowsOf(tx, row!.id);
    return { credential: credentialOf(created!), token };
}

export function createDriverCredentialStore({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown>;
}): DriverCredentialStore {
    return {
        async resolve(token) {
            if (ready) await ready;
            const [row] = await sql<{ id: string; pool: boolean; orgs: string[] }[]>`
                select c.id, c.pool,
                       coalesce(array_agg(o.org_id) filter (where o.org_id is not null), '{}') as orgs
                from driver_credential c
                left join driver_credential_org o on o.credential_id = c.id
                where c.token_hash = ${hashToken(token)}
                  and c.revoked_at is null
                  and (c.expires_at is null or c.expires_at > now())
                group by c.id
            `;
            if (!row) return null;
            return { id: row.id, orgs: row.pool ? null : row.orgs };
        },

        async list() {
            if (ready) await ready;
            return (await rowsOf(sql, null)).map(credentialOf);
        },

        async issue({ label, orgs, createdBy }) {
            if (ready) await ready;
            return sql.begin(async (tx) => {
                const unique = orgs === null ? null : [...new Set(orgs)];
                if (unique) {
                    // Share-locked so a concurrent purge cannot delete an org between this check and the insert.
                    const found = await tx<{ id: string }[]>`
                        select id from organization where id = any(${unique}) for share
                    `;
                    const known = new Set(found.map((row) => row.id));
                    const missing = unique.find((orgId) => !known.has(orgId));
                    if (missing !== undefined) return { outcome: 'missing-org', orgId: missing } as const;
                }
                return {
                    outcome: 'issued',
                    ...(await insert(tx, { label, orgs: unique, createdBy, rotatedFrom: null })),
                };
            });
        },

        async revoke(id) {
            if (ready) await ready;
            if (!UUID.test(id)) return { outcome: 'missing' };
            const changed = await sql`
                update driver_credential set revoked_at = now() where id = ${id} and revoked_at is null returning id
            `;
            const [row] = await rowsOf(sql, id);
            if (!row) return { outcome: 'missing' };
            return { outcome: changed.length ? 'revoked' : 'unchanged', credential: credentialOf(row) };
        },

        async rotate(id, overlapSeconds, createdBy) {
            if (ready) await ready;
            if (!UUID.test(id)) return { outcome: 'missing' };
            return sql.begin(async (tx) => {
                // The row lock serialises a rotation against a revoke or a second rotation of the same credential.
                const locked = await tx`select id from driver_credential where id = ${id} for update`;
                if (!locked.length) return { outcome: 'missing' } as const;
                const [row] = await rowsOf(tx, id);
                const current = credentialOf(row!);
                const succeeded = await tx`select 1 from driver_credential where rotated_from = ${id}`;
                if (current.revokedAt !== null || succeeded.length) {
                    return { outcome: 'inactive', credential: current } as const;
                }
                const minted = await insert(tx, {
                    label: current.label,
                    orgs: current.pool ? null : current.orgs,
                    createdBy,
                    rotatedFrom: id,
                });
                await tx`
                    update driver_credential set expires_at = now() + ${overlapSeconds} * interval '1 second'
                    where id = ${id}
                `;
                const [previous] = await rowsOf(tx, id);
                return { outcome: 'rotated', ...minted, previous: credentialOf(previous!) } as const;
            });
        },
    };
}
