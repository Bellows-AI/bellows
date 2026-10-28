import type { OperationRow } from './postgres-secret-repo.js';
import {
    type StoreContext,
    callFor,
    errorOf,
    fail,
    failWith,
    integrityFailure,
    issueExpired,
    operationExpired,
    parseOperationId,
    readFailure,
    readPayload,
    terminal,
    unavailable,
} from './postgres-secret-support.js';
import { type Call, attempt, whenReady } from './secret-call.js';
import { identityKey, isSecretRef, validateIdentity } from './secret-input.js';
import type {
    OperationStatus,
    ReadSecretInput,
    ReconcileInput,
    SecretRef,
    SecretResult,
    SecretVersion,
} from './secret-store.js';

/** The read path of the PostgreSQL store: read-active and reconcile. A read that fails is never `not-found`. */

type Read = SecretResult<{ value: Uint8Array; version: SecretVersion }>;
type Reconcile = SecretResult<{ status: OperationStatus }>;

export async function readActive(ctx: StoreContext, input: ReadSecretInput): Promise<Read> {
    const { identity, ref } = input;
    const identityError = validateIdentity(identity);
    if (identityError) {
        return fail(identityError);
    }
    if (!isSecretRef(ref)) {
        return failWith('invalid-input', 'ref-invalid');
    }
    const call = callFor(ctx, input.signal);
    if (!(await whenReady(ctx.ready, call))) {
        return unavailable();
    }
    const read = await attempt(call, (b) => ctx.repo.readActive(ref, b), 'read');
    if (read.kind !== 'ok') {
        return readFailure(read);
    }
    const row = read.value;
    const key = identityKey(identity);
    if (!row) {
        return failWith('not-found', 'reference-not-found');
    }
    if (row.identityKey !== key) {
        return failWith('identity-mismatch', 'identity-mismatch');
    }
    if (row.state !== 'active') {
        return failWith('not-found', 'reference-not-found');
    }
    // Active without a pointed-at version is a broken store: inconclusive, never `not-found`.
    if (!row.version) {
        return integrityFailure();
    }
    const aad = { identityKey: key, ref, logicalVersion: row.version.logicalVersion };
    const stored = await readPayload(ctx, call, row.version, aad);
    if (stored.kind !== 'ok') {
        return readFailure(stored);
    }
    // The active version's payload missing or not verifying is a broken store too, whatever the provider said.
    return stored.value instanceof Uint8Array
        ? { ok: true, value: stored.value, version: row.version.logicalVersion as SecretVersion }
        : integrityFailure();
}

function statusOf(op: OperationRow): OperationStatus {
    if (op.state === 'succeeded') {
        return { state: 'succeeded', result: { version: op.newVersion as SecretVersion | null } };
    }
    return op.state === 'failed' ? { state: 'failed', error: errorOf(op) } : { state: op.state };
}

/** The operation as the caller may see it, or the error that says it is not theirs. */
function visibleTo(ctx: StoreContext, rec: OperationRow | null, key: string, ref: string) {
    if (!rec) {
        return null;
    }
    if (rec.identityKey !== key) {
        return failWith('identity-mismatch', 'identity-mismatch');
    }
    if (rec.ref !== ref) {
        return failWith('not-found', 'operation-not-found');
    }
    return terminal(rec) && operationExpired(ctx, rec) ? failWith('invalid-input', 'operation-id-expired') : null;
}

type Staged = { kind: 'ready' } | { kind: 'wait' } | { kind: 'stop'; result: Reconcile };

/** A create or replace rolls forward only from a staged version that verifies; a missing one proves nothing. */
async function checkStaged(ctx: StoreContext, call: Call, rec: OperationRow): Promise<Staged> {
    if (rec.kind === 'delete') {
        return { kind: 'ready' };
    }
    const versionId = rec.versionId;
    const found = versionId ? await attempt(call, (b) => ctx.repo.findVersion(versionId, b), 'read') : null;
    if (found && found.kind !== 'ok') {
        return { kind: 'stop', result: readFailure(found) };
    }
    const version = found?.kind === 'ok' ? found.value : null;
    if (!version) {
        return { kind: 'wait' };
    }
    const aad = { identityKey: rec.identityKey, ref: rec.ref, logicalVersion: rec.newVersion ?? '' };
    const stored = await readPayload(ctx, call, version, aad);
    if (stored.kind !== 'ok') {
        return { kind: 'stop', result: readFailure(stored) };
    }
    if (stored.value === 'absent') {
        // Only a payload store that confirmed there is none says so: the write may not have landed yet.
        return { kind: 'wait' };
    }
    return stored.value ? { kind: 'ready' } : { kind: 'stop', result: integrityFailure() };
}

/** Roll an unresolved operation forward (or fail it, if it lost) and return the settled row. */
async function settle(ctx: StoreContext, call: Call, rec: OperationRow): Promise<OperationRow | Reconcile> {
    const staged = await checkStaged(ctx, call, rec);
    if (staged.kind === 'stop') {
        return staged.result;
    }
    if (staged.kind === 'wait') {
        return rec;
    }
    const settled = await attempt(
        call,
        (b) => ctx.repo.activate(rec.operationId, 'reconcile', ctx.clock.now(), b),
        'write'
    );
    if (settled.kind === 'ambiguous') {
        return failWith('outcome-unknown', 'provider-timeout');
    }
    if (settled.kind !== 'ok') {
        return readFailure(settled);
    }
    if (settled.value === 'missing') {
        return integrityFailure();
    }
    ctx.log({ event: 'operation-reconciled', kind: settled.value.kind, ref: rec.ref as SecretRef });
    return settled.value;
}

export async function reconcile(ctx: StoreContext, input: ReconcileInput): Promise<Reconcile> {
    const { identity, ref, operationId } = input;
    const identityError = validateIdentity(identity);
    if (identityError) {
        return fail(identityError);
    }
    if (!isSecretRef(ref)) {
        return failWith('invalid-input', 'ref-invalid');
    }
    const parsed = parseOperationId(ctx, operationId);
    if (!parsed) {
        return failWith('invalid-input', 'operation-id-invalid');
    }
    const key = identityKey(identity);
    const call = callFor(ctx, input.signal);
    if (!(await whenReady(ctx.ready, call))) {
        return unavailable();
    }
    const secret = await attempt(call, (b) => ctx.repo.findSecret(ref, b), 'read');
    if (secret.kind !== 'ok') {
        return readFailure(secret);
    }
    if (secret.value && secret.value.identityKey !== key) {
        return failWith('identity-mismatch', 'identity-mismatch');
    }
    const found = await attempt(call, (b) => ctx.repo.findOperation(operationId, b), 'read');
    if (found.kind !== 'ok') {
        return readFailure(found);
    }
    if (!found.value) {
        return issueExpired(ctx, parsed.issuedAt)
            ? failWith('invalid-input', 'operation-id-expired')
            : failWith('not-found', 'operation-not-found');
    }
    const refused = visibleTo(ctx, found.value, key, ref);
    if (refused) {
        return refused;
    }
    const settled = terminal(found.value) ? found.value : await settle(ctx, call, found.value);
    return 'ok' in settled ? settled : { ok: true, status: statusOf(settled) };
}
