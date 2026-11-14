import { CLOUD, type DeploymentMode } from '@factory-ai/core';
import type { Sql, TransactionSql } from 'postgres';
import { LIST_LIMIT, type ObjectStore } from '../artifacts/object-store.js';
import { startIntervalLoop } from '../interval-loop.js';
import { identityKey } from '../secrets/secret-input.js';
import type { OperationId, SecretIdentity, SecretRef, SecretStore, SecretVersion } from '../secrets/secret-store.js';
import { recordAudit } from './audit-log.js';
import { OBJECT_WRITE_DRAIN_MS } from './object-write-fence.js';
import { liftStatementTimeout } from './pool.js';

const MS_PER_SECOND = 1000;

/**
 * Deleting an organization (docs/organizations.md, `143_org_purge.sql`): one `org_purge` row per org, walked in three
 * steps by an interval loop on every replica. Only a suspended or refused org is purged, re-checked under its row lock
 * on every pass; the row is written by the operator's delete (`org-status.ts:requestOrgDelete`) or, in cloud mode
 * only, here once GitHub's deletion deadline (`delete_after`) has passed. A self-hosted board purges only on an
 * operator's request.
 *
 * 1. secrets — every secret whose identity names the org as owner (so a reference no consumer row holds yet, such as
 *    a pending authorization's, is found) plus the org's consumer references: each unresolved operation is
 *    reconciled, each live reference deleted, the collector run, and the step is confirmed only when `secret_version`
 *    holds no version of them — the collector drops a row only after the provider confirmed its payload gone. Then
 *    the tombstone and operation rows go too (the exception to the tombstone rule in docs/secrets.md).
 * 2. objects — once every write that passed the fence has drained (`object-write-fence.ts`: a requested purge refuses
 *    new writes), every key under the org's artifact, attachment and skill prefixes, until a list answers empty.
 * 3. rows — the organization row is deleted; every org table cascades with it (`org-tables.ts`), this row included.
 *
 * A step that cannot be confirmed — a failed or malformed list, a delete the store did not confirm, a collector
 * that left a version — records a closed error code and stays pending for the next pass; nothing is ever marked done.
 * A purge cut off by a lost replica resumes from its last recorded step, and every step is safe to run again. The
 * only record that outlives the org is one structured server log line naming its id (no audit row: the org's own
 * audit rows are purged with it).
 */

export const ORG_PURGE_INTERVAL_MS = 300_000;
/** How long one pass may run before it stops between items; the next pass resumes. */
export const ORG_PURGE_PASS_MS = 120_000;

export const PURGE_STEPS = ['secrets', 'objects', 'rows'] as const;
type PurgeStep = (typeof PURGE_STEPS)[number];

/** Closed: a purge's `last_error` names what was not confirmed, never tenant data. */
export type PurgeError =
    | 'org-active'
    | 'secret-identity-invalid'
    | 'secret-reconcile-failed'
    | 'secret-delete-failed'
    | 'secret-collect-failed'
    | 'secret-versions-remaining'
    | 'secrets-reappeared'
    | 'object-list-failed'
    | 'object-delete-failed'
    | 'pass-timeout'
    | 'writes-draining'
    | 'pass-failed';

export interface OrgPurgeDeps {
    sql: Sql;
    secrets: Pick<SecretStore, 'issueOperationId' | 'delete' | 'reconcileOperation'> & { collect(): Promise<unknown> };
    objects: ObjectStore;
    /** The artifact backend's key prefix (`ArtifactBackend.prefix`). */
    prefix: string;
    deploymentMode: DeploymentMode;
    log?: ((line: string) => void) | undefined;
    passMs?: number | undefined;
    /** Tests only: how long after the request the object step waits for fenced writes (`OBJECT_WRITE_DRAIN_MS`). */
    writeDrainMs?: number | undefined;
}

interface Pass {
    deps: OrgPurgeDeps;
    tx: TransactionSql;
    orgId: string;
    expired: () => boolean;
    signal: AbortSignal | undefined;
}

type StepResult = PurgeError | null;

/** The three namespaces an org's objects live under: artifacts, attachments, skills. Each ends in `/`. */
export const orgObjectPrefixes = (prefix: string, orgId: string): string[] => [
    `${prefix}${orgId}/`,
    `${prefix}_attachments/${orgId}/`,
    `${prefix}_skills/${orgId}/`,
];

