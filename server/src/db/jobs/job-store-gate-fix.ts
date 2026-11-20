/**
 * An objective-mode thread's automatic gate repair (162): `complete()`'s transition half for a thread with no graph.
 * A run that failed on a declared gate gets one follow-up row in the same thread, carrying the failed gate's name and
 * output tail and the run's session, up to the limit frozen on the root. What rests instead is decided by
 * `nextObjectiveTransition` (workflow-engine.ts); this file reads the thread and inserts the row.
 */
import { waitAdvisoryXactLock } from '../pool.js';
import type { TransactionSql } from 'postgres';
import { OBJECTIVE_MODE, USER_SCOPE, type ExecutorScope } from '@factory-ai/core';
import { nextObjectiveTransition } from '../workflows/workflow-engine.js';
import { mergeClosureMarkerSet } from './job-store-merge.js';
import { doneFragment, terminalFragment } from './job-store-sql-fragments.js';
import type { FailureKind, GateReport } from './job-store-types.js';

export interface ObjectiveGateFixInput {
    orgId: string;
    rootJobId: string;
    completedId: string;
    status: string;
    failureKind: FailureKind | null;
    treeChanged: boolean | null;
    /** The limit frozen on the root row (162). */
    limit: number | null;
    createdBy: string | null;
}

export async function queueObjectiveGateFix(tx: TransactionSql, input: ObjectiveGateFixInput): Promise<void> {
    const { orgId, rootJobId, completedId } = input;
    // Only a gate failure can queue a row: every other verdict is the thread's final word, and takes no lock.
    if (input.status !== 'failed' || input.failureKind !== 'gate') return;
    // The same per-root lock the claim and the workflow transition take, so the round count and the insert are one step.
    await waitAdvisoryXactLock(tx, rootJobId);
    // A merge-closed thread walks no further, decided on a read under the lock (the workflow transition's rule).
    if (await mergeClosureMarkerSet(tx, orgId, rootJobId)) return;

    const rows = await tx<
        {
            id: string;
            terminal: boolean;
            done: boolean;
            gates: GateReport[] | null;
            session_id: string | null;
            repo: string | null;
            executor: string | null;
            executor_scope: string | null;
            agent_type: string | null;
            agent_model: string | null;
            gate_fix_round: number | null;
        }[]
    >`
        select id, ${terminalFragment(tx)} as terminal, ${doneFragment(tx)} as done, gates, session_id, repo, executor,
               executor_scope, agent_type, agent_model, gate_fix_round
        from job
        where org_id = ${orgId} and root_job_id = ${rootJobId}
        order by created_at, id
    `;
    // A thread the member marked done is closed: no follow-up is queued into it.
    if (rows.some((row) => row.done)) return;
    const completed = rows.find((row) => row.id === completedId);
    const transition = nextObjectiveTransition({
        completed: {
            id: completedId,
            node: null,
            status: 'failed',
            output: null,
            gates: completed?.gates ?? null,
            failureKind: input.failureKind,
            treeChanged: input.treeChanged,
        },
        limit: input.limit,
        spentRounds: rows.filter((row) => row.gate_fix_round !== null).length,
        threadBusy: rows.some((row) => row.id !== completedId && !row.terminal),
    });
    if (transition.action !== 'insert' || !completed) return;
    await tx`
        insert into job (org_id, command, created_by, repo, executor, executor_scope, agent_type, agent_model, parent_job_id, session_id, root_job_id, mode, gate_fix_round, skill_pin, skill_hidden)
        select ${orgId}, ${transition.command}, ${input.createdBy}, ${completed.repo}, ${completed.executor},
               ${(completed.executor_scope ?? USER_SCOPE) as ExecutorScope}, ${completed.agent_type},
               ${completed.agent_model}, ${completedId}, ${completed.session_id}, ${rootJobId}, ${OBJECTIVE_MODE},
               ${transition.round},
               -- The failed run's pin and visibility decision: the repair continues the same run with the same skill versions.
               coalesce((select p.skill_pin from job p where p.org_id = ${orgId} and p.id = ${completedId}), '[]'::jsonb),
               coalesce((select p.skill_hidden from job p where p.org_id = ${orgId} and p.id = ${completedId}), '[]'::jsonb)
    `;
}
