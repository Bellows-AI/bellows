import { randomUUID } from 'node:crypto';
import { gitlabForgeOf } from '@factory-ai/core';
import type { Sql } from 'postgres';
import type { GitlabApi, ProbeReason, ProbeResult } from '../gitlab/gitlab-api.js';
import type { SecretDiagnostic, SecretIdentity, SecretRef, SecretStore } from '../secrets/secret-store.js';
import { createSecretRef } from '../secrets/secret-input.js';
import { createEnvSecrets, decodeEnvSecret, EnvSecretError } from './env-secrets.js';
import { type OrgPurgeDeps, retireSecrets } from './org-purge.js';

/**
 * An organization's connection to a self-hosted GitLab (docs/connections.md): the host, its OAuth application's client
 * id and the root groups members' projects may come from in the row; the application's secret and an optional CA bundle
 * in the secret store, the row keeping each reference and the version it was written at. A connection is stored
 * pending (`active` false) with the outcome of an unauthenticated reachability probe; an unreachable instance is
 * recorded with its reason, never refused and never deleted.
 */

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === UNIQUE_VIOLATION;
const FORGE = 'gitlab';

export type ConnectionSecretPart = 'client-secret' | 'ca-bundle';

/**
 * Owned by the organization and bound to the connection and the part, rebuilt on every call and never stored, so a
 * reference copied to another connection, organization or part reads as `identity-mismatch`.
 */
export function gitlabConnectionIdentity(
    orgId: string,
    connectionId: string,
    part: ConnectionSecretPart
): SecretIdentity {
    return {
        owner: { kind: 'organization', orgId },
        scope: { type: 'organization', id: orgId },
        purpose: 'forge-connection',
        owningRecord: { type: 'gitlab-connection', id: `${connectionId}/${part}` },
    };
}

export interface ConnectionInput {
    host: string;
    clientId: string;
    clientSecret: string;
    allowedGroups: string[];
    caBundle?: string | undefined;
}

/** Never `secret_ref`, `ca_secret_ref` or a version: a view shows no secret, not even its reference. */
export interface ConnectionView {
    id: string;
    forge: typeof FORGE;
    host: string;
    clientId: string;
    allowedGroups: string[];
    hasCaBundle: boolean;
    active: boolean;
    /** The instance version activation confirmed; null while pending. */
    version: string | null;
    /** Why the last authenticated check refused the instance: a version below the minimum. Null otherwise. */
    activationRefusal: ActivationRefusal | null;
    probe: { status: 'reachable' | 'unreachable'; reason: ProbeReason | null; at: string };
    createdAt: string;
}

export type ActivationRefusal = 'version-too-old';

/** What the OAuth hooks call GitLab as: the application the admin registered, read back from the secret store. */
export interface GitlabApplication {
    connectionId: string;
    host: string;
    clientId: string;
    clientSecret: string;
    caBundle: string | undefined;
    active: boolean;
}

export type CreateConnectionResult = { ok: true; connection: ConnectionView } | { ok: false; reason: 'exists' };

export interface ForgeConnectionStore {
    list(): Promise<ConnectionView[]>;
    /** Null when this organization has no such connection. */
    get(id: string): Promise<ConnectionView | null>;
    /**
     * Probes the instance, writes the secrets, then the row. A secret-store failure throws `EnvSecretError` with
     * nothing written; a second connection to the host is `exists`.
     */
    create(input: ConnectionInput): Promise<CreateConnectionResult>;
    /** False when this organization has no such connection. Both secrets are retired with the row. */
    remove(id: string): Promise<boolean>;
    /**
     * The live connection's OAuth application by host, secrets read back; null for a confirmed absence. A failed or
     * unconfirmed read throws: it is never "no connection".
     */
    application(host: string): Promise<GitlabApplication | null>;
    /**
     * Whether the connection a link started from is still this live row (not removed, not replaced by a re-create of
     * the host), and, for a member's link, active. A failed read throws: it is never "gone".
     */
    holds(id: string, options: { active: boolean }): Promise<boolean>;
    /** Revokes the member's grant on the host (their lineage and its secret are retired by the recovery pass). */
    revokeMemberGrant(host: string, userId: string): Promise<void>;
    /** The authenticated check confirmed the instance: the connection is active at `version`. False when gone. */
    activate(id: string, version: string): Promise<boolean>;
    /** The authenticated check refused the instance; the connection stays pending, with the reason. */
    refuseActivation(id: string, reason: ActivationRefusal): Promise<boolean>;
}

