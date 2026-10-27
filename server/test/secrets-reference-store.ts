import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
    MAX_SECRET_BYTES,
    OPERATION_RETENTION_MS,
    identityKey,
    isSecretRef,
    secretError,
    validateIdentity,
    validatePayload,
} from '../src/secrets/secret-input.js';
import type {
    CreateSecretInput,
    DeleteSecretInput,
    OperationId,
    OperationStatus,
    ReadSecretInput,
    ReconcileInput,
    ReplaceSecretInput,
    SecretDiagnostic,
    SecretError,
    SecretIdentity,
    SecretRef,
    SecretResult,
    SecretStore,
    SecretVersion,
} from '../src/secrets/secret-store.js';
import {
    type FaultStep,
    type SecretStoreFaults,
    type SecretStoreHarness,
    createFaults,
} from './secrets-conformance.js';

/**
 * TEST-ONLY reference implementation of `SecretStore`. It lives under `server/test/` on purpose:
 * `server/tsconfig.json` has `rootDir: src`, so nothing in `src` can import it and it never reaches
 * `dist` (`server/test/secrets.boundary.test.ts`). All state is plain, structuredClone-able data in
 * `ReferenceDurableState`; an instance keeps nothing else, so `reopen()` over a clone of the state
 * is exactly a process restart. `defects` seed deliberate contract violations that the meta suite
 * (`secrets.conformance-meta.test.ts`) uses to prove each conformance case can fail.
 */

type Kind = 'create' | 'replace' | 'delete';

interface SecretRow {
    identityKey: string;
    state: 'active' | 'tombstoned';
    activeVersion: string | null;
    activeProviderVersion: string | null;
}

interface VersionRow {
    ref: string;
    logicalVersion: string;
    state: 'staged' | 'active' | 'collectable' | 'cleanup-pending';
    operationId: string | null;
}

interface OperationRecord {
    kind: Kind;
    ref: string;
    identityKey: string;
    expectedVersion: string | null;
    /** HMAC-SHA256 under a key held outside the database; never a bare hash of the payload. */
    fingerprint: string;
    state: 'pending' | 'unknown' | 'succeeded' | 'failed';
    providerVersion: string | null;
    newVersion: string | null;
    error: SecretError | null;
    issuedAt: number;
    completedAt: number | null;
}

interface ProviderObject {
    keyId: string;
    bytes: Uint8Array;
    check: string;
}

export interface ReferenceDurableState {
    /** What PostgreSQL would hold: metadata, lifecycle, operation records, the active pointer. No bytes. */
    db: {
        secrets: Record<string, SecretRow>;
        versions: Record<string, VersionRow>;
        operations: Record<string, OperationRecord>;
    };
    /** Stand-in for the external provider: staged and active bytes by private provider version. */
    provider: Record<string, ProviderObject>;
    /** Stand-in for keys held outside the database. */
    keys: { fingerprint: string; operation: string };
}

export function createReferenceState(): ReferenceDurableState {
    return {
        db: { secrets: {}, versions: {}, operations: {} },
        provider: {},
        keys: { fingerprint: randomBytes(32).toString('hex'), operation: randomBytes(32).toString('hex') },
    };
}

