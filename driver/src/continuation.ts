import type { BoardJob } from './board.js';

const CONTINUATION_LEAD =
    'Your previous run of this task was interrupted before it finished. ' +
    'Continue from where this conversation left off. ' +
    'Before repeating any step, check what was already done — commits, pushes, pull requests — ' +
    'and do not redo it. ' +
    'If this conversation has no earlier turns, start the task from the beginning.\n\n' +
    'The task, for reference:\n\n';

/**
 * What a claim that continues an interrupted attempt in its session is prompted with (issue #822):
 * the resumed conversation already holds the task, and handing it over afresh would have the agent
 * repeat what the lost attempt already did. The command follows whole, never cut — on the
 * unwritten-session fallback this text is all the agent gets, and argv carries no command cap.
 */
export const continuationPrompt = (command: string): string => `${CONTINUATION_LEAD}${command}`;

/**
 * The prompt the agent CLI is handed: the command, framed as a continuation when the board says the
 * claim continues an interrupted attempt (`continuesInterrupted`). Only the prompt is framed:
 * `job.command` stays the text every claim of the row carries, which the runner's adoption mark,
 * the helper receipts and the commit title read.
 */
export const agentPrompt = (job: BoardJob): string =>
    job.continuesInterrupted ? continuationPrompt(job.command) : job.command;
