/**
 * What a create-shaped write (create, follow-up, retry) does with its outcome: an uncertain failure
 * names how to recover, and a replay says so on stderr.
 */

import type { JobCreated } from './board.js';
import { OUTCOME } from './outcome.js';
import type { CommandResult } from './outcome.js';
import { renderCreated } from './render.js';
import { BoardError, MALFORMED_RESPONSE_CODE, NO_RESPONSE_STATUS } from './transport.js';

/** The status from which a board failure says nothing about whether the write was applied. */
const SERVER_ERROR_STATUS = 500;

/**
 * A write the board may or may not have applied: no answer arrived, the board failed, or its
 * answer could not be read. The error says so and names how to recover — repeating the command
 * under the same key is safe, repeating it with none could queue a second task.
 */
export async function recoverable(
    write: () => Promise<JobCreated>,
    key: string | undefined,
    attached = false
): Promise<JobCreated> {
    try {
        return await write();
    } catch (error) {
        const uncertain =
            error instanceof BoardError &&
            (error.status === NO_RESPONSE_STATUS ||
                error.status >= SERVER_ERROR_STATUS ||
                error.code === MALFORMED_RESPONSE_CODE);
        if (!uncertain) throw error;
        const hint =
            key === undefined
                ? 'the write may have been applied — check the task list before repeating it; pass --idempotency-key so a repeat cannot queue a second task'
                : `the write may have been applied — repeat the same command${attached ? ' (the same --attach set)' : ''} with --idempotency-key ${key} to recover its result`;
        throw new BoardError(`${error.message} (${hint})`, error.status, error.code);
    }
}

/** A create-shaped answer: the usual line, and — on stderr, so stdout stays parseable — a replay's note. */
export function createdResult(created: JobCreated): CommandResult {
    const result: CommandResult = { outcome: OUTCOME.ok, data: created, stdout: `${renderCreated(created)}\n` };
    return created.replayed
        ? { ...result, stderr: 'replayed: the board already made this task for this idempotency key\n' }
        : result;
}