/** The org an identity key names as owner: the org itself, or the org a user-owned secret carries (null if none). */
export const ownerOrg = (sql: Sql | TransactionSql) => sql`
    case identity_key::jsonb #>> '{0,0}' when 'organization' then identity_key::jsonb #>> '{0,1}'
                                         else identity_key::jsonb #>> '{0,2}' end`;

/**
 * Every secret the org owns, by identity (live, tombstoned, or only an operation so far), and every reference the
 * org's consumer rows hold whose secret names the org or no org. A secret another org owns is never touched.
 */
async function discover(tx: TransactionSql, orgId: string): Promise<{ ref: string; identity_key: string }[]> {
    const owner = ownerOrg(tx);
    return tx<{ ref: string; identity_key: string }[]>`
        with consumer as (
            select secret_ref as ref from env_var where org_id = ${orgId}
            union select secret_ref from integration_grant where org_id = ${orgId}
            union select lineage_secret_ref from integration_grant where org_id = ${orgId}
            union select secret_ref from integration_authorization where org_id = ${orgId}
            union select secret_ref from notification_subscription where org_id = ${orgId}
            union select entry ->> 'ref' from executor_profile, jsonb_array_elements(secret_refs) as entry
                  where org_id = ${orgId}
        )
        select ref, identity_key from secret where ${owner} = ${orgId}
        union select ref, identity_key from secret_operation where ${owner} = ${orgId}
        union select ref, identity_key from secret
              where ref in (select ref from consumer where ref is not null)
                and (${owner} = ${orgId} or ${owner} is null)
        order by ref
    `;
}

/** The identity an identity key encodes, or null when the key is not one `identityKey` would produce. */
function identityOf(key: string): SecretIdentity | null {
    try {
        const [owner, scopeType, scopeId, purpose, recordType, recordId] = JSON.parse(key) as [
            [string, string, string | null],
            ...string[],
        ];
        const identity = {
            owner:
                owner[0] === 'organization'
                    ? { kind: 'organization', orgId: owner[1] }
                    : { kind: 'user', userId: owner[1], orgId: owner[2] },
            scope: { type: scopeType, id: scopeId },
            purpose,
            owningRecord: { type: recordType, id: recordId },
        } as SecretIdentity;
        return identityKey(identity) === key ? identity : null;
    } catch {
        return null;
    }
}

/** What retiring secrets takes: the transaction, the store, and the pass's clock and signal. */
export interface SecretRetirement {
    tx: TransactionSql;
    secrets: OrgPurgeDeps['secrets'];
    expired: () => boolean;
    signal: AbortSignal | undefined;
}

/** Resolves the reference's unresolved operations and deletes its live version, each confirmed by the store. */
async function retireSecret(pass: SecretRetirement, ref: SecretRef, identity: SecretIdentity): Promise<StepResult> {
    const { tx, secrets } = pass;
    const open = await tx<{ operation_id: string }[]>`
        select operation_id from secret_operation where ref = ${ref} and state in ('pending', 'unknown')
    `;
    for (const { operation_id } of open) {
        const call = { identity, ref, operationId: operation_id as OperationId, signal: pass.signal };
        const settled = await secrets.reconcileOperation(call).catch(() => null);
        if (!settled?.ok || settled.status.state === 'pending' || settled.status.state === 'unknown') {
            return 'secret-reconcile-failed';
        }
    }
    const [live] = await tx<{ logical_version: string }[]>`
        select a.logical_version from secret_active a join secret s on s.ref = a.ref
        where a.ref = ${ref} and s.state = 'active'
    `;
    if (!live) return null;
    const deleted = await secrets
        .issueOperationId()
        .then((operationId) =>
            secrets.delete({
                identity,
                ref,
                operationId,
                expectedVersion: live.logical_version as SecretVersion,
                signal: pass.signal,
            })
        )
        .catch(() => null);
    return deleted?.ok ? null : 'secret-delete-failed';
}

async function purgeSecrets(pass: Pass): Promise<StepResult> {
    const { tx, deps, expired, signal } = pass;
    return retireSecrets({ tx, secrets: deps.secrets, expired, signal }, await discover(tx, pass.orgId));
}

