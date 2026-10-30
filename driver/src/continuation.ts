import type { BoardJob, ConnectionOutcome } from './board/board.js';

const CONTINUATION_LEAD =
    'Your previous run of this task was interrupted before it finished. ' +
    'Continue from where this conversation left off. ' +
    'Before repeating any step, check what was already done — commits, pushes, pull requests — ' +
    'and do not redo it. ' +
    'If this conversation has no earlier turns, start the task from the beginning.\n\n';
const TASK_LEAD = 'The task, for reference:\n\n';

/** One sentence per requirement the earlier attempt raised: what the user did about the connection it asked for. */
const outcomeSentence = ({ label, outcome }: ConnectionOutcome): string =>
    outcome === 'bound'
        ? `The ${label} connection you asked for is now bound to this task; use it and carry on.`
        : `The user chose to continue without the ${label} connection; do not ask for it again, and say so in your final report where it matters.`;

/**
 * What a claim that continues an interrupted attempt in its session is prompted with (issue #822):
 * the resumed conversation already holds the task, and handing it over afresh would have the agent
 * repeat what the lost attempt already did. The command follows whole, never cut — on the
 * unwritten-session fallback this text is all the agent gets, and argv carries no command cap.
 */
export const continuationPrompt = (command: string, outcomes: readonly ConnectionOutcome[] = []): string =>
    `${CONTINUATION_LEAD}${outcomes.map((each) => `${outcomeSentence(each)}\n\n`).join('')}${TASK_LEAD}${command}`;

/**
 * The prompt the agent CLI is handed: the command, framed as a continuation when the board says the
 * claim continues an interrupted attempt (`continuesInterrupted`). Only the prompt is framed:
 * `job.command` stays the text every claim of the row carries, which the runner's adoption mark,
 * the helper receipts and the commit title read.
 */
export const agentPrompt = (job: BoardJob): string =>
    job.continuesInterrupted ? continuationPrompt(job.command, job.connectionOutcomes) : job.command;
