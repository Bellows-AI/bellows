import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { applyResolutionInTx, resolveBindingsInTx } from '../src/db/connection-bindings.js';
import type { ConnectionGrants, IntegrationGrant } from '../src/db/connection-grants.js';
import { grantSecretIdentity } from '../src/db/connection-grants.js';
import { encodeGrantPayload, type GrantPayload } from '../src/integrations/grant-credentials.js';
import type { LineageEvent } from '../src/integrations/grant-lineage.js';
import type { SecretRepo } from '../src/secrets/postgres-secret-repo.js';
import { createSecretRef } from '../src/secrets/secret-input.js';
import type { SecretStore, SecretVersion } from '../src/secrets/secret-store.js';
import { createPostgresHarness, dbError, type PostgresHarness } from './secrets-postgres-harness.js';

/**
 * TEST-ONLY: faults for the grant lineage, injected INSIDE the real PostgreSQL secret store. The wrappers
 * sit on the store's repo seam, so every operation still writes its record: an outcome-unknown here is the
 * store's own answer, never a mock that skipped the operation.
 */
type Method<K extends keyof SecretRepo> = SecretRepo[K];
type Wrap<K extends keyof SecretRepo> = (
    run: () => ReturnType<Method<K>>,
    call: number,
    args: Parameters<Method<K>>
) => ReturnType<Method<K>>;

export interface RepoWrappers {
    stageVersion?: Wrap<'stageVersion'>;
    activate?: Wrap<'activate'>;
    findOperation?: Wrap<'findOperation'>;
}

/** The error shape the store classifies as `outcome-unknown` (docs/secrets.md; secrets-postgres.faults.test.ts). */
export const ambiguousWrite = (): Error => dbError('CONNECTION_CLOSED');

export interface FaultyStore {
    harness: PostgresHarness;
    store: SecretStore;
    /** Counts per wrapped repo method, by call. */
    calls: { stageVersion: number; activate: number; findOperation: number };
}

/** A real store over the harness's database whose repo methods are wrapped; `h.openWith(h.realRepo)` is a fresh process. */
export function faultyStore(harness: PostgresHarness, wrappers: RepoWrappers = {}): FaultyStore {
    const real = harness.realRepo;
    const calls = { stageVersion: 0, activate: 0, findOperation: 0 };
    const repo: SecretRepo = {
        ...real,
        stageVersion: (...args) => {
            calls.stageVersion += 1;
            const run = () => real.stageVersion(...args);
            return wrappers.stageVersion ? wrappers.stageVersion(run, calls.stageVersion, args) : run();
        },
        activate: (...args) => {
            calls.activate += 1;
            const run = () => real.activate(...args);
            return wrappers.activate ? wrappers.activate(run, calls.activate, args) : run();
        },
        findOperation: (...args) => {
            calls.findOperation += 1;
            const run = () => real.findOperation(...args);
            return wrappers.findOperation ? wrappers.findOperation(run, calls.findOperation, args) : run();
        },
    };
    return { harness, store: harness.openWith(repo), calls };
}

/** The harness over a pool; `deadlineMs` is the store's own per-call deadline. */
export const lineageHarness = (sql: Sql): PostgresHarness => createPostgresHarness(sql, { deadlineMs: 3000 });

/** Throws the ambiguous error before the real call: the staged version never lands. */
export const throwBefore =
    (times = Infinity): Wrap<'stageVersion'> =>
    async (run, call) => {
        if (call <= times) throw ambiguousWrite();
        return run();
    };

/** Runs the real activate, then loses its response: applied, answer lost. */
export const throwAfterActivate: Wrap<'activate'> = async (run, _call, [, origin]) => {
    const result = await run();
    if (origin === 'request') throw ambiguousWrite();
    return result;
};

