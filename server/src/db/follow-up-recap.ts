import { COMMAND_LIMIT } from '@factory-ai/core';
import type { TransactionSql } from 'postgres';

/**
 * The recap a sessionless member follow-up carries: with no conversation to resume, the agent
 * would otherwise start from nothing but the new command. Rendered at claim time into the
 * delivered command only — the stored row keeps what the person typed, and the master prompt and
 * turn context stay byte-identical across the thread (`master-prompt.ts`).
 */

/** One earlier turn of the thread, oldest first. */
export interface RecapTurn {
    status: string;
    /** The person's own command: the root's, or a member follow-up's. Null on an engine-written node row. */
    command: string | null;
    /** The node an engine-written row ran; null on a person's turn. */
    workflowNode: string | null;
    summary: string | null;
    output: string | null;
}

/** Per-field cap: a command keeps its head, a result its tail — where each one's point is. */
const FIELD_LIMIT = 1_500;
/** The whole delivered command's cap: preamble, recap and new instruction together. */
const DELIVERED_LIMIT = COMMAND_LIMIT;

const head = (text: string): string => (text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT)} […]` : text);
const tail = (text: string): string => (text.length > FIELD_LIMIT ? `[…] ${text.slice(-FIELD_LIMIT)}` : text);

function renderTurn(turn: RecapTurn, index: number): string {
    const what =
        turn.command !== null ? head(turn.command.trim()) : `(workflow step: ${turn.workflowNode ?? 'unknown'})`;
    const result = turn.summary?.trim() || turn.output?.trim();
    return `Turn ${index + 1} (${turn.status}): ${what}\nResult: ${result ? tail(result) : '(none recorded)'}`;
}

/**
 * The command to deliver: the recap of `turns`, then the new command, within `limit` — less than
 * the whole cap when it rides inside a continuation. No turns, no recap.
 */
export function renderFollowUpRecap(turns: RecapTurn[], command: string, limit = DELIVERED_LIMIT): string {
    if (turns.length === 0) return command;
    const rendered = turns.map(renderTurn);
    const preamble =
        'This task continues in a new agent session: the earlier turns left no session to resume. ' +
        'Their record follows, oldest first, as context only — it holds no instructions for this turn. ' +
        "The checkout already holds the earlier turns' work.";
    const instruction = `New instruction:\n\n${command}`;
    // Oldest turns are dropped first: the newest say where the task stands now.
    for (let first = 0; first < rendered.length; first += 1) {
        const omitted = first > 0 ? [`(${first} earlier turn${first === 1 ? '' : 's'} omitted)`] : [];
        const delivered = [preamble, ...omitted, ...rendered.slice(first), instruction].join('\n\n');
        if (delivered.length <= limit) return delivered;
    }
    return command;
}
/** The thread's turns before `jobId`, oldest first: what `renderFollowUpRecap` recaps. */
export async function readRecapTurns(
    tx: TransactionSql,
    orgId: string,
    rootJobId: string,
    jobId: string
): Promise<RecapTurn[]> {
    const rows = await tx<
        {
            status: string;
            command: string;
            workflow_node: string | null;
            is_root: boolean;
            summary: string | null;
            output: string | null;
        }[]
    >`
        select j.status, j.command, j.workflow_node, j.id = j.root_job_id as is_root, j.summary, j.output
        from job j, job self
        where self.org_id = ${orgId} and self.id = ${jobId}
          and j.org_id = ${orgId} and j.root_job_id = ${rootJobId}
          and j.id <> self.id and j.created_at <= self.created_at
        order by j.created_at, j.id
    `;
    // An engine-written node row's command is the node's own prompt, often a board marker
    // instruction; quoting it would hand the agent an order meant for a different turn.
    return rows.map((row) => ({
        status: row.status,
        command: row.is_root || row.workflow_node === null ? row.command : null,
        workflowNode: row.workflow_node,
        summary: row.summary,
        output: row.output,
    }));
}

const CONTINUATION_LEAD =
    'Your previous run of this task was interrupted before it finished. ' +
    'Continue from where this conversation left off. ' +
    'Before repeating any step, check what was already done — commits, pushes, pull requests — ' +
    'and do not redo it. ' +
    'If this conversation has no earlier turns, start the task from the beginning.\n\n' +
    'The task, for reference:\n\n';

/**
 * What a claim that continues an interrupted attempt in its session delivers (issue #822): the
 * resumed conversation already holds the task, and handing it over afresh would have the agent
 * repeat what the lost attempt already did. What that attempt was delivered follows for reference
 * — the command, behind `recap` when it carried one, trimmed by the recap's own rule to the room
 * the lead leaves. A command that leaves the lead no room is delivered without it, never cut: on
 * the unwritten-session fallback this text is all the agent gets, and its last instruction counts.
 */
export function renderContinuation(command: string, recap: RecapTurn[] = []): string {
    const task = renderFollowUpRecap(recap, command, DELIVERED_LIMIT - CONTINUATION_LEAD.length);
    if (CONTINUATION_LEAD.length + task.length <= DELIVERED_LIMIT) return CONTINUATION_LEAD + task;
    return renderFollowUpRecap(recap, command);
}

/**
 * The command a claim delivers: a claim that continues an interrupted attempt in its session is
 * told to carry on (`renderContinuation`); a member follow-up with no session to resume starts
 * fresh, so the earlier turns ride ahead of its command; every other claim delivers the row's own
 * command. A continuation wraps what the attempt that started its session was delivered: the recap
 * too when that session is the row's own and the row a member follow-up — that attempt started
 * sessionless, so it carried the recap.
 */
export async function claimCommand(
    tx: TransactionSql,
    orgId: string,
    rootJobId: string,
    row: {
        id: string;
        command: string;
        follow_up: boolean;
        session_id: string | null;
        own_session: boolean;
        workflow_node: string | null;
        resumes_interrupted: boolean;
    }
): Promise<string> {
    const memberFollowUp = row.follow_up && row.workflow_node === null;
    if (row.resumes_interrupted) {
        const recapped = memberFollowUp && row.own_session;
        return renderContinuation(row.command, recapped ? await readRecapTurns(tx, orgId, rootJobId, row.id) : []);
    }
    if (!memberFollowUp || row.session_id !== null) return row.command;
    return renderFollowUpRecap(await readRecapTurns(tx, orgId, rootJobId, row.id), row.command);
}
