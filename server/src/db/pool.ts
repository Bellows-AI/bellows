/**
 * The board's pools carry a statement timeout as a connection parameter, so one organization's heavy read cannot
 * hold a connection, or the database, past it. The long paths that are legitimate lift it for their own transaction
 * only: the migration runner (`migrate.ts`), the metric point org backfill, the org purge's final delete, and every
 * advisory-lock wait (below). `server/test-db/statement-timeout.test.ts`.
 */
import postgres, { type Sql, type TransactionSql } from 'postgres';

export const boardPool = (url: string, { max, statementTimeoutMs }: { max: number; statementTimeoutMs: number }): Sql =>
    postgres(url, { max, connection: { statement_timeout: statementTimeoutMs } });

/** Lifts the statement timeout for the rest of `tx`: for a statement whose length is the work, not a fault. */
export async function liftStatementTimeout(tx: Sql | TransactionSql): Promise<void> {
    await tx`set local statement_timeout = 0`;
}

/**
 * Waits for a transaction-scoped advisory lock on `key` however long its holder keeps it, as the wait did before the
 * pool had a timeout, then restores the budget the transaction had (the pool's, or one it set itself).
 */
export async function waitAdvisoryXactLock(tx: Sql | TransactionSql, key: string): Promise<void> {
    const [budget] = await tx<{ setting: string }[]>`select current_setting('statement_timeout') as setting`;
    await liftStatementTimeout(tx);
    await tx`select pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`;
    await tx`select set_config('statement_timeout', ${budget?.setting ?? '0'}, true)`;
}
