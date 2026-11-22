/**
 * The transition engine: the board's answer to "a workflow row just finished — what does the graph
 * say next?". Pure by design (design.md Decision 1): thread rows in, one transition out — the
 * complete() transaction calls it beside the threadDone aggregate and inserts what it says, so a
 * bug can rest a thread but never misplace one silently.
 *
 * Graph state is derived from the audit trail (design.md Decision 2): the current node is the
 * completed row's own `workflow_node` — or, for an off-graph user follow-up, the thread's newest
 * carried node — and a loop count is a count of the thread's rows for the target node, dead rows
 * included (attempts are retries, rounds are rows). No instance-state table exists to drift.
 */
import { COMMAND_LIMIT } from '@factory-ai/core';
import type { FailureKind, GateReport } from '../jobs/job-store-types.js';
import {
    type EdgeRule,
    type ParamValues,
    type WorkflowDefinition,
    type WorkflowNode,
    interpolate,
    nodeOf,
    tailMatches,
} from './workflow-schema.js';

/** What the engine needs to know about one thread row, oldest first. The store reads this shape. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running']);

export interface EngineRow {
    id: string;
    /** The row's graph position; null on an off-graph row (a user follow-up, or a pre-027 job). */
    node: string | null;
    status: string;
    output: string | null;
    gates: GateReport[] | null;
    sessionId: string | null;
}

/** The completed run the edges are evaluated against. `status` is the verdict the board landed. */
export interface CompletedRun {
    id: string;
    node: string | null;
    status: 'succeeded' | 'failed';
    output: string | null;
    gates: GateReport[] | null;
    /** The verdict's failure kind; `blocked` rests the thread before any edge is evaluated. */
    failureKind?: FailureKind | null;
}

/**
 * Why the thread rested instead of advancing. Every reason is a visible, follow-up-able stop —
 * the failure mode of this engine is stopping, never misbehaving.
 *
 * - `off_graph`         neither the completed row nor any thread row carries a node.
 * - `no_edge`           no outgoing rule matched — marker absence is a first-class outcome.
 * - `loop_bound`        the matching edge is exhausted: the thread already holds `max` rows for
 *                       its target, dead rows included.
 * - `command_too_large` the interpolated prompt exceeded the command cap even with bounded tails.
 * - `no_publication`     the transition would enter a block's own helper-driven node from outside
 *                       its scope with no recorded publication to hand the helper —
 *                       never a runnable claim with a null publication, which the helper itself
 *                       cannot act on (`job-store-worker.ts`'s `runWorkflowTransition`).
 * - `blocked`           the agent reported it cannot proceed for a reason outside the repository
 *                       (`FACTORY_BLOCKED:`) — a human must act; no edge, custom `failed` included.
 * - `services`          the run failed on a dead declared service: another round over the same
 *                       service can only fail the same way (the `blocked` precedent).
 * - `publish`           the run's publish step failed: resting it spends no round.
 * - `config`            the run's `.bellows.yaml` could not be read: the same file fails the same
 *                       way on every retry, so no edge is followed, a custom `failed` one included.
 * - `checkpoint_unrestorable`  the thread's tree cannot be rebuilt from its checkpoint: a retry fails the same way,
 *                       so no edge is followed; a fresh manual retry stays available.
 * - `attachment_unavailable`  an attached file the board can no longer deliver: a retry fails the same way, so no edge
 *                       is followed; a fresh manual retry stays available.
 * - `skill_unavailable`  a pinned org or workspace skill the board can no longer deliver: a retry fails the same way, so no
 *                       edge is followed; a fresh manual retry stays available.
 * - `thread_busy`       an off-graph follow-up completed while a graph row of the thread is still
 *                       queued or running: that row owns the next step, and a second insert would
 *                       fork the thread (two successor rows, the round budget burned twice).
 */
export type RestReason =
    | 'off_graph'
    | 'no_edge'
    | 'loop_bound'
    | 'command_too_large'
    | 'no_publication'
    | 'blocked'
    | 'services'
    | 'publish'
    | 'config'
    | 'policy'
    | 'checkpoint_unrestorable'
    | 'attachment_unavailable'
    | 'skill_unavailable'
    | 'thread_busy';

/** Failure kinds that rest the thread before any edge is evaluated — a custom `failed` edge included. */
const REST_BY_KIND: Partial<Record<FailureKind, RestReason>> = {
    blocked: 'blocked',
    services: 'services',
    publish: 'publish',
    config: 'config',
    policy: 'policy',
    checkpoint_unrestorable: 'checkpoint_unrestorable',
    attachment_unavailable: 'attachment_unavailable',
    skill_unavailable: 'skill_unavailable',
};

export type Transition =
    | { action: 'insert'; node: WorkflowNode; command: string; session: 'resume' | 'fresh'; publish: boolean }
    | { action: 'rest'; reason: RestReason };

