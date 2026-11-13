import { isCredentialKey, STORED_CREDENTIAL_PREFIX } from '@factory-ai/core';
import type { Sql } from 'postgres';
import type { ObjectStore } from '../artifacts/object-store.js';
import { TAR_END, tarFile } from '../tar.js';
import { recordAudit, userActor } from './audit-log.js';
import { orgObjectPrefixes } from './org-purge.js';
import { ORG_TABLES } from './org-tables.js';

/**
 * An organization's export (docs/organizations.md): one tar of `tables/<table>/<page>.ndjson` for every table in the
 * org-table registry, then `objects/<key>` for every object under the org's three namespaces, the backend prefix
 * dropped. A table is read in keyset pages of its primary key, each page its own short query, so the export holds no
 * transaction and no pool connection between pages, and a client that goes away stops it at the next page or object.
 *
 * Secrets stay out: the secret store's tables carry no `org_id` and are never read, so a secret is exported as the
 * reference its consumer row holds. The columns below — credential hashes, PKCE material, a legacy plaintext token
 * and the lease tokens a runner authenticates with — are dropped from every row, and so is every credential-shaped
 * value nested in a structured column, converted or not. The archive stops at the signal: between pages, and in a
 * pending listing or object read.
 */

export const EXPORT_PAGE_ROWS = 500;

export const EXPORT_OMITTED_COLUMNS: Readonly<Partial<Record<string, readonly string[]>>> = {
    access_token: ['token_hash'],
    attachment_upload: ['session_hash', 'capability_hash'],
    connector_connection: ['api_token'],
    integration_authorization: ['state_hash', 'pkce_verifier'],
    job: ['lease_token', 'prior_lease_token'],
    job_conclusion: ['lease_token'],
    job_question: ['lease_token'],
    job_settle_receipt: ['lease_token'],
    oauth_authorization_code: ['code_hash', 'code_challenge'],
    session: ['token_hash'],
};

export interface OrgExportDeps {
    sql: Sql;
    objects: ObjectStore;
    /** The artifact backend's key prefix (`ArtifactBackend.prefix`). */
    prefix: string;
    orgId: string;
}

export interface OrgExport {
    /** Writes the `org.export` audit row naming the admin, before any byte is sent. */
    record(actorUserId: string): Promise<void>;
    /** The archive's bytes, in order. Returning early (an aborted client) stops every further read. */
    archive(signal: AbortSignal): AsyncGenerator<Uint8Array>;
}

type OrgTable = (typeof ORG_TABLES)[number];
/** One exported row: its JSON line and its key columns as text (`k0`, `k1`, …), the next page's cursor. */
type PageRow = { line: string } & Partial<Record<string, string>>;

/** `$1` is the org id and `$2` the omitted columns; the cursor's parameters follow them. */
const CURSOR_PARAM_BASE = 3;
/** A page's file name: its number zero-padded, so the pages sort in order. */
const PAGE_NAME_DIGITS = 6;

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
const encoder = new TextEncoder();

/** The table's primary key columns in key order, or `ctid` for a table without one (`env_var`). */
async function keyColumnsOf(sql: Sql, table: OrgTable): Promise<string[]> {
    const rows = await sql<{ name: string }[]>`
        select a.attname as name from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = ${table}::regclass and i.indisprimary
        order by array_position(i.indkey::int2[], a.attnum)
    `;
    return rows.length ? rows.map((row) => row.name) : ['ctid'];
}

/**
 * A copy with every credential-shaped value (`isCredentialKey`) dropped, at any depth, unless it is a stored-credential
 * reference. It does not wait for a store's lazy conversion: a profile saved before keys moved to the secret store
 * still holds its plaintext key until the executor store's first read.
 */
function withoutCredentials(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutCredentials);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
        const plaintext = typeof inner === 'string' && inner !== '' && !inner.startsWith(STORED_CREDENTIAL_PREFIX);
        if (!(plaintext && isCredentialKey(key))) out[key] = withoutCredentials(inner);
    }
    return out;
}

