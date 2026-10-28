/**
 * The single classifier of a Vault answer (docs/secrets.md): no call reads a status or a body any other way. A
 * verdict needs a recognised status for the operation and a body of the shape Vault documents for it; a success
 * additionally needs the exact fields the adapter asked for. Anything else is `unrecognized`, which is no evidence
 * of anything: for a write it is ambiguous, for a delete it never confirms removal, for a read it is never absent.
 */

export type VaultOp = 'write' | 'read' | 'delete' | 'login';

/** What an `ok` answer proved, per operation. */
export interface OkValue {
    write: { version: 1 };
    read: { name: string; versionId: string; payload: Uint8Array };
    delete: null;
    login: { token: string; leaseSeconds: number };
}

export type VaultAnswer<V> =
    | { kind: 'ok'; value: V }
    /** A 404 naming errors and no metadata: Vault says there is no such secret. */
    | { kind: 'absent' }
    /** A 404 carrying `data.metadata`: the version was soft-deleted or destroyed, which is not absence. */
    | { kind: 'tombstoned' }
    /** A write refused because the secret already exists (check-and-set 0). */
    | { kind: 'exists' }
    /** A 403 (or a refused login) naming errors: the credential is not accepted for this. */
    | { kind: 'denied' }
    /** A 404 for a route no engine serves: the mount or the auth method is not enabled. */
    | { kind: 'unmounted' }
    /** 429 or any 5xx: Vault is busy or failing, not the request wrong. */
    | { kind: 'retry' }
    | { kind: 'unrecognized' };

/** The only version this adapter writes and reads: one secret per storage version, written once. */
export const OBJECT_VERSION = 1;

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const HTTP_STATUS_LIMIT = 600;
const CAS_MISMATCH = /check-and-set parameter did not match/;
const NO_ROUTE = /no handler for route/;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function parse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** Vault's `errors` list, only when the body names one of strings. */
function errorsOf(json: unknown): string[] | null {
    const errors = isObject(json) ? json.errors : undefined;
    return Array.isArray(errors) && errors.every((item) => typeof item === 'string') ? (errors as string[]) : null;
}

/** The payload bytes of a canonical base64 string (empty allowed), or null. */
function decode(encoded: unknown): Uint8Array | null {
    if (typeof encoded !== 'string') {
        return null;
    }
    const bytes = Buffer.from(encoded, 'base64');
    return bytes.toString('base64') === encoded ? Uint8Array.from(bytes) : null;
}

const writeValue = (json: unknown): OkValue['write'] | null => {
    const data = isObject(json) ? json.data : undefined;
    return isObject(data) && data.version === OBJECT_VERSION ? { version: OBJECT_VERSION } : null;
};

function readValue(json: unknown): OkValue['read'] | null {
    const outer = isObject(json) ? json.data : undefined;
    const inner = isObject(outer) ? outer.data : undefined;
    const meta = isObject(outer) ? outer.metadata : undefined;
    if (!isObject(inner) || !isObject(meta) || meta.version !== OBJECT_VERSION || meta.destroyed === true) {
        return null;
    }
    if (meta.deletion_time !== undefined && meta.deletion_time !== '') {
        return null;
    }
    const payload = decode(inner.payload);
    return payload && typeof inner.name === 'string' && typeof inner.version_id === 'string'
        ? { name: inner.name, versionId: inner.version_id, payload }
        : null;
}

function loginValue(json: unknown): OkValue['login'] | null {
    const auth = isObject(json) ? json.auth : undefined;
    if (!isObject(auth) || typeof auth.client_token !== 'string' || auth.client_token === '') {
        return null;
    }
    const lease = auth.lease_duration;
    return typeof lease === 'number' && Number.isFinite(lease) && lease >= 0
        ? { token: auth.client_token, leaseSeconds: lease }
        : null;
}

const hasMetadata = (json: unknown): boolean => {
    const data = isObject(json) ? json.data : undefined;
    return isObject(data) && 'metadata' in data;
};

const ok = <O extends VaultOp>(value: OkValue[O]): VaultAnswer<OkValue[O]> => ({ kind: 'ok', value });

function success<O extends VaultOp>(op: O, status: number, text: string): VaultAnswer<OkValue[O]> {
    const unrecognized: VaultAnswer<OkValue[O]> = { kind: 'unrecognized' };
    if (op === 'delete') {
        return status === HTTP_NO_CONTENT && text.trim() === '' ? ok<O>(null as OkValue[O]) : unrecognized;
    }
    if (status !== HTTP_OK) {
        return unrecognized;
    }
    const json = parse(text);
    const value = op === 'write' ? writeValue(json) : op === 'read' ? readValue(json) : loginValue(json);
    return value === null ? unrecognized : ok<O>(value as OkValue[O]);
}

const UNRECOGNIZED = { kind: 'unrecognized' } as const;

function refuseBadRequest(op: VaultOp, errors: string[] | null): VaultAnswer<never> {
    if (op === 'write') {
        return errors?.some((error) => CAS_MISMATCH.test(error)) ? { kind: 'exists' } : UNRECOGNIZED;
    }
    // Vault answers a login for an unknown role or a token it rejects with a 400 naming errors.
    return op === 'login' && errors ? { kind: 'denied' } : UNRECOGNIZED;
}

function refuseNotFound(op: VaultOp, json: unknown, errors: string[] | null): VaultAnswer<never> {
    if (errors?.some((error) => NO_ROUTE.test(error))) {
        return { kind: 'unmounted' };
    }
    if (op === 'read' && hasMetadata(json)) {
        return { kind: 'tombstoned' };
    }
    return errors && (op === 'read' || op === 'delete') && !hasMetadata(json) ? { kind: 'absent' } : UNRECOGNIZED;
}

/** A non-success answer under a status Vault documents for the operation; `unrecognized` for the rest. */
function refusal(op: VaultOp, status: number, text: string): VaultAnswer<never> {
    const json = parse(text);
    const errors = errorsOf(json);
    switch (status) {
        case HTTP_FORBIDDEN:
            return errors ? { kind: 'denied' } : UNRECOGNIZED;
        case HTTP_BAD_REQUEST:
            return refuseBadRequest(op, errors);
        case HTTP_NOT_FOUND:
            return refuseNotFound(op, json, errors);
        default:
            return UNRECOGNIZED;
    }
}

export function classifyAnswer<O extends VaultOp>(op: O, status: number, text: string): VaultAnswer<OkValue[O]> {
    if (status === HTTP_TOO_MANY_REQUESTS || (status >= HTTP_SERVER_ERROR && status < HTTP_STATUS_LIMIT)) {
        return { kind: 'retry' };
    }
    if (status === HTTP_OK || status === HTTP_NO_CONTENT) {
        return success(op, status, text);
    }
    return refusal(op, status, text);
}
