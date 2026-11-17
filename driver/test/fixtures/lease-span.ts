import { BOARD_BUDGET_MAX_BACKOFF_MS } from '../../src/board/board-retry.js';

/**
 * How many tries a board that never answers is asked across the default 300 s lease: the capped backoffs
 * (the last one may be cut short) leave at least this many, and a budget shorter than the lease has fewer.
 */
export const ATTEMPTS_SPANNING_LEASE = Math.floor((300_000 - 30_000) / BOARD_BUDGET_MAX_BACKOFF_MS);
