import { randomUUID } from 'node:crypto';
import type { RotationRow } from './postgres-secret-repo.js';
import { type StoreContext, callFor, open, sameBytes, seal } from './postgres-secret-support.js';
import { type Attempt, attempt, newCall, remaining } from './secret-call.js';
import { OPERATION_RETENTION_MS, identityKey } from './secret-input.js';
import type { SecretIdentity, SecretRef } from './secret-store.js';

/**
 * What runs beside the request path: the collector, and the resumable re-encryption of rotation. Neither
 * needs a lock between replicas: every delete re-checks its own guard, every swap compares the version
 * it read (`postgres-secret-sql.ts`).
 */

const COLLECT_PASS_MS = 30_000;
const COLLECT_PAGE = 200;
const DEFAULT_ROTATION_BATCH = 100;

export interface RotationSummary {
    rekeyed: number;
    /** Lost the compare-and-set: the reference changed under us and is already on the active key. */
    skipped: number;
    /** Could not be decrypted, verified or written; still on its old key. */
    failed: number;
}

export interface CollectSummary {
    removed: number;
    pruned: number;
}

async function deleteOne(ctx: StoreContext, id: string): Promise<boolean> {
    const call = callFor(ctx, undefined);
    const result = await attempt(call, (b) => ctx.repo.deleteVersion(id, b), 'once');
    const removed = result.kind === 'ok' && result.value;
    if (removed || result.kind !== 'ok') {
        ctx.log({ event: removed ? 'collected' : 'cleanup-failed' });
    }
    return removed;
}

/** Deletes one page of collectable versions; false when the pass ran out of time. */
async function sweepPage(ctx: StoreContext, ids: string[], pass: ReturnType<typeof newCall>, summary: CollectSummary) {
    for (const id of ids) {
        if (remaining(pass) <= 0) {
            return false;
        }
        if (await deleteOne(ctx, id)) {
            summary.removed += 1;
        }
    }
    return true;
}

export async function collect(ctx: StoreContext): Promise<CollectSummary> {
    const pass = newCall(undefined, COLLECT_PASS_MS);
    const summary: CollectSummary = { removed: 0, pruned: 0 };
    let after: string | null = null;
    while (remaining(pass) > 0) {
        const cursor: string | null = after;
        const page: Attempt<string[]> = await attempt(
            pass,
            (b): Promise<string[]> => ctx.repo.listCollectable(cursor, COLLECT_PAGE, b),
            'read'
        );
        if (page.kind !== 'ok') {
            ctx.log({ event: 'cleanup-failed' });
            return summary;
        }
        const finished = await sweepPage(ctx, page.value, pass, summary);
        if (!finished || page.value.length < COLLECT_PAGE) {
            break;
        }
        after = page.value[page.value.length - 1] ?? null;
    }
    const cutoff = ctx.clock.now() - OPERATION_RETENTION_MS;
    const pruned = await attempt(pass, (b) => ctx.repo.pruneOperations(cutoff, b), 'read');
    if (pruned.kind === 'ok') {
        summary.pruned = pruned.value;
    } else {
        ctx.log({ event: 'cleanup-failed' });
    }
    return summary;
}

/** Decrypt, re-encrypt under the active key, prove the new envelope, swap if still current. */
async function rekeyRow(ctx: StoreContext, row: RotationRow): Promise<'rekeyed' | 'skipped' | 'failed'> {
    const aad = { identityKey: row.identityKey, ref: row.ref, logicalVersion: row.logicalVersion };
    const plaintext = open(ctx, row, aad);
    const sealed = plaintext ? seal(ctx, aad, plaintext) : null;
    const proof = plaintext && sealed ? open(ctx, sealed, aad) : null;
    if (!plaintext || !sealed || !proof || !sameBytes(proof, plaintext)) {
        return 'failed';
    }
    const next = {
        id: randomUUID(),
        ref: row.ref,
        logicalVersion: row.logicalVersion,
        keyId: sealed.keyId,
        envelope: sealed.envelope,
        operationId: null,
        createdAtMs: ctx.clock.now(),
    };
    const swapped = await attempt(
        callFor(ctx, undefined),
        (b) => ctx.repo.rekeySwap(row.ref, row.versionId, next, b),
        'idempotent'
    );
    if (swapped.kind !== 'ok') {
        return 'failed';
    }
    return swapped.value ? 'rekeyed' : 'skipped';
}

export async function rekey(ctx: StoreContext, identity: SecretIdentity, ref: SecretRef): Promise<void> {
    const key = identityKey(identity);
    const read = await attempt(callFor(ctx, undefined), (b) => ctx.repo.readActive(ref, b), 'read');
    const row = read.kind === 'ok' ? read.value : null;
    if (!row || row.identityKey !== key || row.state !== 'active' || !row.version) {
        throw new Error('rekey: no active secret for that identity');
    }
    const outcome = await rekeyRow(ctx, {
        ref,
        identityKey: key,
        versionId: row.version.id,
        logicalVersion: row.version.logicalVersion,
        keyId: row.version.keyId,
        envelope: row.version.envelope,
    });
    if (outcome === 'failed') {
        throw new Error('rekey: the active version could not be re-encrypted');
    }
}

export async function rotate(
    ctx: StoreContext,
    options: { batchSize?: number; signal?: AbortSignal | undefined }
): Promise<RotationSummary> {
    const batch = options.batchSize ?? DEFAULT_ROTATION_BATCH;
    const summary: RotationSummary = { rekeyed: 0, skipped: 0, failed: 0 };
    let after: string | null = null;
    while (!options.signal?.aborted) {
        const cursor: string | null = after;
        const page: Attempt<RotationRow[]> = await attempt(
            callFor(ctx, options.signal),
            (b): Promise<RotationRow[]> => ctx.repo.listForRotation(ctx.keys.activeKeyId, cursor, batch, b),
            'read'
        );
        if (page.kind !== 'ok') {
            summary.failed += 1;
            break;
        }
        for (const row of page.value) {
            if (options.signal?.aborted) {
                return summary;
            }
            summary[await rekeyRow(ctx, row)] += 1;
        }
        if (page.value.length < batch) {
            break;
        }
        after = page.value[page.value.length - 1]?.ref ?? null;
    }
    return summary;
}

/** How many stored versions (staged and collectable included) still name `keyId`, after a collection. */
export async function verifyRetired(ctx: StoreContext, keyId: string): Promise<number> {
    await collect(ctx);
    const counted = await attempt(callFor(ctx, undefined), (b) => ctx.repo.countByKey(keyId, b), 'read');
    if (counted.kind !== 'ok') {
        throw new Error('verifyRetired: the database could not be read');
    }
    return counted.value;
}
