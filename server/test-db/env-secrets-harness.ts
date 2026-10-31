import type { Sql } from 'postgres';
import { encodeEnvSecret, envSecretIdentity, type EnvSecretScope } from '../src/db/env-secrets.js';
import { createPostgresSecretStore } from '../src/secrets/postgres-secret-store.js';
import { createSecretRef } from '../src/secrets/secret-input.js';
import type { SecretDiagnostic, SecretStore } from '../src/secrets/secret-store.js';
import { MutableKeys } from './secrets-postgres-harness.js';

/** The real PostgreSQL secret store over the test database, with a short deadline so a hang fails fast. */
export function testSecretStore(sql: Sql, keys: MutableKeys = new MutableKeys()) {
    return createPostgresSecretStore({ sql, keys, deadlineMs: 3000 });
}

/** The store with some calls replaced, to script a fault on exactly one of them. */
export function faultySecrets(store: SecretStore, overrides: Partial<SecretStore>): SecretStore {
    return {
        issueOperationId: (...args) => store.issueOperationId(...args),
        create: (...args) => store.create(...args),
        readActive: (...args) => store.readActive(...args),
        replace: (...args) => store.replace(...args),
        delete: (...args) => store.delete(...args),
        reconcileOperation: (...args) => store.reconcileOperation(...args),
        ...overrides,
    };
}

export interface EnvSlot {
    orgId: string;
    scope: EnvSecretScope;
    name: string;
}

/** `identityOf` creates the record under another slot's identity: a reference copied to a row it does not belong to. */
export type SeedSlot = EnvSlot & { identityOf?: EnvSlot };

/** Writes an encrypted env row the way the writer will: a store record, then a row holding only its reference and version. */
export async function seedEncryptedRow(
    sql: Sql,
    store: SecretStore,
    slot: SeedSlot,
    value: string | Uint8Array
): Promise<{ ref: string; version: string }> {
    const ref = createSecretRef();
    const identityOf = slot.identityOf ?? slot;
    const created = await store.create({
        identity: envSecretIdentity(identityOf.orgId, identityOf.scope, identityOf.name),
        ref,
        operationId: await store.issueOperationId(),
        payload: typeof value === 'string' ? encodeEnvSecret(value) : value,
    });
    if (!created.ok) throw new Error(`create refused: ${created.error.code}/${created.error.reason}`);
    const { scope } = slot;
    await sql`
        insert into env_var (org_id, user_id, repo_owner, repo_name, name, value, is_secret, secret_ref, secret_version)
        values (
            ${slot.orgId},
            ${scope.kind === 'workspace' ? scope.userId : null},
            ${scope.kind === 'repo' ? scope.owner : null},
            ${scope.kind === 'repo' ? scope.name : null},
            ${slot.name}, null, true, ${ref}, ${created.version}
        )
    `;
    return { ref, version: created.version };
}

export interface SecretCalls {
    creates: { ref: string; name: string }[];
    deletes: { ref: string; name: string }[];
    reconciles: { ref: string; name: string }[];
    replaces: number;
}

/** The store, recording every create, delete and reconcile by reference and variable name. */
export function spySecrets(
    store: SecretStore,
    overrides: Partial<SecretStore> = {}
): { store: SecretStore; calls: SecretCalls } {
    const calls: SecretCalls = { creates: [], deletes: [], reconciles: [], replaces: 0 };
    const at = (input: { ref: string; identity: { owningRecord: { id: string } } }) => ({
        ref: input.ref,
        name: input.identity.owningRecord.id,
    });
    const spied = faultySecrets(store, {
        create: (input) => {
            calls.creates.push(at(input));
            return store.create(input);
        },
        delete: (input) => {
            calls.deletes.push(at(input));
            return store.delete(input);
        },
        reconcileOperation: (input) => {
            calls.reconciles.push(at(input));
            return store.reconcileOperation(input);
        },
        replace: (input) => {
            calls.replaces += 1;
            return store.replace(input);
        },
        ...overrides,
    });
    return { store: spied, calls };
}

/**
 * The pool with the tagged queries whose joined text contains `match` rejecting (or never answering, in `hang` mode). `begin` and fragments pass
 * through: the transaction and the scope predicates are the real ones.
 */
export function failingPoolQuery(sql: Sql, match: string, mode: 'reject' | 'hang' = 'reject'): Sql {
    return new Proxy(sql, {
        apply(target, thisArg, args: unknown[]) {
            const strings = args[0];
            if (Array.isArray(strings) && strings.join('?').includes(match)) {
                return mode === 'hang'
                    ? new Promise(() => {})
                    : Promise.reject(new Error('simulated pool query failure'));
            }
            return Reflect.apply(target, thisArg, args);
        },
        get(target, prop) {
            const member = Reflect.get(target, prop);
            return typeof member === 'function' ? member.bind(target) : member;
        },
    });
}

/** A diagnostic sink that keeps what it was given. */
export function captureDiagnostics() {
    const events: SecretDiagnostic[] = [];
    return { events, log: (d: SecretDiagnostic) => void events.push(d) };
}