/**
 * Retires each secret, runs the collector, and confirms none is left: no version, live reference or open operation.
 * Only then are the tombstone and operation rows deleted. Null when confirmed; otherwise the closed code of the step.
 */
export async function retireSecrets(
    pass: SecretRetirement,
    owned: readonly { ref: string; identity_key: string }[]
): Promise<PurgeError | null> {
    const { tx, secrets } = pass;
    for (const { ref, identity_key } of owned) {
        if (pass.expired()) return 'pass-timeout';
        const identity = identityOf(identity_key);
        if (!identity) return 'secret-identity-invalid';
        const failed = await retireSecret(pass, ref as SecretRef, identity);
        if (failed) return failed;
    }
    if (owned.length === 0) return null;
    const collected = await secrets.collect().then(
        () => true,
        () => false
    );
    if (!collected) return 'secret-collect-failed';
    const refs = owned.map((row) => row.ref);
    // Re-read after the collector: only a version row that is gone was confirmed gone at its provider.
    const [left] = await tx<{ n: number }[]>`
        select (select count(*)::int from secret_version where ref = any(${refs}))
             + (select count(*)::int from secret where ref = any(${refs}) and state = 'active')
             + (select count(*)::int from secret_operation where ref = any(${refs}) and state in ('pending', 'unknown'))
               as n
    `;
    if ((left?.n ?? 1) > 0) return 'secret-versions-remaining';
    await tx`delete from secret_operation where ref = any(${refs})`;
    await tx`delete from secret where ref = any(${refs})`;
    return null;
}

/** Deletes one page of a namespace's keys; `'empty'` only when the list confirmed none is left. */
export async function deleteObjectPage(
    objects: ObjectStore,
    namespace: string,
    signal: AbortSignal | undefined
): Promise<PurgeError | null | 'empty'> {
    const keys = await objects.list(namespace, { limit: LIST_LIMIT, signal }).catch(() => null);
    // An answer that is not a list of this namespace's keys confirms nothing and licenses no delete.
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !key.startsWith(namespace))) {
        return 'object-list-failed';
    }
    if (keys.length === 0) return 'empty';
    for (const key of keys) {
        const deleted = await objects.delete(key).then(
            () => true,
            () => false
        );
        if (!deleted) return 'object-delete-failed';
    }
    return null;
}

async function purgeObjects(pass: Pass): Promise<StepResult> {
    // A write that passed the fence before the request has landed or been abandoned only after the drain.
    const drainMs = pass.deps.writeDrainMs ?? OBJECT_WRITE_DRAIN_MS;
    const [drained] = await pass.tx<{ done: boolean }[]>`
        select now() >= requested_at + make_interval(secs => ${drainMs / MS_PER_SECOND}) as done
        from org_purge where org_id = ${pass.orgId}
    `;
    if (drained?.done !== true) return 'writes-draining';
    for (const namespace of orgObjectPrefixes(pass.deps.prefix, pass.orgId)) {
        const next = () => deleteObjectPage(pass.deps.objects, namespace, pass.signal);
        for (let page: StepResult | 'empty' = null; page !== 'empty'; page = await next()) {
            if (page) return page;
            if (pass.expired()) return 'pass-timeout';
        }
    }
    return null;
}

/** The last step: no secret of the org may have appeared since, and the org is still not active, under its lock. */
async function purgeRows(pass: Pass): Promise<StepResult | 'reappeared'> {
    const { tx, orgId } = pass;
    if ((await discover(tx, orgId)).length > 0) return 'reappeared';
    const [org] = await tx<{ status: string }[]>`select status from organization where id = ${orgId} for update`;
    if (org?.status !== 'suspended' && org?.status !== 'refused') return 'org-active';
    // The cascade removes every row the org holds, telemetry included: as long as its data, never cut short.
    await liftStatementTimeout(tx);
    await tx`delete from organization where id = ${orgId}`;
    return null;
}

const RUNNERS: Readonly<Record<Exclude<PurgeStep, 'rows'>, (pass: Pass) => Promise<StepResult>>> = {
    secrets: purgeSecrets,
    objects: purgeObjects,
};

interface Claimed {
    step: PurgeStep;
    source: string;
    requested_at: Date;
}

type Outcome = { purged: true; row: Claimed } | { purged: false; error: PurgeError } | null;

