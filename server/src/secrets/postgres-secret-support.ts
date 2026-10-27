import { timingSafeEqual } from 'node:crypto';
import type { OperationRow, SecretRepo } from './postgres-secret-repo.js';
import { type Call, newCall } from './secret-call.js';
import { type EnvelopeContext, decryptEnvelope, encryptEnvelope, envelopeKeyId } from './secret-envelope.js';
import { type SecretKeys, operationMac } from './secret-keys.js';
import { OPERATION_RETENTION_MS, secretError } from './secret-input.js';
import type { SecretDiagnostic, SecretError } from './secret-store.js';

/** What every part of the PostgreSQL store shares: its collaborators and the small result helpers. */
export interface StoreContext {
    repo: SecretRepo;
    keys: SecretKeys;
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

/** A failed read or best-effort step: never `not-found`, never a negative verdict. */
export const readFailure = (a: { kind: string }) => (a.kind === 'aborted' ? aborted() : unavailable());

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

/** Encrypts under the active key; null when the active key is not in the ring. */
export function seal(ctx: StoreContext, aad: EnvelopeContext, payload: Uint8Array) {
    const keyId = ctx.keys.activeKeyId;
    const key = ctx.keys.dataKeys.get(keyId);
    return key ? { keyId, envelope: encryptEnvelope(keyId, key, payload, aad) } : null;
}

/** The plaintext of a stored envelope, or null when anything about it does not check out. */
export function open(ctx: StoreContext, row: { keyId: string; envelope: Buffer }, aad: EnvelopeContext) {
    if (envelopeKeyId(row.envelope) !== row.keyId) {
        return null;
    }
    const out = decryptEnvelope(ctx.keys.dataKeys, row.envelope, aad);
    return out.ok ? out.plaintext : null;
}

/** Constant-time equality of two byte strings of any length. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && timingSafeEqual(a, b);
}
