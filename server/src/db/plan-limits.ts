import type { Sql, TransactionSql } from 'postgres';

/**
 * An organization's plan limits (docs/commerce.md): what its pushed `org_plan` row carries (139), each limit the
 * push left null — or every limit, with no row — taken from the board's default, the Free plan
 * (`PLAN_DEFAULT_MAX_*`, required in cloud mode). An absent limit is unlimited, which only a self-hosted board
 * with no default and no push has. The row is the board's own copy of the last push, so an unreachable commerce
 * service changes nothing here; a failed read throws, and no caller turns it into unlimited.
 */
export interface PlanLimits {
    /** Non-review rows running at once. */
    readonly running?: number;
    /** Rows queued at once; a create past it is refused. */
    readonly queued?: number;
    /** Wall time one run may bank, in seconds; the heartbeat then answers stop with cause `wall-time`. */
    readonly wallSeconds?: number;
    /** Tokens the org's runs may report per period (`plan-allowances.ts`); a create past it is refused. */
    readonly tokens?: number;
    /** Attachment and run-log bytes the org may hold (`plan-allowances.ts`); an upload past it is refused. */
    readonly storageBytes?: number;
    /** Days a settled thread is kept (`org-retention.ts`); the pass applies a lower value only after a notice. */
    readonly retentionDays?: number;
}

/** Why the board stopped a run on its own (`job.stop_cause`). */
export type StopCause = 'wall-time';

/** A create or upload the organization's plan refuses, naming the limit it hit. */
export class PlanLimitError extends Error {
    constructor(
        readonly limit: 'queued' | 'tokens' | 'storage',
        readonly max: number
    ) {
        super(`plan limit reached: ${max} ${limit}`);
        this.name = 'PlanLimitError';
    }
}

/** A bigint column as postgres.js answers it (a string), or null. */
const bigOrNull = (value: string | null | undefined): number | null =>
    value === null || value === undefined ? null : Number(value);

export async function planLimits(sql: Sql | TransactionSql, orgId: string, defaults: PlanLimits): Promise<PlanLimits> {
    const [row] = await sql<
        {
            max_running: number | null;
            max_queued: number | null;
            max_wall_seconds: number | null;
            max_tokens: string | null;
            max_storage_bytes: string | null;
            max_retention_days: number | null;
        }[]
    >`
        select max_running, max_queued, max_wall_seconds, max_tokens, max_storage_bytes, max_retention_days
        from org_plan where org_id = ${orgId}
    `;
    const limits = {
        running: row?.max_running ?? defaults.running,
        queued: row?.max_queued ?? defaults.queued,
        wallSeconds: row?.max_wall_seconds ?? defaults.wallSeconds,
        tokens: bigOrNull(row?.max_tokens) ?? defaults.tokens,
        storageBytes: bigOrNull(row?.max_storage_bytes) ?? defaults.storageBytes,
        retentionDays: row?.max_retention_days ?? defaults.retentionDays,
    };
    return Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined));
}