/**
 * The thread's PRIMARY session: the session of the first `resume`-policy run, scanned oldest
 * first (design.md Decision 3). Pre-workflow threads (snapshot null) are all resume-equivalent —
 * the follow-up copy-forward rule as it always was. Off-graph rows of a workflow thread (user
 * follow-ups) are skipped: they COPIED the primary, they did not mint it. A resume node with no
 * session to copy inserts with none and mints its own at claim — which then IS the primary, the
 * next scan finding it on that row.
 */
export function primarySessionId(definition: WorkflowDefinition | null, rows: EngineRow[]): string | null {
    for (const row of rows) {
        if (row.sessionId === null) continue;
        if (definition === null) return row.sessionId;
        const node = row.node === null ? undefined : nodeOf(definition, row.node);
        if (node?.session === 'resume') return row.sessionId;
    }
    return null;
}

/**
 * One transition, decided. Edges evaluate in the definition's declared order, first match wins
 * (the one deliberate simplification, design.md Open Questions) — and a bound-exhausted edge RESTS
 * the thread rather than falling through to a later edge: a loop that hit its limit is a stop the
 * author declared, not a branch to sneak out of.
 */
export function nextTransition(input: {
    snapshot: WorkflowDefinition;
    /**
     * The thread's frozen parameter values — the root row's `workflow_params`, read beside the
     * snapshot. Every `{{param.NAME}}` in any node's prompt resolves from here.
     */
    params: ParamValues;
    /**
     * The thread root's command — `{{command}}` in any prompt resolves to it. For a workflow
     * thread that is the interpolated entry prompt the member launched with (routes/jobs/jobs.ts
     * builds it), so a successor sees the member's own words, not a bare param value.
     */
    command: string;
    /** The whole thread, oldest first, as the store reads it inside the verdict's transaction. */
    rows: EngineRow[];
    completed: CompletedRun;
}): Transition {
    // The graph position the completion happens AT: the completed row's own node, or — an
    // off-graph user follow-up completing — the halted node, the thread's newest carried node
    // (design.md Decision 8): the human's extra work sits at the node, then the graph continues.
    if (input.completed.node === null && hasLiveGraphRow(input.rows, input.completed.id)) {
        return { action: 'rest', reason: 'thread_busy' };
    }
    const halted = input.completed.node ?? haltedNode(input.rows, input.completed.id);
    if (halted === null) return { action: 'rest', reason: 'off_graph' };
    const restReason = input.completed.failureKind ? REST_BY_KIND[input.completed.failureKind] : undefined;
    if (restReason !== undefined) return { action: 'rest', reason: restReason };

    for (const edge of input.snapshot.edges) {
        if (edge.from !== halted) continue;
        if (!ruleMatches(edge.when, input.completed)) continue;
        return followEdge(edge, input);
    }
    return { action: 'rest', reason: 'no_edge' };
}

/** The chosen edge's outcome: a loop bound, an unresolvable target, an oversized command, or the insert. */
function followEdge(
    edge: WorkflowDefinition['edges'][number],
    input: { snapshot: WorkflowDefinition; params: ParamValues; command: string; rows: EngineRow[] }
): Transition {
    // Loop bound from the audit trail: every row the thread already holds for the target
    // node counts, whatever status it reached — a dead review row is still a round.
    if (edge.max !== undefined) {
        const rounds = input.rows.filter((row) => row.node === edge.to).length;
        if (rounds >= edge.max) return { action: 'rest', reason: 'loop_bound' };
    }

    const target = nodeOf(input.snapshot, edge.to);
    if (target === undefined) return { action: 'rest', reason: 'no_edge' };

    const command = interpolate(target.prompt, {
        nodeOutput: (name) => {
            for (let i = input.rows.length - 1; i >= 0; i--) {
                const row = input.rows[i]!;
                if (row.node === name && row.output !== null) return row.output;
            }
            return '';
        },
        param: (name) => input.params[name] ?? '',
        command: input.command,
    });
    if (command.length > COMMAND_LIMIT) return { action: 'rest', reason: 'command_too_large' };

    return {
        action: 'insert',
        node: target,
        command,
        session: target.session,
        publish: target.publish === true,
    };
}

/** True when another graph row of the thread is queued or running — it, not the completed row, owns the next step. */
function hasLiveGraphRow(rows: EngineRow[], completedId: string): boolean {
    return rows.some((row) => row.id !== completedId && row.node !== null && LIVE_STATUSES.has(row.status));
}

/** The thread's newest row that carries a node, excluding the completed row itself. */
function haltedNode(rows: EngineRow[], completedId: string): string | null {
    for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!;
        if (row.id !== completedId && row.node !== null) return row.node;
    }
    return null;
}

/** The edge vocabulary, evaluated against what the board stored on the completed row. */
function ruleMatches(rule: EdgeRule, completed: CompletedRun): boolean {
    if (rule === 'succeeded') return completed.status === 'succeeded';
    if (rule === 'failed') return completed.status === 'failed';
    // A marker only counts on a run that succeeded.
    return completed.status === 'succeeded' && tailMatches(completed.output, rule.marker);
}
