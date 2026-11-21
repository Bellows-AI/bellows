import { COMMAND_LIMIT } from '@factory-ai/core';
import type { TransactionSql } from 'postgres';
import { renderFailedGates } from './gate-report.js';
import { readThreadGateReports } from './jobs/job-store-gate-reports.js';
import type { LastGateReport } from './jobs/job-store-types.js';

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

/** The command to deliver: the recap of `turns`, then the new command. No turns, no recap. */
export function renderFollowUpRecap(turns: RecapTurn[], command: string): string {
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
        if (delivered.length <= DELIVERED_LIMIT) return delivered;
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

/**
 * The command a claim delivers, and the thread's last gate reports it carries: a member follow-up
 * with no session to resume starts fresh, so the earlier turns ride ahead of its command; every
 * other claim delivers the row's own command. A claim that continues an interrupted attempt in its
 * session is delivered exactly what that attempt's first claim was — the recap too when the
 * session is the row's own, minted by a first claim that ran sessionless — never wrapped: the
 * runner that claim launched is marked with this text (`COMMAND_MARK`) and adopted on it, and the
 * driver frames the continuation itself.
 *
 * A member follow-up of a run whose stored gates hold a failed report also carries it after the
 * person's words: the end-of-run gates ran after the agent exited, so their output never entered
 * the session. The report is the parent row's, so every claim of this row renders the same text.
 */
export async function claimCommandAndReports(
    tx: TransactionSql,
    orgId: string,
    rootJobId: string,
    row: {
        id: string;
        command: string;
        follow_up: boolean;
        parent_job_id: string | null;
        session_id: string | null;
        own_session: boolean;
        workflow_node: string | null;
        resumes_interrupted: boolean;
    }
): Promise<{ command: string; lastGateReports: LastGateReport[] }> {
    const reports = await readThreadGateReports(tx, orgId, rootJobId, row);
    const memberFollowUp = row.follow_up && row.workflow_node === null;
    const failed = memberFollowUp ? renderFailedGates(reports.parent, row.command) : '';
    const command = failed ? `${row.command}\n\n${failed}` : row.command;
    // Whether the attempt's first claim ran sessionless: for a continuation, when the session it
    // resumes is one that first claim minted (`own_session`).
    const sessionless = row.resumes_interrupted ? row.own_session : row.session_id === null;
    const delivered =
        memberFollowUp && sessionless
            ? renderFollowUpRecap(await readRecapTurns(tx, orgId, rootJobId, row.id), command)
            : command;
    return { command: delivered, lastGateReports: reports.last };
}
