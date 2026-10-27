import { randomUUID } from 'node:crypto';
import type { NewOperation, OperationKind, OperationRow, VersionRow } from './postgres-secret-repo.js';
import {
    type Resolution,
    type StoreContext,
    aborted,
    callFor,
    fail,
    failWith,
    integrityFailure,
    issueExpired,
    open,
    operationExpired,
    parseOperationId,
    readFailure,
    resolutionOf,
    sameBytes,
    seal,
    terminal,
    unavailable,
} from './postgres-secret-support.js';
import { type Call, attempt, whenReady } from './secret-call.js';
import { isSecretRef, secretError, validateIdentity, validatePayload, identityKey } from './secret-input.js';
import { payloadFingerprint } from './secret-keys.js';
import type {
    OperationId,
    SecretDiagnostic,
    SecretError,
    SecretIdentity,
    SecretRef,
    SecretResult,
    SecretVersion,
} from './secret-store.js';

/**
 * The write path of the PostgreSQL store: create, replace, delete. The BEL-64 recovery model:
 * intent record, immutable encrypted version, one-transaction compare-and-set activation. Mirrors
 * `server/test/secrets-reference-store.ts` step for step.
 */

const MARK_UNKNOWN_MS = 500;

export interface MutationInput {
    identity: SecretIdentity;
    ref: SecretRef;
    operationId: OperationId;
    payload?: Uint8Array;
    expectedVersion?: SecretVersion;
    signal?: AbortSignal | undefined;
}

/** A mutation that passed validation: everything the later steps compare an operation against. */
interface Prepared {
    kind: OperationKind;
    ref: SecretRef;
    operationId: OperationId;
    issuedAt: number;
    payload: Uint8Array;
    expected: string | null;
    key: string;
    fingerprint: string;
    signal: AbortSignal | undefined;
}

type Validated = { ok: true; prepared: Prepared } | { ok: false; error: SecretError };

const reject = (error: SecretError): Validated => ({ ok: false, error });

function payloadOf(kind: OperationKind, input: MutationInput): Uint8Array | SecretError {
    if (kind === 'delete') {
        return new Uint8Array(0);
    }
    const checked = validatePayload(input.payload);
    // Own the bytes before any await: the caller's buffer may change under a pending call.
    return checked.ok ? Uint8Array.from(checked.bytes) : checked.error;
}

function prepare(ctx: StoreContext, kind: OperationKind, input: MutationInput): Validated {
    const { identity, ref, operationId } = input;
    const identityError = validateIdentity(identity);
    if (identityError) {
        return reject(identityError);
    }
    if (!isSecretRef(ref)) {
        return reject(secretError('invalid-input', 'ref-invalid'));
    }
    const parsed = parseOperationId(ctx, operationId);
    if (!parsed) {
        return reject(secretError('invalid-input', 'operation-id-invalid'));
    }
    const payload = payloadOf(kind, input);
    if (!(payload instanceof Uint8Array)) {
        return reject(payload);
    }
    const expected = kind === 'create' ? null : (input.expectedVersion ?? null);
    if (kind !== 'create' && (typeof expected !== 'string' || expected.length === 0)) {
        return reject(secretError('invalid-input', 'version-invalid'));
    }
    const fingerprint = payloadFingerprint(ctx.keys, { kind, ref, expectedVersion: expected, payload });
    const prepared = {
        kind,
        ref,
        operationId,
        issuedAt: parsed.issuedAt,
        payload,
        expected,
        key: identityKey(identity),
        fingerprint,
        signal: input.signal,
    };
    return { ok: true, prepared };
}

async function markUnknown(ctx: StoreContext, operationId: string): Promise<void> {
    const call = callFor(ctx, undefined, MARK_UNKNOWN_MS);
    await attempt(call, (b) => ctx.repo.markUnknown(operationId, b), 'idempotent');
}

const unknownOutcome = async (ctx: StoreContext, rec: OperationRow): Promise<Resolution> => {
    await markUnknown(ctx, rec.operationId);
    ctx.log({ event: 'operation-unknown', kind: rec.kind, ref: rec.ref as SecretRef });
    return failWith('outcome-unknown', 'provider-timeout');
};

function holdsPayload(ctx: StoreContext, stored: VersionRow, rec: OperationRow, payload: Uint8Array): boolean {
    const aad = { identityKey: rec.identityKey, ref: rec.ref, logicalVersion: rec.newVersion ?? '' };
    const plaintext = open(ctx, stored, aad);
    return plaintext !== null && sameBytes(plaintext, payload);
}