export interface ReferenceDefects {
    exposeStaged?: boolean;
    skipReadIdentity?: boolean;
    skipMutationIdentity?: boolean;
    skipStatusIdentity?: boolean;
    ignoreUserOrgId?: boolean;
    plainSha256Fingerprint?: boolean;
    storePlaintextInDb?: boolean;
    leakProviderBody?: boolean;
    reconcileResurrects?: boolean;
    activateWithoutCas?: boolean;
    ignoreExpectedVersion?: boolean;
    collectActive?: boolean;
    collectPending?: boolean;
    pruneUnresolved?: boolean;
    reuseVersionOnIdenticalBytes?: boolean;
    rekeyBumpsVersion?: boolean;
    reuseTombstonedRef?: boolean;
    deleteMissingOk?: boolean;
    replayReexecutes?: boolean;
    replayWritesAgain?: boolean;
    replayRerunsPreflight?: boolean;
    skipOperationBinding?: boolean;
    skipOperationExpiry?: boolean;
    skipOperationMac?: boolean;
    skipUnknownBlock?: boolean;
    blockOnPending?: boolean;
    timeoutAsUnavailable?: boolean;
    cleanupFailRestores?: boolean;
    skipAbortCheck?: boolean;
    skipIntegrityCheck?: boolean;
    readErrorAsNotFound?: boolean;
    validateAfterIntent?: boolean;
    mangleBinary?: boolean;
    nullAsEmpty?: boolean;
    rejectEmpty?: boolean;
    offByOneLimit?: boolean;
    skipFailureRecord?: boolean;
    aliasPayload?: boolean;
    aliasRead?: boolean;
    rawIdentityDeref?: boolean;
}

export interface ReferenceStoreConfig {
    state: ReferenceDurableState;
    clock: { now(): number };
    faults?: SecretStoreFaults | undefined;
    log?: ((diagnostic: SecretDiagnostic) => void) | undefined;
    defects?: ReferenceDefects | undefined;
}

export interface ReferenceSecretStore extends SecretStore {
    rekey(identity: SecretIdentity, ref: SecretRef): Promise<void>;
    collect(): Promise<void>;
    tamper(ref: SecretRef): void;
}

class ProviderFault extends Error {
    constructor(
        readonly kind: 'timeout' | 'unavailable',
        body: string
    ) {
        super(body);
    }
}

type Resolution = { ok: true; version: string | null } | { ok: false; error: SecretError };

const OPERATION_ID = /^op_(\d+)_([0-9a-f]{16})_([0-9a-f]{64})$/;
const fail = (error: SecretError): { ok: false; error: SecretError } => ({ ok: false, error });
const failWith = (code: SecretError['code'], reason: SecretError['reason']) => fail(secretError(code, reason));
const terminal = (rec: OperationRecord) => rec.state === 'succeeded' || rec.state === 'failed';