/** Walks one org's purge from its recorded step, under its row lock; null when another replica holds it. */
async function purgeOne(deps: OrgPurgeDeps, orgId: string, expired: () => boolean, signal?: AbortSignal) {
    return deps.sql.begin(async (tx): Promise<Outcome> => {
        const [row] = await tx<Claimed[]>`
            select step, source, requested_at from org_purge where org_id = ${orgId} for update skip locked
        `;
        if (!row) return null;
        const pass: Pass = { deps, tx, orgId, expired, signal };
        const fail = async (step: PurgeStep, error: PurgeError): Promise<Outcome> => {
            await tx`
                update org_purge set step = ${step}, attempts = attempts + 1, last_error = ${error}, updated_at = now()
                where org_id = ${orgId}
            `;
            return { purged: false, error };
        };
        const [org] = await tx<{ status: string }[]>`select status from organization where id = ${orgId} for share`;
        if (org?.status !== 'suspended' && org?.status !== 'refused') return fail(row.step, 'org-active');
        let step = row.step;
        while (step !== 'rows') {
            const failed = await RUNNERS[step](pass);
            if (failed) return fail(step, failed);
            step = PURGE_STEPS[PURGE_STEPS.indexOf(step) + 1] as PurgeStep;
        }
        const last = await purgeRows(pass);
        if (last === 'reappeared') return fail('secrets', 'secrets-reappeared');
        if (last) return fail('rows', last);
        return { purged: true, row };
    });
}

/** In cloud mode, queues every org GitHub's hold has kept past its deletion deadline, with one `system` audit row. */
async function queueExpired(sql: Sql): Promise<void> {
    await sql.begin(async (tx) => {
        const due = await tx<{ org_id: string }[]>`
            insert into org_purge (org_id, source)
            select id, 'deadline' from organization
            where status in ('suspended', 'refused') and delete_after is not null and delete_after <= now()
            on conflict (org_id) do nothing
            returning org_id
        `;
        for (const { org_id } of due) {
            await recordAudit(tx, {
                orgId: org_id,
                actor: { kind: 'system', id: null },
                action: 'org.delete',
                target: org_id,
                detail: { source: 'deadline' },
            });
        }
    });
}

/** One pass over every queued purge; never throws for one org's failure, which is recorded on its row. */
export async function runOrgPurgePass(deps: OrgPurgeDeps, signal?: AbortSignal): Promise<void> {
    const log = deps.log ?? ((line: string) => console.log(line));
    const until = Date.now() + (deps.passMs ?? ORG_PURGE_PASS_MS);
    const expired = () => signal?.aborted === true || Date.now() > until;
    if (deps.deploymentMode === CLOUD) await queueExpired(deps.sql);
    const queued = await deps.sql<{ org_id: string }[]>`select org_id from org_purge order by requested_at, org_id`;
    for (const { org_id: orgId } of queued) {
        if (expired()) return;
        let outcome: Outcome;
        try {
            outcome = await purgeOne(deps, orgId, expired, signal);
        } catch (e) {
            log(`[org-purge] ${orgId} pass failed: ${(e as Error).message}`);
            await recordPassFailure(deps.sql, orgId);
            continue;
        }
        if (outcome?.purged) {
            const { source, requested_at: requested } = outcome.row;
            const record = { event: 'org.purged', orgId, source, requestedAt: requested.toISOString() };
            log(`[org-purge] ${JSON.stringify({ ...record, purgedAt: new Date().toISOString() })}`);
        } else if (outcome) {
            log(`[org-purge] ${orgId} pending: ${outcome.error}`);
        }
    }
}

/** A pass that threw (its transaction rolled back): counted on the row when the database still answers. */
async function recordPassFailure(sql: Sql, orgId: string): Promise<void> {
    try {
        await sql`
            update org_purge set attempts = attempts + 1, last_error = 'pass-failed', updated_at = now()
            where org_id = ${orgId}
        `;
    } catch {
        // The next pass retries the purge either way; only the counter is lost.
    }
}

/** The purge loop: a pass now and then every `ORG_PURGE_INTERVAL_MS`; safe on every replica. Returns the stop. */
export function startOrgPurge(deps: OrgPurgeDeps, intervalMs = ORG_PURGE_INTERVAL_MS): () => Promise<void> {
    return startIntervalLoop('org-purge', (signal) => runOrgPurgePass(deps, signal), intervalMs);
}