interface Row {
    id: string;
    forge: typeof FORGE;
    host: string;
    client_id: string;
    allowed_groups: string[];
    ca_secret_ref: string | null;
    active: boolean;
    version: string | null;
    activation_refusal: ActivationRefusal | null;
    probe_status: 'reachable' | 'unreachable';
    probe_reason: ProbeReason | null;
    probed_at: Date;
    created_at: Date;
}

const toView = (row: Row): ConnectionView => ({
    id: row.id,
    forge: row.forge,
    host: row.host,
    clientId: row.client_id,
    allowedGroups: row.allowed_groups,
    hasCaBundle: row.ca_secret_ref !== null,
    active: row.active,
    version: row.version,
    activationRefusal: row.activation_refusal,
    probe: { status: row.probe_status, reason: row.probe_reason, at: row.probed_at.toISOString() },
    createdAt: row.created_at.toISOString(),
});

/** The reason a probe failed, null for a reachable instance. */
const reasonOf = (probe: ProbeResult): ProbeReason | null => (probe.reachable ? null : probe.reason);

const COLUMNS = (sql: Sql) =>
    sql`id, forge, host, client_id, allowed_groups, ca_secret_ref, active, version, activation_refusal, probe_status, probe_reason, probed_at, created_at`;

export function createForgeConnectionStore({
    sql,
    orgId,
    ready,
    secrets,
    secretLog,
    gitlab,
    writeDeadlineMs = 30_000,
    cleanupDeadlineMs = 10_000,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
    /** With the collector `retireSecrets` confirms a delete by; a store without one never confirms a retirement. */
    secrets: SecretStore & { collect?: () => Promise<unknown> };
    /** The secret store's diagnostic sink: a compensation that could not finish is reported here. */
    secretLog: (diagnostic: SecretDiagnostic) => void;
    gitlab: GitlabApi;
    writeDeadlineMs?: number;
    cleanupDeadlineMs?: number;
}): ForgeConnectionStore {
    const gate = async () => {
        if (ready) await ready;
    };
    const cleanup = () => ({ signal: AbortSignal.timeout(cleanupDeadlineMs), diagnose: secretLog });

    /** Writes the secrets under the references the row already records; a failure is an outage (503). */
    const mint = async (id: string, input: ConnectionInput, refs: { secret: SecretRef; ca: SecretRef | null }) => {
        const items = [
            { name: 'client-secret', value: input.clientSecret, ref: refs.secret },
            ...(input.caBundle === undefined || !refs.ca
                ? []
                : [{ name: 'ca-bundle', value: input.caBundle, ref: refs.ca }]),
        ].map((item) => ({
            ...item,
            identity: gitlabConnectionIdentity(orgId, id, item.name as ConnectionSecretPart),
        }));
        const { created, failure } = await createEnvSecrets(secrets, items, {
            signal: AbortSignal.timeout(writeDeadlineMs),
        });
        // A secret-store failure is an outage the route answers 503 (server/src/routes/error-handler.ts).
        if (failure) throw new EnvSecretError(id, failure.code, failure.reason);
        const of = (part: ConnectionSecretPart) => created.find((made) => made.name === part);
        return { secret: of('client-secret')?.version as string, ca: of('ca-bundle')?.version ?? null };
    };

    /** Best effort, right after a failed create: whatever it cannot confirm stays a tombstone for the sweep. */
    const settle = async (id: string) => {
        try {
            const [row] = await sql<RetiringRow[]>`
                select org_id, id, secret_ref, ca_secret_ref from forge_connection
                where org_id = ${orgId} and id = ${id} and removed_at is not null
            `;
            if (row) await finishRemoval(sql, secrets, row, cleanup());
        } catch {
            secretLog({ event: 'cleanup-failed', kind: 'delete', ref: id as SecretRef });
        }
    };

    /**
     * The cleanup owed is recorded first: the row exists as a tombstone, naming both references, before any secret is
     * written, and is published only once both exist. False when the host is already connected.
     */
    const recordIntent = async ({
        id,
        host,
        input,
        refs,
        probe,
    }: {
        id: string;
        host: string;
        input: ConnectionInput;
        refs: { secret: SecretRef; ca: SecretRef | null };
        probe: ProbeResult;
    }): Promise<boolean> => {
        try {
            await sql`
                insert into forge_connection
                    (org_id, id, forge, host, client_id, allowed_groups, secret_ref, ca_secret_ref,
                     probe_status, probe_reason, removed_at)
                values (${orgId}, ${id}, ${FORGE}, ${host}, ${input.clientId}, ${input.allowedGroups}::text[],
                        ${refs.secret}, ${refs.ca}, ${probe.reachable ? 'reachable' : 'unreachable'},
                        ${reasonOf(probe)}, now())
            `;
            return true;
        } catch (error) {
            if (isUniqueViolation(error)) return false;
            throw error;
        }
    };

    /** Writes the secrets, then sets their versions and clears the tombstone in one statement. */
    const publish = async (
        id: string,
        input: ConnectionInput,
        refs: { secret: SecretRef; ca: SecretRef | null }
    ): Promise<ConnectionView> => {
        const versions = await mint(id, input, refs);
        const [row] = await sql<Row[]>`
            update forge_connection
            set secret_version = ${versions.secret}, ca_secret_version = ${versions.ca}, removed_at = null
            where org_id = ${orgId} and id = ${id} and removed_at is not null and secret_version is null
            returning ${COLUMNS(sql)}
        `;
        if (!row) throw new EnvSecretError(id, 'conflict', 'stale-version');
        return toView(row);
    };

    return {
        async list() {
            await gate();
            const rows = await sql<Row[]>`
                select ${COLUMNS(sql)} from forge_connection
                where org_id = ${orgId} and removed_at is null order by created_at, id
            `;
            return rows.map(toView);
        },
        async get(id) {
            await gate();
            const [row] = await sql<Row[]>`
                select ${COLUMNS(sql)} from forge_connection
                where org_id = ${orgId} and id = ${id} and removed_at is null
            `;
            return row ? toView(row) : null;
        },
        async create(input) {
            await gate();
            const host = input.host.toLowerCase();
            const taken = await sql`
                select 1 from forge_connection
                where org_id = ${orgId} and forge = ${FORGE} and host = ${host} and removed_at is null
            `;
            if (taken.length > 0) return { ok: false, reason: 'exists' };
            // A probe that throws is an unreachable instance: the connection is still stored, pending, with the reason.
            const probe = await Promise.resolve()
                .then(() => gitlab.probe({ host, caBundle: input.caBundle }))
                .catch((): ProbeResult => ({ reachable: false, reason: 'unreachable' }));
            const id = randomUUID();
            const refs = { secret: createSecretRef(), ca: input.caBundle === undefined ? null : createSecretRef() };
            if (!(await recordIntent({ id, host, input, refs, probe }))) return { ok: false, reason: 'exists' };
            try {
                return { ok: true, connection: await publish(id, input, refs) };
            } catch (error) {
                await settle(id);
                if (isUniqueViolation(error)) return { ok: false, reason: 'exists' };
                throw error;
            }
        },
        async application(host) {
            await gate();
            return readApplication({ sql, orgId, secrets, host, deadlineMs: writeDeadlineMs });
        },
        async holds(id, { active }) {
            await gate();
            const rows = await sql`
                select 1 from forge_connection
                where org_id = ${orgId} and id = ${id} and removed_at is null and (active or not ${active}::boolean)
            `;
            return rows.length > 0;
        },
        async revokeMemberGrant(host, userId) {
            await gate();
            await revokeGrants(sql, orgId, { host, userId });
        },
        async activate(id, version) {
            await gate();
            return markActivated(sql, orgId, id, version);
        },
        async refuseActivation(id, reason) {
            await gate();
            return markRefused(sql, orgId, id, reason);
        },
        async remove(id) {
            await gate();
            // The tombstone is the durable record of the cleanup owed; a repeated delete of a tombstoned row retries it.
            const rows = await sql<(RetiringRow & { host: string })[]>`
                update forge_connection set removed_at = coalesce(removed_at, now())
                where org_id = ${orgId} and id = ${id}
                returning org_id, id, host, secret_ref, ca_secret_ref
            `;
            if (!rows[0]) return false;
            // After the tombstone is durable: a link that stores its grant later finds the connection gone and revokes
            // it itself (`holds`), so no grant made through a removed connection stays live.
            await revokeGrants(sql, orgId, { host: rows[0].host });
            if (!(await finishRemoval(sql, secrets, rows[0], cleanup()))) {
                throw new EnvSecretError(id, 'unavailable', 'provider-unavailable');
            }
            return true;
        },
    };
}