/** The "provider write": encrypt and insert the version. A final answer when it did not land, else null. */
async function stage(
    ctx: StoreContext,
    call: Call,
    rec: OperationRow,
    payload: Uint8Array
): Promise<Resolution | null> {
    if (call.signal?.aborted) {
        return aborted();
    }
    const { versionId, newVersion } = rec;
    if (!versionId || !newVersion) {
        return integrityFailure();
    }
    const sealed = seal(ctx, { identityKey: rec.identityKey, ref: rec.ref, logicalVersion: newVersion }, payload);
    if (!sealed) {
        return failWith('invalid-configuration', 'configuration-invalid');
    }
    const version = {
        id: versionId,
        ref: rec.ref,
        logicalVersion: newVersion,
        keyId: sealed.keyId,
        envelope: sealed.envelope,
        operationId: rec.operationId,
        createdAtMs: ctx.clock.now(),
    };
    const staged = await attempt(call, (b) => ctx.repo.stageVersion(version, b), 'write');
    if (staged.kind === 'ok') {
        // A finished operation stages nothing: activation answers from its record. Any row that was
        // already there is not ours until it authenticates and holds this request's payload.
        return staged.value === 'closed' || holdsPayload(ctx, staged.value, rec, payload) ? null : integrityFailure();
    }
    if (staged.kind === 'ambiguous') {
        return unknownOutcome(ctx, rec);
    }
    ctx.log({ event: 'provider-error', kind: rec.kind, ref: rec.ref as SecretRef });
    return readFailure(staged);
}

/** After a delete activated: remove its versions now; a failure is logged and never changes a read. */
async function cleanupAfterDelete(ctx: StoreContext, call: Call, ref: string): Promise<void> {
    const listed = await attempt(call, (b) => ctx.repo.listPendingCleanup(ref, b), 'once');
    if (listed.kind !== 'ok') {
        ctx.log({ event: 'cleanup-failed' });
        return;
    }
    for (const id of listed.value) {
        const deleted = await attempt(call, (b) => ctx.repo.deleteVersion(id, b), 'once');
        ctx.log({ event: deleted.kind === 'ok' ? 'collected' : 'cleanup-failed' });
    }
}

function finishedDiagnostic(done: OperationRow): SecretDiagnostic {
    const base: SecretDiagnostic = { event: 'mutation-finished', kind: done.kind, ref: done.ref as SecretRef };
    return done.errorCode && done.errorReason ? { ...base, code: done.errorCode, reason: done.errorReason } : base;
}

async function activateAndFinish(ctx: StoreContext, call: Call, rec: OperationRow): Promise<Resolution> {
    const activated = await attempt(
        call,
        (b) => ctx.repo.activate(rec.operationId, 'request', ctx.clock.now(), b),
        'write'
    );
    if (activated.kind === 'ambiguous') {
        return unknownOutcome(ctx, rec);
    }
    if (activated.kind !== 'ok') {
        ctx.log({ event: 'provider-error', kind: rec.kind, ref: rec.ref as SecretRef });
        return readFailure(activated);
    }
    if (activated.value === 'missing') {
        return integrityFailure();
    }
    const done = activated.value;
    ctx.log(finishedDiagnostic(done));
    if (rec.kind === 'delete' && done.state === 'succeeded') {
        await cleanupAfterDelete(ctx, call, rec.ref);
    }
    return resolutionOf(done);
}

/** Stage (create and replace), then activate. Used for a fresh intent and for a replay of an unresolved one. */
async function drive(ctx: StoreContext, call: Call, rec: OperationRow, payload: Uint8Array): Promise<Resolution> {
    if (rec.kind !== 'delete') {
        const stopped = await stage(ctx, call, rec, payload);
        if (stopped) {
            return stopped;
        }
    }
    return activateAndFinish(ctx, call, rec);
}

/** The operation id is known: it must be this very request, and a finished one answers from its record. */
function resume(ctx: StoreContext, call: Call, p: Prepared, rec: OperationRow): Promise<Resolution> | Resolution {
    if (rec.identityKey !== p.key) {
        return failWith('identity-mismatch', 'identity-mismatch');
    }
    const same =
        rec.kind === p.kind &&
        rec.ref === p.ref &&
        rec.expectedVersion === p.expected &&
        rec.fingerprint === p.fingerprint;
    if (!same) {
        return failWith('conflict', 'operation-id-reused');
    }
    if (terminal(rec)) {
        return operationExpired(ctx, rec) ? failWith('invalid-input', 'operation-id-expired') : resolutionOf(rec);
    }
    return drive(ctx, call, rec, p.payload);
}

