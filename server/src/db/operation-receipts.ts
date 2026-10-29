import type { Sql } from 'postgres';

/**
 * The durable receipt of one runner-side write to an external provider (099; docs/connections.md). A receipt is
 * the thread ROOT's, keyed by a logical operation key; every move is one guarded UPDATE, so two racing helpers
 * have one winner and a terminal receipt never moves. `started` was never dispatched, `dispatched` may have
 * run, `unknown` is a dispatched write whose outcome could not be confirmed. A throw is the caller's to answer
 * as unavailable, never as a refusal.
 */

export type ReceiptStatus = 'started' | 'dispatched' | 'succeeded' | 'failed' | 'unknown';

export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ['started', 'dispatched', 'succeeded', 'failed', 'unknown'];

/** The closed result of a receipt: the id of the one comment a write created. */
export interface ReceiptResult {
    commentId: string;
}

export interface Receipt {
    id: string;
    status: ReceiptStatus;
    result: ReceiptResult | null;
    dispatchedAt: string | null;
}

/** The only moves: a never-dispatched write may fail; a dispatched one settles; an unknown one may be found. */
const ALLOWED: Readonly<Record<ReceiptStatus, readonly ReceiptStatus[]>> = {
    started: ['dispatched', 'failed'],
    dispatched: ['succeeded', 'failed', 'unknown'],
    unknown: ['succeeded'],
    succeeded: [],
    failed: [],
};

export interface BeginInput {
    orgId: string;
    rootJobId: string;
    /** The attempt row that asks. */
    jobId: string;
    connectionId: string;
    provider: string;
    operation: string;
    key: string;
    fingerprint: string;
}

export type BeginResult = { receipt: Receipt; created: boolean } | 'key-reused';

export interface TransitionInput {
    orgId: string;
    /** Any job of the thread: its root scopes the receipt. */
    jobId: string;
    receiptId: string;
    from: readonly ReceiptStatus[];
    to: ReceiptStatus;
    result?: ReceiptResult;
}

export interface OperationReceipts {
    /** Inserts the receipt, or finds the one with this key; another fingerprint or connection is `key-reused`. */
    begin(input: BeginInput): Promise<BeginResult>;
    /** One guarded move; null when the receipt is not the thread's, is not in a `from` state, or the move is not allowed. */
    transition(input: TransitionInput): Promise<Receipt | null>;
    /** The receipt as the thread's root holds it, or null. */
    read(orgId: string, jobId: string, receiptId: string): Promise<Receipt | null>;
    /** Whether the root is bound to this connection and it is still active. */
    isBound(orgId: string, rootJobId: string, connectionId: string): Promise<boolean>;
}

interface Row {
    id: string;
    status: ReceiptStatus;
    result: ReceiptResult | null;
    dispatched_at: Date | null;
    connection_id?: string | null;
    fingerprint?: string;
}

const receiptOf = (row: Row): Receipt => ({
    id: row.id,
    status: row.status,
    result: row.result,
    dispatchedAt: row.dispatched_at ? row.dispatched_at.toISOString() : null,
});

export function createOperationReceipts({
    sql,
    ready,
}: {
    sql: Sql;
    ready?: Promise<unknown> | undefined;
}): OperationReceipts {
    return {
        async begin(input) {
            if (ready) await ready;
            const { orgId, rootJobId, jobId, connectionId, provider, operation, key, fingerprint } = input;
            const inserted = await sql<Row[]>`
                insert into integration_operation_receipt
                    (org_id, root_job_id, connection_id, provider, operation, operation_key, fingerprint, job_id)
                values (${orgId}, ${rootJobId}, ${connectionId}, ${provider}, ${operation}, ${key}, ${fingerprint}, ${jobId})
                on conflict (org_id, root_job_id, operation_key) do nothing
                returning id, status, result, dispatched_at
            `;
            const made = inserted[0];
            if (made) return { receipt: receiptOf(made), created: true };
            const found = await sql<Row[]>`
                select id, status, result, dispatched_at, connection_id, fingerprint
                from integration_operation_receipt
                where org_id = ${orgId} and root_job_id = ${rootJobId} and operation_key = ${key}
            `;
            const row = found[0];
            // The row cannot vanish (a receipt is deleted only with its root); a missing one is a store fault.
            if (!row) throw new Error('operation receipt vanished after a conflict');
            if (row.fingerprint !== fingerprint || row.connection_id !== connectionId) return 'key-reused';
            return { receipt: receiptOf(row), created: false };
        },

        async transition({ orgId, jobId, receiptId, from, to, result }) {
            if (from.length === 0 || from.some((state) => !ALLOWED[state].includes(to))) return null;
            if (ready) await ready;
            const rows = await sql<Row[]>`
                update integration_operation_receipt r
                set status = ${to},
                    result = ${result ? sql.json(result as never) : null},
                    job_id = ${jobId},
                    updated_at = now(),
                    dispatched_at = case when ${to} = 'dispatched' then now() else r.dispatched_at end
                where r.id = ${receiptId} and r.org_id = ${orgId}
                  and r.status = any(${from as string[]})
                  and r.root_job_id = (select j.root_job_id from job j where j.org_id = ${orgId} and j.id = ${jobId})
                returning r.id, r.status, r.result, r.dispatched_at
            `;
            const row = rows[0];
            return row ? receiptOf(row) : null;
        },

        async read(orgId, jobId, receiptId) {
            if (ready) await ready;
            const rows = await sql<Row[]>`
                select r.id, r.status, r.result, r.dispatched_at
                from integration_operation_receipt r
                where r.id = ${receiptId} and r.org_id = ${orgId}
                  and r.root_job_id = (select j.root_job_id from job j where j.org_id = ${orgId} and j.id = ${jobId})
            `;
            const row = rows[0];
            return row ? receiptOf(row) : null;
        },

        async isBound(orgId, rootJobId, connectionId) {
            if (ready) await ready;
            const rows = await sql<{ one: number }[]>`
                select 1 as one
                from job_connection_binding b
                join connector_connection c on c.id = b.connection_id and c.org_id = b.org_id
                where b.org_id = ${orgId} and b.root_job_id = ${rootJobId} and b.connection_id = ${connectionId}
                  and c.status = 'active'
                limit 1
            `;
            return rows.length > 0;
        },
    };
}