/** Revokes the grants on `gitlab:<host>` in the org, one member's or all; recovery destroys their secrets. */
async function revokeGrants(sql: Sql, orgId: string, { host, userId }: { host: string; userId?: string }) {
    const forge = gitlabForgeOf(host);
    await sql`
        update integration_grant set status = 'revoked', updated_at = now()
        where org_id = ${orgId} and provider = ${forge} and status <> 'revoked'
          and (${userId ?? null}::uuid is null or principal_user_id = ${userId ?? null}::uuid)
    `;
}

/** The live connection's application by host with its secrets read back; null for a confirmed absence. */
async function readApplication({
    sql,
    orgId,
    secrets,
    host,
    deadlineMs,
}: {
    sql: Sql;
    orgId: string;
    secrets: SecretStore;
    host: string;
    deadlineMs: number;
}): Promise<GitlabApplication | null> {
    const [row] = await sql<(Row & { secret_ref: string; secret_version: string; ca_secret_version: string | null })[]>`
        select ${COLUMNS(sql)}, secret_ref, secret_version, ca_secret_version from forge_connection
        where org_id = ${orgId} and forge = ${FORGE} and host = ${host.toLowerCase()} and removed_at is null
    `;
    if (!row) return null;
    const read = async (part: ConnectionSecretPart, ref: string, version: string) => {
        const stored = await secrets.readActive({
            identity: gitlabConnectionIdentity(orgId, row.id, part),
            ref: ref as SecretRef,
            signal: AbortSignal.timeout(deadlineMs),
        });
        if (!stored.ok) throw new EnvSecretError(row.id, stored.error.code, stored.error.reason);
        if (stored.version !== version) throw new EnvSecretError(row.id, 'version-mismatch', 'version-mismatch');
        return decodeEnvSecret(stored.value);
    };
    const clientSecret = await read('client-secret', row.secret_ref, row.secret_version);
    const caBundle =
        row.ca_secret_ref === null || row.ca_secret_version === null
            ? undefined
            : await read('ca-bundle', row.ca_secret_ref, row.ca_secret_version);
    return {
        connectionId: row.id,
        host: row.host,
        clientId: row.client_id,
        clientSecret,
        caBundle,
        active: row.active,
    };
}