/**
 * One row's JSON line with every structured column passed through `withoutCredentials`. A row with nothing to drop
 * keeps Postgres's own text, so a number past JavaScript's precision is exported as stored.
 */
function exportedLine(line: string): string {
    const row = JSON.parse(line) as Record<string, unknown>;
    let dropped = false;
    for (const [column, value] of Object.entries(row)) {
        if (typeof value !== 'object' || value === null) continue;
        const kept = withoutCredentials(value);
        if (JSON.stringify(kept) === JSON.stringify(value)) continue;
        row[column] = kept;
        dropped = true;
    }
    return dropped ? JSON.stringify(row) : line;
}

/** One table's rows, a page at a time: each page the NDJSON text of up to `EXPORT_PAGE_ROWS` rows. */
async function* tablePages(sql: Sql, orgId: string, table: OrgTable, signal: AbortSignal): AsyncGenerator<string> {
    const keys = await keyColumnsOf(sql, table);
    const cast = keys[0] === 'ctid' ? '::tid' : '';
    const keyList = keys.map((key) => `t.${ident(key)}`).join(', ');
    const keyText = keys.map((key, i) => `t.${ident(key)}::text as k${i}`).join(', ');
    const omitted = [...(EXPORT_OMITTED_COLUMNS[table] ?? [])];
    let cursor: string[] | null = null;
    for (;;) {
        signal.throwIfAborted();
        const after: string = cursor
            ? `and (${keyList}) > (${keys.map((_, i) => `$${i + CURSOR_PARAM_BASE}${cast}`).join(', ')})`
            : '';
        const rows: PageRow[] = await sql.unsafe<PageRow[]>(
            `select (to_jsonb(t) - $2::text[])::text as line, ${keyText}
             from ${ident(table)} t where t.org_id = $1 ${after}
             order by ${keyList} limit ${EXPORT_PAGE_ROWS}`,
            [orgId, omitted, ...(cursor ?? [])]
        );
        // The first page is written even when empty, so every registered table has its file.
        if (rows.length || !cursor) yield rows.map((row) => `${exportedLine(row.line)}\n`).join('');
        if (rows.length < EXPORT_PAGE_ROWS) return;
        const last = rows[rows.length - 1];
        cursor = keys.map((_, i): string => last?.[`k${i}`] ?? '');
    }
}

/** Every key under one namespace, a listing page at a time. A failed listing rejects: the archive never ends. */
async function* objectKeys(objects: ObjectStore, namespace: string, signal: AbortSignal): AsyncGenerator<string> {
    let after: string | undefined;
    for (;;) {
        const page = await objects.list(namespace, { after, signal });
        if (!page.length) return;
        yield* page;
        after = page.at(-1);
    }
}

export function createOrgExport({ sql, objects, prefix, orgId }: OrgExportDeps): OrgExport {
    return {
        async record(actorUserId) {
            await sql.begin((tx) =>
                recordAudit(tx, { orgId, actor: userActor(actorUserId), action: 'org.export', target: orgId })
            );
        },
        async *archive(signal) {
            const at = new Date();
            for (const table of ORG_TABLES) {
                let page = 0;
                for await (const text of tablePages(sql, orgId, table, signal)) {
                    page += 1;
                    const name = `tables/${table}/${String(page).padStart(PAGE_NAME_DIGITS, '0')}.ndjson`;
                    yield* tarFile(name, encoder.encode(text), at);
                }
            }
            for (const namespace of orgObjectPrefixes(prefix, orgId)) {
                for await (const key of objectKeys(objects, namespace, signal)) {
                    const body = await objects.get(key, { signal });
                    // Gone between the listing and the read (a retention sweep): nothing left to export.
                    if (body) yield* tarFile(`objects/${key.slice(prefix.length)}`, body, at);
                }
            }
            yield TAR_END;
        },
    };
}
