import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { NotificationKind } from '@factory-ai/core';
import {
    type CreatedEnvSecret,
    createEnvSecrets,
    releaseEnvSecrets,
    type RetiredEnvSecret,
    retireEnvSecrets,
} from '../db/env-secrets.js';
import type { SecretDiagnostic, SecretRef, SecretStore, SecretVersion } from '../secrets/secret-store.js';
import { subscriptionSecretIdentity } from './subscription-credential.js';

/** What a write carries; the row's id and stamps are the store's. */
export interface SubscriptionFields {
    connectorKind: string;
    /** Non-secret JSON the registered connector's `validateConfig` returned; the credential never rides it. */
    connectorConfig: unknown;
    eventKinds: NotificationKind[];
    /** Empty = every repo. */
    repos: string[];
    /** Empty = every workflow. */
    workflows: string[];
    enabled: boolean;
}

export interface SubscriptionView extends SubscriptionFields {
    id: string;
    createdAt: string;
    updatedAt: string;
}

export interface NotificationSubscriptionStore {
    list(): Promise<SubscriptionView[]>;
    /** The credential goes to the secret store first; the row keeps only its reference and version. */
    create(fields: SubscriptionFields, credential: string): Promise<SubscriptionView>;
    /**
     * Full replacement; null when this org has no such row. A credential rotates the secret (the old one is
     * retired after the commit); null keeps the stored one, which a change of `connectorKind` cannot do:
     * that writes nothing and answers `'kind-changed'`.
     */
    update(
        id: string,
        fields: SubscriptionFields,
        credential: string | null
    ): Promise<SubscriptionView | null | 'kind-changed'>;
    /** False when this org has no such row. The credential is retired with it. */
    remove(id: string): Promise<boolean>;
}

interface Row {
    id: string;
    connector_kind: string;
    connector_config: unknown;
    event_kinds: NotificationKind[];
    repos: string[];
    workflows: string[];
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
}

const toView = (row: Row): SubscriptionView => ({
    id: row.id,
    connectorKind: row.connector_kind,
    connectorConfig: row.connector_config,
    eventKinds: row.event_kinds,
    repos: row.repos,
    workflows: row.workflows,
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
});

/** Never `secret_ref` or `secret_version`: a view shows no credential at all, not even its reference. */
/** `undefined`: no such row. `old`: the reference a rotation replaced, retired after the commit. */
type Replaced = { row: Row; old: RetiredEnvSecret | undefined } | 'kind-changed' | undefined;

const COLUMNS = (sql: Sql) =>
    sql`id, connector_kind, connector_config, event_kinds, repos, workflows, enabled, created_at, updated_at`;