function baseOperation(p: Prepared): NewOperation {
    return {
        operationId: p.operationId,
        kind: p.kind,
        ref: p.ref,
        identityKey: p.key,
        expectedVersion: p.expected,
        fingerprint: p.fingerprint,
        versionId: null,
        newVersion: null,
        issuedAtMs: p.issuedAt,
    };
}

/** The definitive refusals of a request that has no intent row yet. */
function refusalFor(p: Prepared, row: { state: string; activeVersion: string | null } | null): SecretError | null {
    if (p.kind === 'create') {
        return row ? secretError('conflict', 'reference-exists') : null;
    }
    if (!row || row.state !== 'active') {
        return secretError('not-found', 'reference-not-found');
    }
    return row.activeVersion === p.expected ? null : secretError('conflict', 'stale-version');
}

/** Records a definitive failure so the operation id is bound to it. */
async function record(ctx: StoreContext, call: Call, p: Prepared, error: SecretError): Promise<Resolution> {
    const recorded = await attempt(
        call,
        (b) => ctx.repo.insertFailure(baseOperation(p), error, ctx.clock.now(), b),
        'idempotent'
    );
    // The stored record answers, not our preflight: another replica may have completed this very request.
    return recorded.kind === 'ok' ? resume(ctx, call, p, recorded.value) : readFailure(recorded);
}

/** Read-only checks before an intent row exists; a final answer, or null to go ahead. */
async function preflight(ctx: StoreContext, call: Call, p: Prepared): Promise<Resolution | null> {
    const found = await attempt(call, (b) => ctx.repo.findSecret(p.ref, b), 'read');
    if (found.kind !== 'ok') {
        return readFailure(found);
    }
    const row = found.value;
    if (row && row.identityKey !== p.key) {
        return record(ctx, call, p, secretError('identity-mismatch', 'identity-mismatch'));
    }
    if (row?.state === 'active' && row.activeVersion === null) {
        // An active reference with no pointer is a broken store, not a fact about the request.
        return integrityFailure();
    }
    const refusal = refusalFor(p, row);
    if (refusal) {
        return record(ctx, call, p, refusal);
    }
    const blocked = await attempt(call, (b) => ctx.repo.hasUnknownOperation(p.ref, p.operationId, b), 'read');
    if (blocked.kind !== 'ok') {
        return readFailure(blocked);
    }
    return blocked.value ? record(ctx, call, p, secretError('conflict', 'operation-pending')) : null;
}

async function begin(ctx: StoreContext, call: Call, p: Prepared): Promise<Resolution> {
    const stopped = await preflight(ctx, call, p);
    if (stopped) {
        return stopped;
    }
    if (call.signal?.aborted) {
        return aborted();
    }
    const base = baseOperation(p);
    const fresh: NewOperation =
        p.kind === 'delete' ? base : { ...base, versionId: randomUUID(), newVersion: `ver_${randomUUID()}` };
    const intent = await attempt(call, (b) => ctx.repo.insertIntent(fresh, b), 'idempotent');
    if (intent.kind !== 'ok') {
        return readFailure(intent);
    }
    // The stored intent is ours or another replica's, which won the id first: either way it must be this request.
    return resume(ctx, call, p, intent.value);
}

export async function mutate(ctx: StoreContext, kind: OperationKind, input: MutationInput): Promise<Resolution> {
    const validated = prepare(ctx, kind, input);
    if (!validated.ok) {
        return fail(validated.error);
    }
    const p = validated.prepared;
    const call = callFor(ctx, input.signal);
    if (!(await whenReady(ctx.ready, call))) {
        return unavailable();
    }
    const existing = await attempt(call, (b) => ctx.repo.findOperation(p.operationId, b), 'read');
    if (existing.kind !== 'ok') {
        return readFailure(existing);
    }
    if (existing.value) {
        return resume(ctx, call, p, existing.value);
    }
    if (issueExpired(ctx, p.issuedAt)) {
        return failWith('invalid-input', 'operation-id-expired');
    }
    return begin(ctx, call, p);
}

export function toResult(
    kind: OperationKind,
    resolution: Resolution
): SecretResult<{ version: SecretVersion }> | SecretResult {
    if (!resolution.ok) {
        return resolution;
    }
    return kind === 'delete' ? { ok: true } : { ok: true, version: resolution.version as SecretVersion };
}
