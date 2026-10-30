import type { Sql } from 'postgres';

/** The retry schedule every outbox shares (commerce 095, notifications 104): 30 s doubling to a 1 h cap. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_CAP_MS = 3_600_000;
/** Doubling past this exponent is already beyond the cap; clamping before `power` keeps the arithmetic finite. */
export const MAX_BACKOFF_EXPONENT = 20;
/** The counter is an integer column; it stops counting long before it could wrap. */
export const MAX_FAILURES = 1_000_000;

/** `at` plus the capped doubling backoff for the failure counter in `column` (as it stands before the increment). */
export const backoffAt = (sql: Sql, at: Date, column: string) => sql`
    ${at}::timestamptz
        + least(${RETRY_CAP_MS}::double precision, ${RETRY_BASE_MS}::double precision * power(2, least(${sql(column)}, ${MAX_BACKOFF_EXPONENT})))
          * interval '1 millisecond'
`;
