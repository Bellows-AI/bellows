import { displayTitle, type TaskTitleOrigin } from '@factory-ai/core';

/** A task id is a uuid; the blank-prompt fallback names it by its first block. */
const SHORT_ID_LENGTH = 8;

/** What every surface needs to name a task: the root's stored title and the command the fallback derives from. */
export interface TitledTask {
    id: string;
    command: string;
    title: string | null;
    titleOrigin: TaskTitleOrigin | null;
}

/**
 * The ONE name a task wears in the header, sidebar, inbox and dialogs (BEL-252): the stored title, else the
 * capped first line of the command, else `Task #<short id>` for a prompt with no text — never an empty heading.
 */
export function taskTitleText(task: TitledTask): string {
    const { text } = displayTitle(task);
    return text !== '' ? text : `Task #${task.id.slice(0, SHORT_ID_LENGTH)}`;
}
