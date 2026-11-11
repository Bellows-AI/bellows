/** The interruption budgets (issue #792, BEL-302); `job-store-actions.ts` re-exports them. */
import type { Fragment, Sql, TransactionSql } from 'postgres';

/**
 * How many attempts the infrastructure may interrupt before an interruption is refused (issue
 * #792): an interrupted attempt is refunded, so this — not `max_attempts` — bounds a job the
 * platform keeps taking away.
 */
export const INTERRUPTION_BUDGET = 5;

/** Only interruptions inside this trailing window count against `INTERRUPTION_BUDGET`. */
export const INTERRUPTION_WINDOW_MS = 3_600_000;

/**
 * How many node losses (BEL-302) a row may suffer inside `NODE_LOSS_WINDOW_MS` before the row is retired. An
 * attempt lost to a drained node, an evicted pod or a removed container says nothing of the job, so it
 * never spends `INTERRUPTION_BUDGET`; this generous bound only stops a row the platform thrashes for ever.
 */
export const NODE_LOSS_BUDGET = 100;

/** Only node losses inside this trailing window count against `NODE_LOSS_BUDGET`. */
export const NODE_LOSS_WINDOW_MS = 21_600_000;
/**
 * Whether the row's interruption budget is spent. A blocked hand-back waits on a leftover rather than
 * losing an attempt to the infrastructure, so it is outside the count; a requirement hand-back waits on a
 * person, so it is too; a node loss (BEL-302) is the platform's, so it has its own bound. Only interruptions inside
 * `INTERRUPTION_WINDOW_MS` count; an `at` that does not parse counts as spent.
 * The cutoff is bound per call from the process clock that wrote each `at`, never DB now().
 */
const poisonSpent = (q: Sql | TransactionSql): Fragment => q`(
    select count(*) from jsonb_array_elements(interruptions) as spent
    where spent ->> 'blocked' is distinct from 'true' and spent ->> 'requirement' is distinct from 'true'
      and spent ->> 'nodeLoss' is distinct from 'true'
      and case when spent ->> 'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
          then (spent ->> 'at')::timestamptz > ${new Date(Date.now() - INTERRUPTION_WINDOW_MS)} else true end
) >= ${INTERRUPTION_BUDGET}`;

/** Whether the row's node-loss bound is spent: `NODE_LOSS_BUDGET` flagged entries inside `NODE_LOSS_WINDOW_MS`. */
export const nodeLossSpent = (q: Sql | TransactionSql): Fragment => q`(
    select count(*) from jsonb_array_elements(interruptions) as spent
    where spent ->> 'nodeLoss' = 'true'
      and case when spent ->> 'at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9]{2}(:?[0-9]{2})?)$'
          then (spent ->> 'at')::timestamptz > ${new Date(Date.now() - NODE_LOSS_WINDOW_MS)} else true end
) >= ${NODE_LOSS_BUDGET}`;

/** Whether the row is out of interruptions of either kind. */
export const interruptionsSpent = (q: Sql | TransactionSql): Fragment => q`(${poisonSpent(q)} or ${nodeLossSpent(q)})`;

/** The rule a row out of interruptions ran into, for the retirement's log line; null while neither is spent. */
export const spentRule = (q: Sql | TransactionSql): Fragment =>
    q`(case when ${poisonSpent(q)} then 'poison budget' when ${nodeLossSpent(q)} then 'node-loss bound' end)`;

/**
 * Whether an interrupt may still be recorded. A blocked or requirement release spends no budget and is accepted
 * past a spent one; a node-loss release spends only the node-loss bound, so a spent poison budget does not refuse
 * it; every other interrupt (an unflagged release, an adoption) is refused once either is spent.
 */
export const releaseOpen = (
    q: Sql | TransactionSql,
    {
        release,
        blocked,
        requirement,
        nodeLoss,
    }: { release: boolean; blocked: boolean; requirement: boolean; nodeLoss: boolean }
): Fragment => {
    if (release && (blocked || requirement)) return q`true`;
    return release && nodeLoss ? q`not ${nodeLossSpent(q)}` : q`not ${interruptionsSpent(q)}`;
};