/** Seeds a grant's secret as the first lineage version, the way the authorization flow will (slice 3). */
export async function seedGrantSecret(
    sql: Sql,
    secrets: SecretStore,
    grant: Pick<IntegrationGrant, 'id' | 'orgId' | 'principalUserId'>,
    payload: GrantPayload
): Promise<{ ref: string; version: SecretVersion }> {
    const ref = createSecretRef();
    const created = await secrets.create({
        identity: grantSecretIdentity(grant),
        ref,
        operationId: await secrets.issueOperationId(),
        payload: encodeGrantPayload(payload),
    });
    if (!created.ok) throw new Error(`seed refused: ${created.error.code}/${created.error.reason}`);
    await sql`
        update integration_grant set secret_ref = ${ref}, secret_version = ${created.version}, authority = ${sql.json(payload.authority as never)}
        where id = ${grant.id}
    `;
    return { ref, version: created.version };
}

/** An attach that must succeed. */
export async function attachJira(
    grants: ConnectionGrants,
    userId: string,
    account: { externalAccountId: string; cloudId: string; scopes?: string[] }
) {
    const { externalAccountId, cloudId, scopes = ['fake:read'] } = account;
    const result = await grants.attachGrantConnection({
        principal: { kind: 'user', userId },
        provider: 'jira',
        externalAccountId,
        authority: { scopes },
        connection: { site: 'example.atlassian.net', cloudId, access: 'read' },
    });
    if (!result.ok) throw new Error(`attach refused: ${result.reason}`);
    return result;
}

/** A root thread row authored by `userId`. */
export async function newRoot(sql: Sql, orgId: string, userId: string): Promise<string> {
    const id = randomUUID();
    await sql`insert into job (org_id, id, command, root_job_id, created_by) values (${orgId}, ${id}, 'work', ${id}, ${userId})`;
    return id;
}

/** Binds connections to a root through the real resolution, so the binding freezes the grant authority of now. */
export async function bindConnections(
    sql: Sql,
    root: { orgId: string; rootJobId: string; userId: string },
    connectionIds: string[]
): Promise<void> {
    const { orgId, rootJobId, userId } = root;
    await sql.begin(async (tx) => {
        const resolution = await resolveBindingsInTx(tx, {
            orgId,
            executionUser: userId,
            explicit: connectionIds,
            providers: ['jira'],
        });
        if (!resolution.ok) throw new Error(`bind refused: ${resolution.reason}`);
        await applyResolutionInTx(tx, { orgId, rootJobId, addedBy: userId, resolution });
    });
}

/** Counts what reaches the store and records every operation ID it issued; behaviour is the store's own. */
export function spied(store: SecretStore) {
    const log = { operationIds: [] as string[], reads: 0, creates: 0, replaces: 0, deletes: 0 };
    const wrapped: SecretStore = {
        issueOperationId: async () => {
            const id = await store.issueOperationId();
            log.operationIds.push(id);
            return id;
        },
        create: (input) => {
            log.creates += 1;
            return store.create(input);
        },
        readActive: (input) => {
            log.reads += 1;
            return store.readActive(input);
        },
        replace: (input) => {
            log.replaces += 1;
            return store.replace(input);
        },
        delete: (input) => {
            log.deletes += 1;
            return store.delete(input);
        },
        reconcileOperation: (input) => store.reconcileOperation(input),
    };
    return { store: wrapped, log };
}

/** Collects the lineage's closed diagnostics and lets a test wait for one without polling. */
export function lineageEvents() {
    const events: LineageEvent[] = [];
    const waiting: { name: string; resolve: () => void }[] = [];
    return {
        events,
        log: (event: LineageEvent) => {
            events.push(event);
            for (const w of waiting.filter((x) => x.name === event.event)) w.resolve();
        },
        occurred: (name: string): Promise<void> =>
            events.some((e) => e.event === name)
                ? Promise.resolve()
                : new Promise<void>((resolve) => waiting.push({ name, resolve })),
    };
}

/** A deferred: `entered` resolves when the held code arrives, `release` lets it go on. */
export function parked() {
    let release!: () => void;
    let enter!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    return {
        entered,
        release,
        hold: async () => {
            enter();
            await gate;
        },
    };
}
