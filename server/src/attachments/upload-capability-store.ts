import { randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { hashToken } from '../auth/session.js';

/** A capability is `fcu_` plus 32 random bytes in base64url; anything else cannot be one and is never looked up. */
export const CAPABILITY_PREFIX = 'fcu_';
export const CAPABILITY_PATTERN = /^fcu_[A-Za-z0-9_-]{43}$/;
const CAPABILITY_BYTES = 32;

/** How long a minted capability lives. Short: it is a bearer secret that appears in a URL. */
export const UPLOAD_TTL_SECONDS = 900;
/** A spent or lapsed row is kept this long so its status still reads, then the sweep removes it. */
const PURGE_GRACE = '1 day';

export interface UploadGrantInput {
    orgId: string;
    userId: string;
    /** The OAuth grant family the mint arrived under; null for a session or a local caller. */
    familyId: string | null;
    maxBytes: number;
    mediaTypes: readonly string[];
    ttlSeconds?: number;
}

export interface UploadGrant {
    id: string;
    orgId: string;
    userId: string;
    maxBytes: number;
    mediaTypes: readonly string[];
    expiresAt: Date;
}

/**
 * What a presented capability resolves to. `unknown` covers a capability that never existed AND one whose grant was
 * revoked or whose account left the org: the holder learns nothing about which.
 */
export type CapabilityResolution = { kind: 'live'; grant: UploadGrant } | { kind: 'expired' } | { kind: 'unknown' };

export interface UploadRequestView {
    id: string;
    state: 'open' | 'completed' | 'expired';
    expiresAt: string;
    maxBytes: number;
    mediaTypes: readonly string[];
    attachmentId: string | null;
}

export interface UploadCapabilityStore {
    mint(input: UploadGrantInput): Promise<{ id: string; capability: string; expiresAt: Date }>;
    /** Resolves through the LIVE membership and grant family; a store failure throws and is never `unknown`. */
    resolve(capability: string): Promise<CapabilityResolution>;
    /** Records the ready file. Idempotent for the same attachment. */
    complete(id: string, attachmentId: string): Promise<void>;
    /** One of the caller's own requests, or null when it is not theirs or does not exist. */
    view(id: string, orgId: string, userId: string): Promise<UploadRequestView | null>;
    purgeExpired(): Promise<number>;
}

interface ResolveRow {
    id: string;
    org_id: string;
    user_id: string;
    max_bytes: number;
    media_types: string[];
    expires_at: Date;
    expired: boolean;
    member: boolean;
    family_live: boolean;
}

interface ViewRow {
    id: string;
    max_bytes: number;
    media_types: string[];
    expires_at: Date;
    expired: boolean;
    attachment_id: string | null;
}

export function createUploadCapabilityStore({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown> | undefined;
}): UploadCapabilityStore {
    const gate = async (): Promise<void> => {
        if (ready) await ready;
    };
    return {
        async mint(input) {
            await gate();
            const capability = `${CAPABILITY_PREFIX}${randomBytes(CAPABILITY_BYTES).toString('base64url')}`;
            const ttl = input.ttlSeconds ?? UPLOAD_TTL_SECONDS;
            const [row] = await sql<{ id: string; expires_at: Date }[]>`
                insert into attachment_upload (org_id, user_id, family_id, capability_hash, max_bytes, media_types, expires_at)
                values (${input.orgId}, ${input.userId}, ${input.familyId}, ${hashToken(capability)}, ${input.maxBytes},
                        ${sql.array([...input.mediaTypes])}, now() + make_interval(secs => ${ttl}))
                returning id, expires_at
            `;
            if (!row) throw new Error('the upload request was not written');
            return { id: row.id, capability, expiresAt: row.expires_at };
        },

        async resolve(capability) {
            if (!CAPABILITY_PATTERN.test(capability)) return { kind: 'unknown' };
            await gate();
            // The membership and the grant family are joined LIVE, as findAccessToken does: nothing cascades from them.
            const [row] = await sql<ResolveRow[]>`
                select u.id, u.org_id, u.user_id, u.max_bytes::int as max_bytes, u.media_types, u.expires_at,
                       u.expires_at <= now() as expired,
                       m.user_id is not null as member,
                       (u.family_id is null or (f.id is not null and f.revoked_at is null and f.expires_at > now()))
                           as family_live
                from attachment_upload u
                left join org_membership m on m.user_id = u.user_id and m.org_id = u.org_id
                left join oauth_grant_family f on f.id = u.family_id
                where u.capability_hash = ${hashToken(capability)}
            `;
            if (!row || !row.member || !row.family_live) return { kind: 'unknown' };
            if (row.expired) return { kind: 'expired' };
            return {
                kind: 'live',
                grant: {
                    id: row.id,
                    orgId: row.org_id,
                    userId: row.user_id,
                    maxBytes: row.max_bytes,
                    mediaTypes: row.media_types,
                    expiresAt: row.expires_at,
                },
            };
        },

        async complete(id, attachmentId) {
            await gate();
            await sql`
                update attachment_upload
                set attachment_id = ${attachmentId}, completed_at = coalesce(completed_at, now())
                where id = ${id} and (attachment_id is null or attachment_id = ${attachmentId})
            `;
        },

        async view(id, orgId, userId) {
            await gate();
            const [row] = await sql<ViewRow[]>`
                select id, max_bytes::int as max_bytes, media_types, expires_at, expires_at <= now() as expired,
                       attachment_id
                from attachment_upload
                where id = ${id} and org_id = ${orgId} and user_id = ${userId}
            `;
            if (!row) return null;
            return {
                id: row.id,
                state: row.attachment_id !== null ? 'completed' : row.expired ? 'expired' : 'open',
                expiresAt: row.expires_at.toISOString(),
                maxBytes: row.max_bytes,
                mediaTypes: row.media_types,
                attachmentId: row.attachment_id,
            };
        },

        async purgeExpired() {
            await gate();
            const rows = await sql`
                delete from attachment_upload where expires_at < now() - ${PURGE_GRACE}::interval returning 1
            `;
            return rows.length;
        },
    };
}
