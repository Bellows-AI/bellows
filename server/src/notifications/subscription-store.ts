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
import { readSubscriptionCredential, subscriptionSecretIdentity } from './subscription-credential.js';
import type { TestTarget } from './test-send.js';

/** What a write carries; the row's id and stamps are the store's. */
export interface SubscriptionFields {
    connectorKind: string;
    /** Non-secret JSON the registered connector's `validateConfig` returned; the credential never rides it. */
    connectorConfig: unknown;
    eventKinds: NotificationKind[];
    /** Empty = every repo. */
    repos: string[];
    enabled: boolean;
}

export interface SubscriptionView extends SubscriptionFields {
    id: string;
    createdAt: string;
    updatedAt: string;
}

/** Whose rows a call sees: the org's (`user_id` null) or one member's own. The two scopes never overlap. */
export type SubscriptionOwner = { kind: 'org' } | { kind: 'user'; userId: string };

export const ORG_OWNER: SubscriptionOwner = { kind: 'org' };

const userIdOf = (owner: SubscriptionOwner): string | null => (owner.kind === 'user' ? owner.userId : null);

export interface NotificationSubscriptionStore {
    list(owner: SubscriptionOwner): Promise<SubscriptionView[]>;
    /** The credential goes to the secret store first; the row keeps only its reference and version. */
    create(owner: SubscriptionOwner, fields: SubscriptionFields, credential: string): Promise<SubscriptionView>;
    /**
     * Full replacement; null when this owner has no such row. A credential rotates the secret (the old one is
     * retired after the commit); null keeps the stored one, which a change of `connectorKind` cannot do:
     * that writes nothing and answers `'kind-changed'`.
     */
    update(
        owner: SubscriptionOwner,
        id: string,
        fields: SubscriptionFields,
        credential: string | null
    ): Promise<SubscriptionView | null | 'kind-changed'>;
    /** False when this owner has no such row. The credential is retired with it. */
    remove(owner: SubscriptionOwner, id: string): Promise<boolean>;
    /**
     * What a test send needs of one row, enabled or not; null only when a successful read found no such row. A
     * credential that cannot be confirmed is `credential: null` (inconclusive), a failed query throws.
     */
    testTarget(owner: SubscriptionOwner, id: string, signal: AbortSignal): Promise<TestTarget | null>;
}

interface Row {
    id: string;
    connector_kind: string;
    connector_config: unknown;
    event_kinds: NotificationKind[];
    repos: string[];
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
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
});

/** Never `secret_ref` or `secret_version`: a view shows no credential at all, not even its reference. */
/** `undefined`: no such row. `old`: the reference a rotation replaced, retired after the commit. */
type Replaced = { row: Row; old: RetiredEnvSecret | undefined } | 'kind-changed' | undefined;