async function markActivated(sql: Sql, orgId: string, id: string, version: string): Promise<boolean> {
    const rows = await sql`
        update forge_connection
        set active = true, version = ${version}, activated_at = now(), activation_refusal = null
        where org_id = ${orgId} and id = ${id} and removed_at is null
        returning id
    `;
    return rows.length > 0;
}

async function markRefused(sql: Sql, orgId: string, id: string, reason: ActivationRefusal): Promise<boolean> {
    const rows = await sql`
        update forge_connection set activation_refusal = ${reason}
        where org_id = ${orgId} and id = ${id} and removed_at is null and not active
        returning id
    `;
    return rows.length > 0;
}

/** What retiring a connection's secrets needs: the references, which exist from before the secrets do. */
interface RetiringRow {
    org_id: string;
    id: string;
    secret_ref: string;
    ca_secret_ref: string | null;
}

/**
 * Retires a tombstoned connection's secrets through the org purge's path (`retireSecrets`: every unresolved operation
 * reconciled before the live version is deleted, the collector run, and only a version row the collector confirmed gone
 * counts), then drops the row. False leaves the tombstone for the next attempt: an unconfirmed delete is never a success.
 */
async function finishRemoval(
    sql: Sql,
    secrets: SecretStore & { collect?: () => Promise<unknown> },
    row: RetiringRow,
    cleanup: { signal: AbortSignal; diagnose: (diagnostic: SecretDiagnostic) => void }
): Promise<boolean> {
    const retirement: OrgPurgeDeps['secrets'] = {
        issueOperationId: () => secrets.issueOperationId(),
        delete: (input) => secrets.delete(input),
        reconcileOperation: (input) => secrets.reconcileOperation(input),
        collect: () => (secrets.collect ? secrets.collect() : Promise.reject(new Error('no collector'))),
    };
    const refs = [row.secret_ref, ...(row.ca_secret_ref === null ? [] : [row.ca_secret_ref])];
    const failed = await sql.begin(async (tx) => {
        const owned = await tx<{ ref: string; identity_key: string }[]>`
            select ref, identity_key from secret where ref = any(${refs})
            union select ref, identity_key from secret_operation where ref = any(${refs})
        `;
        return retireSecrets(
            { tx, secrets: retirement, expired: () => cleanup.signal.aborted, signal: cleanup.signal },
            owned
        );
    });
    if (failed) {
        cleanup.diagnose({ event: 'cleanup-failed', kind: 'delete', ref: row.secret_ref as SecretRef });
        return false;
    }
    await sql`delete from forge_connection where org_id = ${row.org_id} and id = ${row.id} and removed_at is not null`;
    return true;
}

