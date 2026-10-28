import { timingSafeEqual } from 'node:crypto';
import type { OperationRow, SecretRepo } from './postgres-secret-repo.js';
import { type Attempt, type Call, attempt, newCall } from './secret-call.js';
import { type OperationKeys, operationMac } from './secret-keys.js';
import type { PayloadAad, PayloadStore, StoredPayload } from './secret-payloads.js';
import { OPERATION_RETENTION_MS, secretError } from './secret-input.js';
import type { SecretDiagnostic, SecretError } from './secret-store.js';

/** What every part of the PostgreSQL store shares: its collaborators and the small result helpers. */
export interface StoreContext {
    repo: SecretRepo;
    keys: OperationKeys;
    /** Where payload bytes live: the database envelope, or an external provider (`secret-payloads.ts`). */
    payloads: PayloadStore;
    clock: { now(): number };
    log: (diagnostic: SecretDiagnostic) => void;
    deadlineMs: number;
    ready: Promise<unknown> | undefined;
}

export type Resolution = { ok: true; version: string | null } | { ok: false; error: SecretError };

export const fail = (error: SecretError): { ok: false; error: SecretError } => ({ ok: false, error });
export const failWith = (code: SecretError['code'], reason: SecretError['reason']) => fail(secretError(code, reason));
export const unavailable = () => failWith('unavailable', 'provider-unavailable');
export const aborted = () => failWith('unavailable', 'aborted');
export const integrityFailure = () => failWith('integrity-failure', 'integrity-check-failed');
export const terminal = (op: OperationRow) => op.state === 'succeeded' || op.state === 'failed';

export const misconfigured = () => failWith('invalid-configuration', 'configuration-invalid');

/** A failed read or best-effort step: never `not-found`, never a negative verdict. */
export const readFailure = (a: { kind: string }) => {
    if (a.kind === 'misconfigured') {
        return misconfigured();
    }
    return a.kind === 'aborted' ? aborted() : unavailable();
};

export const callFor = (ctx: StoreContext, signal: AbortSignal | undefined, ms = ctx.deadlineMs): Call =>
    newCall(signal, ms);

export function errorOf(op: OperationRow): SecretError {
    return op.errorCode && op.errorReason
        ? { code: op.errorCode, reason: op.errorReason }
        : secretError('integrity-failure', 'integrity-check-failed');
}

export function resolutionOf(op: OperationRow): Resolution {
    return op.state === 'succeeded' ? { ok: true, version: op.newVersion } : fail(errorOf(op));
}

const OPERATION_ID = /^op_(\d+)_([0-9a-f]{16})_([0-9a-f]{64})$/;

/** The issue time of a well-formed, correctly MACed operation id; null for anything else. */
export function parseOperationId(ctx: StoreContext, raw: unknown): { issuedAt: number } | null {
    const match = typeof raw === 'string' ? OPERATION_ID.exec(raw) : null;
    if (!match) {
        return null;
    }
    const [, issuedAt, nonce, mac] = match;
    const expected = Buffer.from(operationMac(ctx.keys, `${issuedAt}.${nonce}`), 'hex');
    const actual = Buffer.from(mac ?? '', 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        return null;
    }
    return { issuedAt: Number(issuedAt) };
}

export const operationExpired = (ctx: StoreContext, op: OperationRow) =>
    op.completedAtMs !== null && ctx.clock.now() - op.completedAtMs > OPERATION_RETENTION_MS;

export const issueExpired = (ctx: StoreContext, issuedAt: number) =>
    ctx.clock.now() - issuedAt > OPERATION_RETENTION_MS;

/**
 * The plaintext of a stored version through the payload store, retried like any read. A row of another
 * storage than the store's own is a configuration fault, never an absence.
 */
export function readPayload(
    ctx: StoreContext,
    call: Call,
    row: StoredPayload,
    aad: PayloadAad
): Promise<Attempt<Uint8Array | 'absent' | null>> {
    if (row.storage !== ctx.payloads.storage) {
        return Promise.resolve({ kind: 'misconfigured' });
    }
    return attempt(call, (b) => ctx.payloads.read(row, aad, b, call.signal), 'read');
}

/**
 * Removes one version (docs/secrets.md). A payload that is its row goes in one guarded delete. Otherwise in
 * two phases: retire the row to `deleting` under the repo's guard,
 * remove the payload, drop the row. The row stays until its payload is confirmed gone, so a failed removal
 * is retried by the next collection instead of leaking. `refused`: the guard held it back.
 */
export async function removeVersion(
    ctx: StoreContext,
    call: Call,
    id: string
): Promise<'removed' | 'refused' | 'failed'> {
    if (!ctx.payloads.twoPhase) {
        const removed = await attempt(call, (b) => ctx.repo.removeInPlace(id, ctx.payloads.storage, b), 'once');
        return removed.kind !== 'ok' ? 'failed' : removed.value ? 'removed' : 'refused';
    }
    const retired = await attempt(call, (b) => ctx.repo.retireVersion(id, ctx.payloads.storage, b), 'once');
    if (retired.kind !== 'ok') {
        return 'failed';
    }
    const row = retired.value;
    if (!row) {
        return 'refused';
    }
    const removed = await attempt(call, (b) => ctx.payloads.remove(row, b, call.signal), 'once');
    if (removed.kind !== 'ok') {
        return 'failed';
    }
    const dropped = await attempt(call, (b) => ctx.repo.dropVersion(id, b), 'once');
    return dropped.kind === 'ok' && dropped.value ? 'removed' : 'failed';
}