export function createNotificationSubscriptionStore({
    sql,
    orgId,
    ready,
    secrets,
    secretLog,
    writeDeadlineMs = 30_000,
    cleanupDeadlineMs = 10_000,
}: {
    sql: Sql;
    orgId: string;
    ready?: Promise<unknown> | undefined;
    /** Holds every subscription's credential (docs/notifications.md). */
    secrets: SecretStore;
    /** The secret store's diagnostic sink: a compensation that could not finish is reported here. */
    secretLog: (diagnostic: SecretDiagnostic) => void;
    /** Bounds the credential's create; compensation runs under its own `cleanupDeadlineMs`. */
    writeDeadlineMs?: number;
    cleanupDeadlineMs?: number;
}): NotificationSubscriptionStore {
    const gate = async () => {
        if (ready) await ready;
    };
    const cleanup = () => ({ signal: AbortSignal.timeout(cleanupDeadlineMs), diagnose: secretLog });

    /** Writes the credential; a failed write releases whatever it may have written and throws. */
    const mint = async (id: string, credential: string): Promise<CreatedEnvSecret> => {
        const { created, unknown, failure } = await createEnvSecrets(
            secrets,
            [{ name: id, identity: subscriptionSecretIdentity(orgId, id), value: credential }],
            { signal: AbortSignal.timeout(writeDeadlineMs) }
        );
        if (failure || !created[0]) {
            await release(id, [...created, ...unknown]);
            throw new Error(
                `notification credential unavailable: ${failure ? `${failure.code}/${failure.reason}` : 'not created'}`
            );
        }
        return created[0];
    };

    /** Compensation: deletes only what a fresh read of the subscription's own row shows nothing naming. */
    const release = (id: string, candidates: Parameters<typeof releaseEnvSecrets>[1]) =>
        releaseEnvSecrets(secrets, candidates, {
            ...cleanup(),
            referencedInScope: () =>
                sql<{ secret_ref: string | null }[]>`
                    select secret_ref from notification_subscription where org_id = ${orgId} and id = ${id}
                `,
        });

    const retired = (id: string, row: { secret_ref: string; secret_version: string }): RetiredEnvSecret => ({
        ref: row.secret_ref as SecretRef,
        version: row.secret_version as SecretVersion,
        identity: subscriptionSecretIdentity(orgId, id),
    });

    /** One transaction: lock the row, refuse a kind change without a credential, update, swap the reference. */
    const replaceRow = async (
        tx: TransactionSql,
        id: string,
        f: SubscriptionFields,
        made: CreatedEnvSecret | null
    ): Promise<Replaced> => {
        const [current] = await tx<{ connector_kind: string; secret_ref: string; secret_version: string }[]>`
            select connector_kind, secret_ref, secret_version from notification_subscription
            where org_id = ${orgId} and id = ${id}
            for update
        `;
        if (!current) return undefined;
        if (!made && current.connector_kind !== f.connectorKind) return 'kind-changed';
        const [row] = await tx<Row[]>`
            update notification_subscription
            set connector_kind = ${f.connectorKind}, connector_config = ${sql.json(f.connectorConfig as never)},
                event_kinds = ${f.eventKinds}::text[], repos = ${f.repos}::text[],
                workflows = ${f.workflows}::text[], enabled = ${f.enabled}, updated_at = now()
                ${made ? sql`, secret_ref = ${made.ref}, secret_version = ${made.version}` : sql``}
            where org_id = ${orgId} and id = ${id}
            returning ${COLUMNS(sql)}
        `;
        return row && { row, old: made ? retired(id, current) : undefined };
    };

    return {
        async list() {
            await gate();
            const rows = await sql<Row[]>`
                select ${COLUMNS(sql)} from notification_subscription
                where org_id = ${orgId}
                order by created_at, id
            `;
            return rows.map(toView);
        },
        async create(f, credential) {
            await gate();
            const id = randomUUID();
            const made = await mint(id, credential);
            try {
                const [row] = await sql<Row[]>`
                    insert into notification_subscription
                        (org_id, id, connector_kind, connector_config, event_kinds, repos, workflows, enabled,
                         secret_ref, secret_version)
                    values (${orgId}, ${id}, ${f.connectorKind}, ${sql.json(f.connectorConfig as never)},
                            ${f.eventKinds}::text[], ${f.repos}::text[], ${f.workflows}::text[], ${f.enabled},
                            ${made.ref}, ${made.version})
                    returning ${COLUMNS(sql)}
                `;
                return toView(row!);
            } catch (error) {
                await release(id, [made]);
                throw error;
            }
        },
        async update(id, f, credential) {
            await gate();
            const made = credential === null ? null : await mint(id, credential);
            const dropMade = () => (made ? release(id, [made]) : undefined);
            let replaced: Replaced;
            try {
                replaced = await sql.begin((tx) => replaceRow(tx, id, f, made));
            } catch (error) {
                await dropMade();
                throw error;
            }
            if (replaced === 'kind-changed') return replaced;
            if (!replaced) {
                await dropMade();
                return null;
            }
            if (replaced.old) await retireEnvSecrets(secrets, [replaced.old], cleanup());
            return toView(replaced.row);
        },
        async remove(id) {
            await gate();
            const rows = await sql<{ secret_ref: string; secret_version: string }[]>`
                delete from notification_subscription where org_id = ${orgId} and id = ${id}
                returning secret_ref, secret_version
            `;
            if (rows[0]) await retireEnvSecrets(secrets, [retired(id, rows[0])], cleanup());
            return rows.length > 0;
        },
    };
}
