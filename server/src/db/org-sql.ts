/**
 * The organization a statement on the request pool runs as. The org-owned tables carry the policy
 * `org_id = current_setting('app.org_id', true)` (151_row_level_security.sql), so a statement without the setting reads
 * no row and writes none. `orgSql` is a store's handle on the request pool: each statement it runs, and each
 * transaction it opens, sets the organization transaction-locally first, so the setting dies with the transaction and
 * a pooled connection never carries one organization into the next borrower. docs/row-level-security.md.
 */
import type { Sql, TransactionSql } from 'postgres';

/** The role every request runs as: no `bypassrls`, owns nothing, bound by every policy. */
export const REQUEST_ROLE = 'bellows_request';

/** The `bypassrls` role of the cross-org pool, and the owner of the definer functions below. */
export const CROSS_ORG_ROLE = 'bellows_cross_org';

/** The `security definer` functions a single-org path reads a cross-org fact through: a count, a slot or booleans. */
export const CROSS_ORG_FUNCTIONS = [
    'bellows_global_running',
    'bellows_global_admission_slot',
    'bellows_admission_occupancy',
    'bellows_sessions_foreign',
    'bellows_sessions_refused',
    'bellows_session_owned_elsewhere',
] as const;

/** What postgres.js keeps on a pending query and calls when its statement completes. */
interface PendingQuery extends Promise<unknown> {
    handler: (query: PendingQuery) => void;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
}

/** Sets `orgId` for the rest of `tx`. */
export function setOrg(tx: TransactionSql, orgId: string): Promise<unknown> {
    return tx`select set_config('app.org_id', ${orgId}, true)`.execute();
}

/** A statement held inside its transaction: `finished` settles when it completes, `answer`/`fail` reach its caller. */
interface Held {
    finished: Promise<unknown>;
    answer(value: unknown): void;
    fail(error: unknown): void;
}

/**
 * Takes `query`'s completion away from its caller until the transaction it runs in has committed, so a caller never
 * reads past a write that is not durable yet. postgres.js re-assigns a cursor's `resolve` and `reject` on every
 * fetch, so both are held through accessors and the latest assignment is the one answered.
 */
function hold(query: PendingQuery): Held {
    let resolve = query.resolve;
    let reject = query.reject;
    let complete: (value: unknown) => void = () => undefined;
    let abort: (error: unknown) => void = () => undefined;
    const finished = new Promise((ok, no) => {
        complete = ok;
        abort = no;
    });
    Object.defineProperty(query, 'resolve', {
        configurable: true,
        get: () => complete,
        set: (fn: (value: unknown) => void) => {
            resolve = fn;
        },
    });
    Object.defineProperty(query, 'reject', {
        configurable: true,
        get: () => abort,
        set: (fn: (error: unknown) => void) => {
            reject = fn;
        },
    });
    return { finished, answer: (value) => resolve(value), fail: (error) => reject(error) };
}

/**
 * `pool` scoped to `orgId`: a tagged statement or `unsafe` runs in its own transaction after the setting, `begin`
 * opens one with the setting already made, and a fragment stays a fragment. A cursor or `forEach` holds its
 * transaction until it completes or is closed. Ending the pool, `reserve`, `listen` and `subscribe` are not an org
 * store's to call and throw.
 */
export function orgSql(pool: Sql, orgId: string): Sql {
    if (!orgId) throw new Error('orgSql needs an organization');
    const dispatch = (query: PendingQuery): void => {
        const held = hold(query);
        pool.begin(async (tx) => {
            await setOrg(tx, orgId);
            // The statement rides the transaction's connection, after the setting.
            (tx`select 1` as unknown as PendingQuery).handler(query);
            return { value: await held.finished };
        }).then(
            // Answered once the commit is acknowledged; a failure after the rollback.
            ({ value }) => held.answer(value),
            (error: unknown) => held.fail(error)
        );
    };
    const scope = <T extends PendingQuery>(query: T): T => {
        query.handler = dispatch;
        return query;
    };
    const tagged = (strings: unknown, ...args: unknown[]) => {
        const built = (pool as unknown as (...a: unknown[]) => unknown)(strings, ...args);
        const isStatement = Array.isArray((strings as { raw?: unknown } | null)?.raw);
        return isStatement ? scope(built as PendingQuery) : built;
    };
    const refuse = (name: string) => () => {
        throw new Error(`${name} is not available on an organization's handle`);
    };
    return Object.assign(tagged, pool, {
        unsafe: (...args: Parameters<Sql['unsafe']>) => scope(pool.unsafe(...args) as unknown as PendingQuery),
        begin: (options: unknown, fn?: unknown) => {
            const body = (fn ?? options) as (tx: TransactionSql) => unknown;
            const mode = fn === undefined ? '' : (options as string);
            return pool.begin(mode, async (tx) => {
                await setOrg(tx, orgId);
                const result = body(tx);
                return Array.isArray(result) ? Promise.all(result) : result;
            });
        },
        file: refuse('file'),
        reserve: refuse('reserve'),
        listen: refuse('listen'),
        subscribe: refuse('subscribe'),
        end: refuse('end'),
        close: refuse('close'),
    }) as unknown as Sql;
}