export function createReferenceSecretStore(config: ReferenceStoreConfig): ReferenceSecretStore {
    const { state, clock } = config;
    const faults = config.faults ?? createFaults();
    const defects = config.defects ?? {};
    const log = (diagnostic: SecretDiagnostic) => config.log?.(diagnostic);
    const hmac = (key: string, ...parts: Array<string | Uint8Array>) => {
        const h = createHmac('sha256', key);
        for (const part of parts) {
            h.update(part);
        }
        return h.digest('hex');
    };
    const keyOf = (identity: SecretIdentity) => {
        if (defects.ignoreUserOrgId && identity.owner.kind === 'user') {
            return identityKey({ ...identity, owner: { ...identity.owner, orgId: null } });
        }
        return identityKey(identity);
    };
    const check = (providerVersion: string, data: Uint8Array) =>
        hmac(state.keys.fingerprint, 'integrity|', providerVersion, '|', data);
    /** `rawIdentityDeref` models a validator that dereferences fields it never checked. */
    const checkIdentity = (identity: SecretIdentity) => {
        if (defects.rawIdentityDeref) {
            void identity.scope.type;
            void identity.owningRecord.type;
        }
        return validateIdentity(identity);
    };
    const copyBytes = (data: Uint8Array) =>
        defects.mangleBinary ? new TextEncoder().encode(new TextDecoder().decode(data)) : Uint8Array.from(data);

    const parseOperationId = (raw: unknown): { issuedAt: number } | null => {
        const match = typeof raw === 'string' ? OPERATION_ID.exec(raw) : null;
        if (!match) {
            return null;
        }
        const [, issuedAt, nonce, mac] = match;
        if (!defects.skipOperationMac && hmac(state.keys.operation, `${issuedAt}.${nonce}`) !== mac) {
            return null;
        }
        return { issuedAt: Number(issuedAt) };
    };

    const expired = (rec: OperationRecord) =>
        !defects.skipOperationExpiry &&
        rec.completedAt !== null &&
        clock.now() - rec.completedAt > OPERATION_RETENTION_MS;

    const step = async (name: FaultStep, operationId: string) => {
        await faults.onStep?.({ step: name, operationId: operationId as OperationId });
    };

    const fingerprint = (kind: Kind, ref: string, expected: string | null, payload: Uint8Array) =>
        defects.plainSha256Fingerprint
            ? createHash('sha256').update(payload).digest('hex')
            : hmac(state.keys.fingerprint, `${kind}|${ref}|${expected ?? ''}|`, payload);

    function resolutionOf(rec: OperationRecord): Resolution {
        return rec.state === 'succeeded'
            ? { ok: true, version: rec.newVersion }
            : fail(rec.error ?? secretError('integrity-failure', 'integrity-check-failed'));
    }

    function finish(rec: OperationRecord, error: SecretError | null): Resolution {
        rec.completedAt = clock.now();
        rec.error = error;
        rec.state = error ? 'failed' : 'succeeded';
        if (error && rec.providerVersion) {
            const staged = state.db.versions[rec.providerVersion];
            if (staged?.state === 'staged') {
                staged.state = 'collectable';
            }
        }
        log({ event: 'mutation-finished', kind: rec.kind, ref: rec.ref as SecretRef, ...(error ?? {}) });
        return resolutionOf(rec);
    }

    /** The compare-and-set. Synchronous on purpose: everything is re-read, nothing from before an await is trusted. */
    function activate(recordId: string, origin: 'request' | 'reconcile'): Resolution {
        const rec = state.db.operations[recordId];
        if (!rec) {
            return failWith('integrity-failure', 'integrity-check-failed');
        }
        if (terminal(rec)) {
            return resolutionOf(rec);
        }
        const row = state.db.secrets[rec.ref];
        const stale = secretError('conflict', 'stale-version');
        if (rec.kind === 'create') {
            if (row && !defects.activateWithoutCas && !(row.state === 'tombstoned' && defects.reuseTombstonedRef)) {
                return finish(rec, secretError('conflict', 'reference-exists'));
            }
        } else {
            const resurrect = origin === 'reconcile' && defects.reconcileResurrects && row;
            if ((!row || row.state !== 'active') && !resurrect && !defects.activateWithoutCas) {
                return finish(rec, stale);
            }
            if (
                row?.state === 'active' &&
                !defects.activateWithoutCas &&
                !defects.ignoreExpectedVersion &&
                row.activeVersion !== rec.expectedVersion
            ) {
                return finish(rec, stale);
            }
        }
        const previous = row?.activeProviderVersion ? state.db.versions[row.activeProviderVersion] : undefined;
        if (rec.kind === 'delete') {
            if (row) {
                row.state = 'tombstoned';
                row.activeVersion = null;
                row.activeProviderVersion = null;
            }
            if (previous) {
                previous.state = 'cleanup-pending';
            }
        } else {
            const staged = state.db.versions[rec.providerVersion ?? ''];
            if (!staged || !rec.newVersion || !rec.providerVersion) {
                return failWith('integrity-failure', 'integrity-check-failed');
            }
            staged.state = 'active';
            if (previous) {
                previous.state = 'collectable';
            }
            state.db.secrets[rec.ref] = {
                identityKey: rec.identityKey,
                state: 'active',
                activeVersion: rec.newVersion,
                activeProviderVersion: rec.providerVersion,
            };
        }
        return finish(rec, null);
    }

    async function providerPut(providerVersion: string, data: Uint8Array): Promise<void> {
        faults.providerWriteCount += 1;
        await Promise.resolve();
        const mode = faults.providerWrite;
        if (mode === 'timeout-lost') {
            throw new ProviderFault('timeout', '');
        }
        if (mode === 'unavailable-with-body') {
            throw new ProviderFault('unavailable', faults.providerErrorBody);
        }
        state.provider[providerVersion] = {
            keyId: `key_${randomUUID()}`,
            bytes: copyBytes(data),
            check: check(providerVersion, data),
        };
        if (mode === 'timeout-applied') {
            throw new ProviderFault('timeout', '');
        }
    }

    async function stage(rec: OperationRecord, recordId: string, payload: Uint8Array): Promise<SecretError | null> {
        try {
            await providerPut(rec.providerVersion ?? '', payload);
            return null;
        } catch (error) {
            if (!(error instanceof ProviderFault)) {
                throw error;
            }
            const live = state.db.operations[recordId];
            if (error.kind === 'timeout' && !defects.timeoutAsUnavailable) {
                if (live?.state === 'pending') {
                    live.state = 'unknown';
                }
                log({ event: 'operation-unknown', kind: rec.kind, ref: rec.ref as SecretRef });
                return secretError('outcome-unknown', 'provider-timeout');
            }
            const diagnostic: SecretDiagnostic = { event: 'provider-error', kind: rec.kind, ref: rec.ref as SecretRef };
            log(defects.leakProviderBody ? ({ ...diagnostic, detail: error.message } as SecretDiagnostic) : diagnostic);
            return secretError('unavailable', error.kind === 'timeout' ? 'provider-timeout' : 'provider-unavailable');
        }
    }

    async function cleanup(providerVersion: string): Promise<void> {
        if (faults.providerDelete === 'fail') {
            log({ event: 'cleanup-failed' });
            return;
        }
        delete state.provider[providerVersion];
        delete state.db.versions[providerVersion];
        log({ event: 'collected' });
    }

    async function drive(
        recordId: string,
        payload: Uint8Array | null,
        signal: AbortSignal | undefined
    ): Promise<Resolution> {
        const rec = state.db.operations[recordId];
        if (!rec) {
            return failWith('integrity-failure', 'integrity-check-failed');
        }
        await step('after-intent', recordId);
        if (rec.kind !== 'delete' && payload) {
            if (signal?.aborted && !defects.skipAbortCheck) {
                return failWith('unavailable', 'aborted');
            }
            const stageError = await stage(rec, recordId, payload);
            if (stageError) {
                return fail(stageError);
            }
            await step('after-stage', recordId);
        }
        await step('before-activate', recordId);
        const resolution = activate(recordId, 'request');
        await step('after-activate', recordId);
        if (rec.kind === 'delete' && resolution.ok) {
            const old = Object.entries(state.db.versions).find(
                ([, v]) => v.ref === rec.ref && v.state === 'cleanup-pending'
            );
            if (old) {
                await cleanup(old[0]);
                if (faults.providerDelete === 'fail' && defects.cleanupFailRestores) {
                    const row = state.db.secrets[rec.ref];
                    if (row) {
                        row.state = 'active';
                        row.activeVersion = old[1].logicalVersion;
                        row.activeProviderVersion = old[0];
                    }
                }
            }
        }
        return resolution;
    }

    function toResult(kind: Kind, resolution: Resolution): SecretResult<{ version: SecretVersion }> | SecretResult {
        if (!resolution.ok) {
            return resolution;
        }
        return kind === 'delete' ? { ok: true } : { ok: true, version: resolution.version as SecretVersion };
    }

    async function mutate(
        kind: Kind,
        input: {
            identity: SecretIdentity;
            ref: SecretRef;
            operationId: OperationId;
            payload?: Uint8Array;
            expectedVersion?: SecretVersion;
            signal?: AbortSignal | undefined;
        }
    ): Promise<Resolution> {
        const { identity, ref, operationId } = input;
        const identityError = checkIdentity(identity);
        if (identityError) {
            return fail(identityError);
        }
        if (!isSecretRef(ref)) {
            return failWith('invalid-input', 'ref-invalid');
        }
        const parsed = parseOperationId(operationId);
        if (!parsed) {
            return failWith('invalid-input', 'operation-id-invalid');
        }
        let payload: Uint8Array = new Uint8Array(0);
        let payloadError: SecretError | null = null;
        if (kind !== 'delete') {
            const candidate =
                defects.nullAsEmpty && (input.payload === null || input.payload === undefined)
                    ? new Uint8Array(0)
                    : input.payload;
            const checked = validatePayload(candidate);
            if (!checked.ok) {
                payloadError = checked.error;
            } else if (defects.rejectEmpty && checked.bytes.byteLength === 0) {
                payloadError = secretError('invalid-input', 'payload-null');
            } else if (defects.offByOneLimit && checked.bytes.byteLength >= MAX_SECRET_BYTES) {
                payloadError = secretError('invalid-input', 'payload-too-large');
            } else {
                // Own the bytes before any await: the caller's buffer may change under a pending call.
                payload = defects.aliasPayload ? checked.bytes : Uint8Array.from(checked.bytes);
            }
        }
        const expected = kind === 'create' ? null : (input.expectedVersion ?? null);
        if (kind !== 'create' && (typeof expected !== 'string' || expected.length === 0)) {
            return failWith('invalid-input', 'version-invalid');
        }
        const key = keyOf(identity);
        const fp = fingerprint(kind, ref, expected, payload);
        if (payloadError) {
            if (defects.validateAfterIntent) {
                state.db.operations[operationId] = intentRecord({
                    kind,
                    ref,
                    key,
                    expected,
                    fp,
                    issuedAt: parsed.issuedAt,
                    providerVersion: null,
                    newVersion: null,
                });
            }
            return fail(payloadError);
        }

        const row = state.db.secrets[ref];
        const rec = state.db.operations[operationId];
        if (rec) {
            if (rec.identityKey !== key && !defects.skipMutationIdentity) {
                return failWith('identity-mismatch', 'identity-mismatch');
            }
            const same =
                rec.kind === kind && rec.ref === ref && rec.expectedVersion === expected && rec.fingerprint === fp;
            if (!same && !defects.skipOperationBinding) {
                return failWith('conflict', 'operation-id-reused');
            }
            if (terminal(rec) && expired(rec)) {
                return failWith('invalid-input', 'operation-id-expired');
            }
            if (terminal(rec)) {
                return replayTerminal(rec, kind, expected, payload);
            }
            return drive(operationId, payload, input.signal);
        }
        if (!defects.skipOperationExpiry && clock.now() - parsed.issuedAt > OPERATION_RETENTION_MS) {
            return failWith('invalid-input', 'operation-id-expired');
        }
        if (defects.deleteMissingOk && kind === 'delete' && row?.state === 'tombstoned') {
            return { ok: true, version: null };
        }
        const definitive = (error: SecretError): Resolution => {
            if (!defects.skipFailureRecord) {
                state.db.operations[operationId] = {
                    ...intentRecord({
                        kind,
                        ref,
                        key,
                        expected,
                        fp,
                        issuedAt: parsed.issuedAt,
                        providerVersion: null,
                        newVersion: null,
                    }),
                    state: 'failed',
                    error,
                    completedAt: clock.now(),
                };
            }
            return fail(error);
        };
        if (row && row.identityKey !== key && !defects.skipMutationIdentity) {
            return definitive(secretError('identity-mismatch', 'identity-mismatch'));
        }
        const preflightError = preflight(kind, ref, expected, operationId);
        if (preflightError) {
            return definitive(preflightError.error);
        }
        if (input.signal?.aborted && !defects.skipAbortCheck) {
            return failWith('unavailable', 'aborted');
        }
        const providerVersion = kind === 'delete' ? null : `pv_${randomUUID()}`;
        const previousLogical =
            row?.activeVersion && defects.reuseVersionOnIdenticalBytes && kind === 'replace' ? row.activeVersion : null;
        const newVersion = kind === 'delete' ? null : (previousLogical ?? `ver_${randomUUID()}`);
        const fresh = intentRecord({
            kind,
            ref,
            key,
            expected,
            fp,
            issuedAt: parsed.issuedAt,
            providerVersion,
            newVersion,
        });
        if (defects.storePlaintextInDb) {
            (fresh as unknown as Record<string, unknown>).payload = Buffer.from(payload).toString('base64');
        }
        state.db.operations[operationId] = fresh;
        if (providerVersion && newVersion) {
            state.db.versions[providerVersion] = { ref, logicalVersion: newVersion, state: 'staged', operationId };
        }
        return drive(operationId, kind === 'delete' ? null : payload, input.signal);
    }

    function intentRecord(i: {
        kind: Kind;
        ref: string;
        key: string;
        expected: string | null;
        fp: string;
        issuedAt: number;
        providerVersion: string | null;
        newVersion: string | null;
    }): OperationRecord {
        return {
            kind: i.kind,
            ref: i.ref,
            identityKey: i.key,
            expectedVersion: i.expected,
            fingerprint: i.fp,
            state: 'pending',
            providerVersion: i.providerVersion,
            newVersion: i.newVersion,
            error: null,
            issuedAt: i.issuedAt,
            completedAt: null,
        };
    }

    /** Read-only checks before an intent record exists; none of them leaves a trace. */
    function preflight(
        kind: Kind,
        ref: string,
        expected: string | null,
        operationId: string
    ): { ok: false; error: SecretError } | null {
        const row = state.db.secrets[ref];
        const blocked = Object.entries(state.db.operations).some(
            ([id, other]) =>
                id !== operationId &&
                other.ref === ref &&
                (other.state === 'unknown' || (defects.blockOnPending && other.state === 'pending')) &&
                !defects.skipUnknownBlock
        );
        if (kind === 'create') {
            if (row && !(row.state === 'tombstoned' && defects.reuseTombstonedRef)) {
                return failWith('conflict', 'reference-exists');
            }
        } else if (!row || row.state !== 'active') {
            return failWith('not-found', 'reference-not-found');
        } else if (!defects.ignoreExpectedVersion && row.activeVersion !== expected) {
            return failWith('conflict', 'stale-version');
        }
        return blocked ? failWith('conflict', 'operation-pending') : null;
    }

    function replayTerminal(
        rec: OperationRecord,
        kind: Kind,
        expected: string | null,
        payload: Uint8Array
    ): Resolution {
        if (defects.replayRerunsPreflight) {
            const error = preflight(kind, rec.ref, expected, '');
            if (error) {
                return error;
            }
        }
        if (defects.replayReexecutes && rec.state === 'succeeded' && rec.kind !== 'delete' && rec.providerVersion) {
            const row = state.db.secrets[rec.ref];
            if (row) {
                row.state = 'active';
                row.activeVersion = rec.newVersion;
                row.activeProviderVersion = rec.providerVersion;
            }
        }
        if (defects.replayWritesAgain && rec.kind !== 'delete') {
            faults.providerWriteCount += 1;
            state.provider[rec.providerVersion ?? ''] = {
                keyId: 'rewritten',
                bytes: copyBytes(payload),
                check: check(rec.providerVersion ?? '', payload),
            };
        }
        return resolutionOf(rec);
    }

    const store: ReferenceSecretStore = {
        async issueOperationId() {
            const issuedAt = clock.now();
            const nonce = randomBytes(8).toString('hex');
            return `op_${issuedAt}_${nonce}_${hmac(state.keys.operation, `${issuedAt}.${nonce}`)}` as OperationId;
        },

        async create(input: CreateSecretInput) {
            return toResult('create', await mutate('create', input)) as SecretResult<{ version: SecretVersion }>;
        },

        async replace(input: ReplaceSecretInput) {
            return toResult('replace', await mutate('replace', input)) as SecretResult<{ version: SecretVersion }>;
        },

        async delete(input: DeleteSecretInput) {
            return toResult('delete', await mutate('delete', input)) as SecretResult;
        },

        async readActive(input: ReadSecretInput) {
            const { identity, ref } = input;
            const identityError = checkIdentity(identity);
            if (identityError) {
                return fail(identityError);
            }
            if (!isSecretRef(ref)) {
                return failWith('invalid-input', 'ref-invalid');
            }
            const row = state.db.secrets[ref];
            if (!row) {
                return failWith('not-found', 'reference-not-found');
            }
            if (row.identityKey !== keyOf(identity) && !defects.skipReadIdentity) {
                return failWith('identity-mismatch', 'identity-mismatch');
            }
            if (row.state !== 'active') {
                return failWith('not-found', 'reference-not-found');
            }
            if (faults.providerRead === 'unavailable') {
                return defects.readErrorAsNotFound
                    ? failWith('not-found', 'reference-not-found')
                    : failWith('unavailable', 'provider-unavailable');
            }
            let providerVersion = row.activeProviderVersion ?? '';
            let version = row.activeVersion ?? '';
            if (defects.exposeStaged) {
                const staged = Object.entries(state.db.versions).find(([, v]) => v.ref === ref && v.state === 'staged');
                if (staged && state.provider[staged[0]]) {
                    providerVersion = staged[0];
                    version = staged[1].logicalVersion;
                }
            }
            const object = state.provider[providerVersion];
            if (!object || (!defects.skipIntegrityCheck && object.check !== check(providerVersion, object.bytes))) {
                return failWith('integrity-failure', 'integrity-check-failed');
            }
            return {
                ok: true,
                value: defects.aliasRead ? object.bytes : Uint8Array.from(object.bytes),
                version: version as SecretVersion,
            };
        },

        async reconcileOperation(input: ReconcileInput) {
            const { identity, ref, operationId } = input;
            const identityError = checkIdentity(identity);
            if (identityError) {
                return fail(identityError);
            }
            if (!isSecretRef(ref)) {
                return failWith('invalid-input', 'ref-invalid');
            }
            const parsed = parseOperationId(operationId);
            if (!parsed) {
                return failWith('invalid-input', 'operation-id-invalid');
            }
            const key = keyOf(identity);
            const row = state.db.secrets[ref];
            if (row && row.identityKey !== key && !defects.skipStatusIdentity) {
                return failWith('identity-mismatch', 'identity-mismatch');
            }
            const rec = state.db.operations[operationId];
            if (!rec) {
                if (!defects.skipOperationExpiry && clock.now() - parsed.issuedAt > OPERATION_RETENTION_MS) {
                    return failWith('invalid-input', 'operation-id-expired');
                }
                return failWith('not-found', 'operation-not-found');
            }
            if (rec.identityKey !== key && !defects.skipStatusIdentity) {
                return failWith('identity-mismatch', 'identity-mismatch');
            }
            if (rec.ref !== ref) {
                return failWith('not-found', 'operation-not-found');
            }
            if (terminal(rec) && expired(rec)) {
                return failWith('invalid-input', 'operation-id-expired');
            }
            if (!terminal(rec)) {
                if (rec.kind !== 'delete') {
                    // A missing staged object proves nothing about the write: stay pending/unknown.
                    const object = state.provider[rec.providerVersion ?? ''];
                    if (!object) {
                        return { ok: true, status: { state: rec.state } as OperationStatus };
                    }
                    if (object.check !== check(rec.providerVersion ?? '', object.bytes)) {
                        return failWith('integrity-failure', 'integrity-check-failed');
                    }
                }
                activate(operationId, 'reconcile');
                log({ event: 'operation-reconciled', kind: rec.kind, ref });
            }
            const settled = state.db.operations[operationId] ?? rec;
            const status: OperationStatus =
                settled.state === 'succeeded'
                    ? { state: 'succeeded', result: { version: settled.newVersion as SecretVersion | null } }
                    : settled.state === 'failed'
                      ? {
                            state: 'failed',
                            error: settled.error ?? secretError('integrity-failure', 'integrity-check-failed'),
                        }
                      : { state: settled.state };
            return { ok: true, status };
        },

        async rekey(identity, ref) {
            const row = state.db.secrets[ref];
            if (!row || row.identityKey !== keyOf(identity) || row.state !== 'active' || !row.activeProviderVersion) {
                throw new Error('rekey: no active secret for that identity');
            }
            const oldPv = row.activeProviderVersion;
            const old = state.provider[oldPv];
            const oldVersion = state.db.versions[oldPv];
            if (!old || !oldVersion) {
                throw new Error('rekey: active version missing');
            }
            const newPv = `pv_${randomUUID()}`;
            const logical = defects.rekeyBumpsVersion ? `ver_${randomUUID()}` : oldVersion.logicalVersion;
            state.provider[newPv] = {
                keyId: `key_${randomUUID()}`,
                bytes: Uint8Array.from(old.bytes),
                check: check(newPv, old.bytes),
            };
            state.db.versions[newPv] = { ref, logicalVersion: logical, state: 'active', operationId: null };
            oldVersion.state = 'collectable';
            row.activeProviderVersion = newPv;
            row.activeVersion = logical;
        },

        async collect() {
            const unresolved = new Set(
                Object.values(state.db.operations)
                    .filter((op) => !terminal(op))
                    .map((op) => op.providerVersion)
            );
            for (const [pv, version] of Object.entries(state.db.versions)) {
                if (version.state === 'active') {
                    if (defects.collectActive) {
                        delete state.provider[pv];
                    }
                } else if (version.state === 'staged') {
                    if (defects.collectPending) {
                        delete state.provider[pv];
                    }
                } else if (!unresolved.has(pv)) {
                    await cleanup(pv);
                }
            }
            for (const [id, op] of Object.entries(state.db.operations)) {
                const finished = terminal(op) && expired(op);
                const abandoned = defects.pruneUnresolved && clock.now() - op.issuedAt > OPERATION_RETENTION_MS;
                if (finished || abandoned) {
                    delete state.db.operations[id];
                }
            }
        },

        tamper(ref) {
            const pv = state.db.secrets[ref]?.activeProviderVersion;
            const object = pv ? state.provider[pv] : undefined;
            if (!object || object.bytes.length === 0) {
                throw new Error('tamper: nothing to corrupt');
            }
            object.bytes[0] = (object.bytes[0] ?? 0) ^ 0xff;
        },
    };
    return store;
}

/** The conformance harness over the reference store; `defects` build the meta suite's broken variants. */
export function createReferenceHarness(defects: ReferenceDefects = {}): SecretStoreHarness {
    let state = createReferenceState();
    let now = Date.UTC(2026, 0, 1);
    const clock = { now: () => now };
    const faults = createFaults();
    const diagnostics: unknown[] = [];
    const open = () => createReferenceSecretStore({ state, clock, faults, log: (d) => diagnostics.push(d), defects });
    return {
        open,
        reopen() {
            state = structuredClone(state);
            return open();
        },
        clock: {
            advance(ms) {
                now += ms;
            },
        },
        faults,
        rekey: (identity, ref) => open().rekey(identity, ref),
        collect: () => open().collect(),
        tamper: (ref) => open().tamper(ref),
        durableSnapshot: () => ({ ...structuredClone(state) }),
        diagnostics: () => structuredClone(diagnostics),
    };
}