const COLUMNS = (sql: Sql) =>
    sql`id, connector_kind, connector_config, event_kinds, repos, enabled, created_at, updated_at`;

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
    /** One scope predicate for every statement: org rows have no user, a personal row only its own. */
    const ownerClause = (owner: SubscriptionOwner) =>
        owner.kind === 'org' ? sql`user_id is null` : sql`user_id = ${owner.userId}::uuid`;
    const cleanup = () => ({ signal: AbortSignal.timeout(cleanupDeadlineMs), diagnose: secretLog });

    /** Writes the credential; a failed write releases whatever it may have written and throws. */
    const mint = async (owner: SubscriptionOwner, id: string, credential: string): Promise<CreatedEnvSecret> => {
        const { created, unknown, failure } = await createEnvSecrets(
            secrets,
            [{ name: id, identity: subscriptionSecretIdentity(orgId, id, userIdOf(owner)), value: credential }],
            { signal: AbortSignal.timeout(writeDeadlineMs) }
        );
        if (failure || !created[0]) {
            await release(owner, id, [...created, ...unknown]);
            throw new Error(
                `notification credential unavailable: ${failure ? `${failure.code}/${failure.reason}` : 'not created'}`
            );
        }
        return created[0];
    };

    /** Compensation: deletes only what a fresh read of the subscription's own row shows nothing naming. */
    const release = (owner: SubscriptionOwner, id: string, candidates: Parameters<typeof releaseEnvSecrets>[1]) =>
        releaseEnvSecrets(secrets, candidates, {
            ...cleanup(),
            referencedInScope: () =>
                sql<{ secret_ref: string | null }[]>`
                    select secret_ref from notification_subscription
                    where org_id = ${orgId} and id = ${id} and ${ownerClause(owner)}
                `,
        });

    const retired = (
        owner: SubscriptionOwner,
        id: string,
        row: { secret_ref: string; secret_version: string }
    ): RetiredEnvSecret => ({
        ref: row.secret_ref as SecretRef,
        version: row.secret_version as SecretVersion,
        identity: subscriptionSecretIdentity(orgId, id, userIdOf(owner)),
    });

    /** One transaction: lock the row, refuse a kind change without a credential, update, swap the reference. */
    const replaceRow = async (
        tx: TransactionSql,
        { owner, id }: { owner: SubscriptionOwner; id: string },
        f: SubscriptionFields,
        made: CreatedEnvSecret | null
    ): Promise<Replaced> => {
        const [current] = await tx<{ connector_kind: string; secret_ref: string; secret_version: string }[]>`
            select connector_kind, secret_ref, secret_version from notification_subscription
            where org_id = ${orgId} and id = ${id} and ${ownerClause(owner)}
            for update
        `;
        if (!current) return undefined;
        if (!made && current.connector_kind !== f.connectorKind) return 'kind-changed';
        const [row] = await tx<Row[]>`
            update notification_subscription
            set connector_kind = ${f.connectorKind}, connector_config = ${sql.json(f.connectorConfig as never)},
                event_kinds = ${f.eventKinds}::text[], repos = ${f.repos}::text[], enabled = ${f.enabled},
                updated_at = now()
                ${made ? sql`, secret_ref = ${made.ref}, secret_version = ${made.version}` : sql``}
            where org_id = ${orgId} and id = ${id} and ${ownerClause(owner)}
            returning ${COLUMNS(sql)}
        `;
        return row && { row, old: made ? retired(owner, id, current) : undefined };
    };

    return {
        async list(owner) {
            await gate();
            const rows = await sql<Row[]>`
                select ${COLUMNS(sql)} from notification_subscription
                where org_id = ${orgId} and ${ownerClause(owner)}
                order by created_at, id
            `;
            return rows.map(toView);
        },
        async create(owner, f, credential) {
            await gate();
            const id = randomUUID();
            const made = await mint(owner, id, credential);
            try {
                const [row] = await sql<Row[]>`
                    insert into notification_subscription
                        (org_id, id, user_id, connector_kind, connector_config, event_kinds, repos, enabled,
                         secret_ref, secret_version)
                    values (${orgId}, ${id}, ${userIdOf(owner)}::uuid, ${f.connectorKind}, ${sql.json(f.connectorConfig as never)},
                            ${f.eventKinds}::text[], ${f.repos}::text[], ${f.enabled},
                            ${made.ref}, ${made.version})
                    returning ${COLUMNS(sql)}
                `;
                return toView(row!);
            } catch (error) {
                await release(owner, id, [made]);
                throw error;
            }
        },
        async update(owner, id, f, credential) {
            await gate();
            const made = credential === null ? null : await mint(owner, id, credential);
            const dropMade = () => (made ? release(owner, id, [made]) : undefined);
            let replaced: Replaced;
            try {
                replaced = await sql.begin((tx) => replaceRow(tx, { owner, id }, f, made));
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
        async remove(owner, id) {
            await gate();
            const rows = await sql<{ secret_ref: string; secret_version: string }[]>`
                delete from notification_subscription
                where org_id = ${orgId} and id = ${id} and ${ownerClause(owner)}
                returning secret_ref, secret_version
            `;
            if (rows[0]) await retireEnvSecrets(secrets, [retired(owner, id, rows[0])], cleanup());
            return rows.length > 0;
        },
        async testTarget(owner, id, signal) {
            await gate();
            const [row] = await sql<
                (Pick<Row, 'connector_kind' | 'connector_config' | 'event_kinds'> & {
                    secret_ref: string;
                    secret_version: string;
                })[]
            >`
                select connector_kind, connector_config, event_kinds, secret_ref, secret_version
                from notification_subscription
                where org_id = ${orgId} and id = ${id} and ${ownerClause(owner)}
            `;
            if (!row) return null;
            return {
                kind: row.connector_kind,
                config: row.connector_config,
                eventKinds: row.event_kinds,
                credential: await readSubscriptionCredential(
                    secrets,
                    {
                        identity: subscriptionSecretIdentity(orgId, id, userIdOf(owner)),
                        ref: row.secret_ref,
                        version: row.secret_version,
                    },
                    signal
                ),
            };
        },
    };
}
