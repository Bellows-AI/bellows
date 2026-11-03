import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
    CAPABILITY_PATTERN,
    CAPABILITY_PREFIX,
    UPLOAD_TTL_SECONDS,
    type UploadCapabilityStore,
    type UploadGrantInput,
} from '../src/attachments/upload-capability-store.js';

export interface MemoryUploadRow extends UploadGrantInput {
    id: string;
    /** sha256 of the capability: the only form of it the store holds. */
    hash: string;
    expiresAt: number;
    attachmentId: string | null;
}

/**
 * The capability store's contract over a Map: a clock the test moves, a revocation set standing in for the OAuth
 * family and membership joins, and a switch that makes every read fail. The SQL is pinned by
 * server/test-db/mcp.attachment-handoff.test.ts.
 */
export function memoryUploadCapabilities(now: () => number = Date.now) {
    const rows = new Map<string, MemoryUploadRow>();
    const dead = new Set<string>();
    const state = { failReads: false };
    const hashOf = (capability: string) => createHash('sha256').update(capability).digest('hex');
    const store: UploadCapabilityStore = {
        async mint(input) {
            const capability = `${CAPABILITY_PREFIX}${randomBytes(32).toString('base64url')}`;
            const id = randomUUID();
            const expiresAt = now() + (input.ttlSeconds ?? UPLOAD_TTL_SECONDS) * 1000;
            rows.set(id, { ...input, id, hash: hashOf(capability), expiresAt, attachmentId: null });
            return { id, capability, expiresAt: new Date(expiresAt) };
        },
        async resolve(capability) {
            if (state.failReads) throw new Error('database unreachable');
            if (!CAPABILITY_PATTERN.test(capability)) return { kind: 'unknown' };
            const row = [...rows.values()].find((r) => r.hash === hashOf(capability));
            if (!row || dead.has(row.userId) || (row.familyId !== null && dead.has(row.familyId))) {
                return { kind: 'unknown' };
            }
            if (row.expiresAt <= now()) return { kind: 'expired' };
            return {
                kind: 'live',
                grant: {
                    id: row.id,
                    orgId: row.orgId,
                    userId: row.userId,
                    maxBytes: row.maxBytes,
                    mediaTypes: row.mediaTypes,
                    expiresAt: new Date(row.expiresAt),
                },
            };
        },
        async complete(id, attachmentId) {
            if (state.failReads) throw new Error('database unreachable');
            const row = rows.get(id);
            if (row && (row.attachmentId === null || row.attachmentId === attachmentId))
                row.attachmentId = attachmentId;
        },
        async view(id, orgId, userId) {
            if (state.failReads) throw new Error('database unreachable');
            const row = rows.get(id);
            if (!row || row.orgId !== orgId || row.userId !== userId) return null;
            return {
                id,
                state: row.attachmentId !== null ? 'completed' : row.expiresAt <= now() ? 'expired' : 'open',
                expiresAt: new Date(row.expiresAt).toISOString(),
                maxBytes: row.maxBytes,
                mediaTypes: row.mediaTypes,
                attachmentId: row.attachmentId,
            };
        },
        async purgeExpired() {
            return 0;
        },
    };
    return {
        store,
        rows,
        state,
        /** Ends every capability of a user or a grant family, as a revoked grant or a removed membership does. */
        kill: (userOrFamily: string) => dead.add(userOrFamily),
        hashOf,
    };
}