const SWEEP_BATCH = 100;
const SWEEP_CLEANUP_MS = 10_000;
/** How long an unpublished create is left to its own process before the sweep retires what it recorded. */
const CREATE_GRACE = '5 minutes';

/**
 * One recovery pass over every org (cross-org pool): finishes each removal a lost process or an unavailable secret
 * store left tombstoned, and each create that never published. A row it cannot confirm stays for the next pass.
 */
export async function sweepRemovedConnections({
    sql,
    secrets,
    secretLog,
}: {
    sql: Sql;
    secrets: SecretStore & { collect?: () => Promise<unknown> };
    secretLog: (diagnostic: SecretDiagnostic) => void;
}): Promise<number> {
    const rows = await sql<RetiringRow[]>`
        select org_id, id, secret_ref, ca_secret_ref from forge_connection
        where removed_at is not null
          and (secret_version is not null or removed_at < now() - ${CREATE_GRACE}::interval)
        order by removed_at limit ${SWEEP_BATCH}
    `;
    let finished = 0;
    for (const row of rows) {
        const cleanup = { signal: AbortSignal.timeout(SWEEP_CLEANUP_MS), diagnose: secretLog };
        if (await finishRemoval(sql, secrets, row, cleanup)) finished += 1;
    }
    return finished;
}
