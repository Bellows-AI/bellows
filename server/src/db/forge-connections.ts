import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { GitlabApi, ProbeReason, ProbeResult } from '../gitlab/gitlab-api.js';
import type {
    SecretDiagnostic,
    SecretIdentity,
    SecretRef,
    SecretStore,
    SecretVersion,
} from '../secrets/secret-store.js';
import {
    type CreatedEnvSecret,
    createEnvSecrets,
    EnvSecretError,
    releaseEnvSecrets,
    type RetiredEnvSecret,
    retireEnvSecrets,
} from './env-secrets.js';

/**
 * An organization's connection to a self-hosted GitLab (docs/connections.md): the host, its OAuth application's client
 * id and the root groups members' projects may come from in the row; the application's secret and an optional CA bundle
 * in the secret store, the row keeping each reference and the version it was written at. A connection is stored
 * pending (`active` false) with the outcome of an unauthenticated reachability probe; an unreachable instance is
 * recorded with its reason, never refused and never deleted.
 */

const UNIQUE_VIOLATION = '23505';
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
    probe: { status: 'reachable' | 'unreachable'; reason: ProbeReason | null; at: string };
    createdAt: string;
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
}

interface Row {
    id: string;
    forge: typeof FORGE;
    host: string;
    client_id: string;
    allowed_groups: string[];
    ca_secret_ref: string | null;
    active: boolean;
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
    probe: { status: row.probe_status, reason: row.probe_reason, at: row.probed_at.toISOString() },
    createdAt: row.created_at.toISOString(),
});

/** The reason a probe failed, null for a reachable instance. */
const reasonOf = (probe: ProbeResult): ProbeReason | null => (probe.reachable ? null : probe.reason);

const COLUMNS = (sql: Sql) =>
    sql`id, forge, host, client_id, allowed_groups, ca_secret_ref, active, probe_status, probe_reason, probed_at, created_at`;

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
    secrets: SecretStore;
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

    /** Compensation: deletes only what a fresh read of the connection's own row shows nothing naming. */
    const release = (id: string, candidates: Parameters<typeof releaseEnvSecrets>[1]) =>
        releaseEnvSecrets(secrets, candidates, {
            ...cleanup(),
            referencedInScope: () =>
                sql<{ secret_ref: string | null }[]>`
                    select secret_ref from forge_connection where org_id = ${orgId} and id = ${id}
                    union all
                    select ca_secret_ref from forge_connection where org_id = ${orgId} and id = ${id}
                `,
        });

    const mint = async (id: string, input: ConnectionInput) => {
        const items = [
            { name: 'client-secret', value: input.clientSecret },
            ...(input.caBundle === undefined ? [] : [{ name: 'ca-bundle', value: input.caBundle }]),
        ].map((item) => ({
            ...item,
            identity: gitlabConnectionIdentity(orgId, id, item.name as ConnectionSecretPart),
        }));
        const { created, unknown, failure } = await createEnvSecrets(secrets, items, {
            signal: AbortSignal.timeout(writeDeadlineMs),
        });
        if (failure) {
            await release(id, [...created, ...unknown]);
            // A secret-store failure is an outage the route answers 503 (server/src/routes/error-handler.ts).
            throw new EnvSecretError(id, failure.code, failure.reason);
        }
        const of = (part: ConnectionSecretPart) => created.find((made) => made.name === part);
        return { secret: of('client-secret') as CreatedEnvSecret, ca: of('ca-bundle') };
    };

    const retired = (
        id: string,
        row: {
            secret_ref: string;
            secret_version: string;
            ca_secret_ref: string | null;
            ca_secret_version: string | null;
        }
    ) => {
        const targets: RetiredEnvSecret[] = [
            {
                ref: row.secret_ref as SecretRef,
                version: row.secret_version as SecretVersion,
                identity: gitlabConnectionIdentity(orgId, id, 'client-secret'),
            },
        ];
        if (row.ca_secret_ref !== null && row.ca_secret_version !== null) {
            targets.push({
                ref: row.ca_secret_ref as SecretRef,
                version: row.ca_secret_version as SecretVersion,
                identity: gitlabConnectionIdentity(orgId, id, 'ca-bundle'),
            });
        }
        return targets;
    };

    return {
        async list() {
            await gate();
            const rows = await sql<Row[]>`
                select ${COLUMNS(sql)} from forge_connection where org_id = ${orgId} order by created_at, id
            `;
            return rows.map(toView);
        },
        async get(id) {
            await gate();
            const [row] = await sql<Row[]>`
                select ${COLUMNS(sql)} from forge_connection where org_id = ${orgId} and id = ${id}
            `;
            return row ? toView(row) : null;
        },
        async create(input) {
            await gate();
            const host = input.host.toLowerCase();
            const taken = await sql`
                select 1 from forge_connection where org_id = ${orgId} and forge = ${FORGE} and host = ${host}
            `;
            if (taken.length > 0) return { ok: false, reason: 'exists' };
            const probe = await gitlab.probe({ host, caBundle: input.caBundle });
            const id = randomUUID();
            const { secret, ca } = await mint(id, input);
            try {
                const [row] = await sql<Row[]>`
                    insert into forge_connection
                        (org_id, id, forge, host, client_id, allowed_groups, secret_ref, secret_version,
                         ca_secret_ref, ca_secret_version, probe_status, probe_reason)
                    values (${orgId}, ${id}, ${FORGE}, ${host}, ${input.clientId}, ${input.allowedGroups}::text[],
                            ${secret.ref}, ${secret.version}, ${ca?.ref ?? null}, ${ca?.version ?? null},
                            ${probe.reachable ? 'reachable' : 'unreachable'}, ${reasonOf(probe)})
                    returning ${COLUMNS(sql)}
                `;
                return { ok: true, connection: toView(row as Row) };
            } catch (error) {
                await release(id, [secret, ...(ca ? [ca] : [])]);
                if ((error as { code?: string }).code === UNIQUE_VIOLATION) return { ok: false, reason: 'exists' };
                throw error;
            }
        },
        async remove(id) {
            await gate();
            const rows = await sql<
                {
                    secret_ref: string;
                    secret_version: string;
                    ca_secret_ref: string | null;
                    ca_secret_version: string | null;
                }[]
            >`
                delete from forge_connection where org_id = ${orgId} and id = ${id}
                returning secret_ref, secret_version, ca_secret_ref, ca_secret_version
            `;
            if (rows[0]) await retireEnvSecrets(secrets, retired(id, rows[0]), cleanup());
            return rows.length > 0;
        },
    };
}
