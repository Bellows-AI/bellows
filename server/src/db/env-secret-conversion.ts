import type { Sql } from 'postgres';
import { MAX_SECRET_BYTES } from '../secrets/secret-input.js';
import type { SecretDiagnostic, SecretStore } from '../secrets/secret-store.js';
import {
    createEnvSecrets,
    envSecretIdentity,
    releaseEnvSecrets,
    type EnvSecretScope,
    type RetiredEnvSecret,
    type UnknownEnvSecret,
} from './env-secrets.js';

/**
 * The one-shot conversion of old-format environment secrets (docs/env.md): rows flagged secret whose value
 * still sits in `env_var.value` move into the secret store, one row at a time. Only `is_secret` rows are
 * ever selected or updated, and no value appears in the summary or in a diagnostic.
 */

interface RowKey {
    org_id: string;
    user_id: string | null;
    repo_owner: string | null;
    repo_name: string | null;
    name: string;
}

export interface OversizedRow {
    org: string;
    scopeKind: EnvSecretScope['kind'];
    scopeKey: string;
    name: string;
}

export interface ConversionSummary {
    converted: number;
    /** Rows a concurrent writer or run changed first: left as they now are. */
    skipped: number;
    oversized: OversizedRow[];
    failed: number;
    /** References whose cleanup was not confirmed: records the store may still hold. */
    orphans: string[];
    remaining: number;
    aborted: boolean;
}

const ROW_DEADLINE_MS = 30_000;
const CLEANUP_DEADLINE_MS = 10_000;

const scopeOf = (row: RowKey): EnvSecretScope =>
    row.user_id !== null
        ? { kind: 'workspace', userId: row.user_id }
        : row.repo_owner !== null
          ? { kind: 'repo', owner: row.repo_owner, name: row.repo_name as string }
          : { kind: 'org' };

const scopeKey = (scope: EnvSecretScope): string =>
    scope.kind === 'workspace' ? scope.userId : scope.kind === 'repo' ? `${scope.owner}/${scope.name}` : '';

/** Zero when every secret row is in the store and the run was not interrupted. */
export const conversionExitCode = (summary: Pick<ConversionSummary, 'remaining' | 'aborted'>): 0 | 1 =>
    summary.remaining === 0 && !summary.aborted ? 0 : 1;

export async function convertPlaintextEnvSecrets({
    sql,
    secrets,
    signal,
    secretLog,
    rowDeadlineMs = ROW_DEADLINE_MS,
}: {
    sql: Sql;
    secrets: SecretStore;
    signal: AbortSignal;
    secretLog: (diagnostic: SecretDiagnostic) => void;
    rowDeadlineMs?: number;
}): Promise<ConversionSummary> {
    const summary: ConversionSummary = {
        converted: 0,
        skipped: 0,
        oversized: [],
        failed: 0,
        orphans: [],
        remaining: 0,
        aborted: false,
    };
    const orphans = new Set<string>();
    const diagnose = (diagnostic: SecretDiagnostic) => {
        if (diagnostic.event === 'cleanup-failed' && diagnostic.ref) orphans.add(diagnostic.ref);
        secretLog(diagnostic);
    };

    const sameSlot = (row: RowKey) => sql`
        org_id = ${row.org_id} and name = ${row.name}
        and user_id is not distinct from ${row.user_id}::uuid
        and repo_owner is not distinct from ${row.repo_owner}
        and repo_name is not distinct from ${row.repo_name}
    `;
    const cleanup = (referencedInScope: () => Promise<readonly { secret_ref: string | null }[]>) => ({
        signal: AbortSignal.timeout(CLEANUP_DEADLINE_MS),
        diagnose,
        referencedInScope,
    });

    const keys = await sql<RowKey[]>`
        select org_id, user_id, repo_owner, repo_name, name from env_var
        where is_secret and secret_ref is null and value is not null
        order by org_id, name
    `;

    const convertRow = async (row: RowKey): Promise<void> => {
        const [current] = await sql<{ value: string }[]>`
            select value from env_var
            where ${sameSlot(row)} and is_secret and secret_ref is null and value is not null
        `;
        if (!current) {
            summary.skipped += 1;
            return;
        }
        const scope = scopeOf(row);
        const old = current.value;
        if (Buffer.byteLength(old, 'utf8') > MAX_SECRET_BYTES) {
            summary.oversized.push({
                org: row.org_id,
                scopeKind: scope.kind,
                scopeKey: scopeKey(scope),
                name: row.name,
            });
            return;
        }
        // A fresh read of the row's own scope: a reference any row there names is never deleted.
        const referencedInScope = () => sql<{ secret_ref: string | null }[]>`
            select secret_ref from env_var
            where org_id = ${row.org_id}
            and user_id is not distinct from ${row.user_id}::uuid
            and repo_owner is not distinct from ${row.repo_owner}
            and repo_name is not distinct from ${row.repo_name}
        `;

        const rowSignal = AbortSignal.any([signal, AbortSignal.timeout(rowDeadlineMs)]);
        const identity = envSecretIdentity(row.org_id, scope, row.name);
        const { created, unknown, failure } = await createEnvSecrets(
            secrets,
            [{ name: row.name, identity, value: old }],
            { signal: rowSignal }
        );
        if (failure) {
            const candidates: (RetiredEnvSecret | UnknownEnvSecret)[] = [...created, ...unknown];
            await releaseEnvSecrets(secrets, candidates, cleanup(referencedInScope));
            summary.failed += 1;
            return;
        }
        const [made] = created;
        if (!made) {
            summary.failed += 1;
            return;
        }
        let matched = 0;
        try {
            const updated = await sql`
                update env_var set value = null, secret_ref = ${made.ref}, secret_version = ${made.version}
                where ${sameSlot(row)} and is_secret and secret_ref is null and value = ${old}
                returning 1
            `;
            matched = updated.length;
        } catch {
            matched = 0;
        }
        if (matched === 0) {
            await releaseEnvSecrets(secrets, [made], cleanup(referencedInScope));
            summary.skipped += 1;
            return;
        }
        summary.converted += 1;
    };

    for (const row of keys) {
        if (signal.aborted) break;
        try {
            await convertRow(row);
        } catch {
            summary.failed += 1;
        }
    }

    summary.aborted = signal.aborted;
    const [count] = await sql<{ n: number }[]>`
        select count(*)::int as n from env_var where is_secret and secret_ref is null and value is not null
    `;
    if (!count) throw new Error('remaining count unavailable');
    summary.remaining = count.n;
    summary.orphans = [...orphans];
    return summary;
}
