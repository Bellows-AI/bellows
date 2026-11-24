import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * The archive confirmation's copy, exported pure so the offline suite holds it: the title names
 * the task — the display title the page's h1 carries — and the body states what the board's archive
 * contract does. Nothing is deleted: the thread, runs, logs and pull request links stay readable under
 * Archived, and Unarchive undoes it. A task still running is stopped first, and the copy says so.
 */
export function archiveDialogTitle(name: string): string {
    return `Archive \u201C${name}\u201D?`;
}

export function archiveDialogBody(running: boolean): string {
    return (
        (running ? 'The running task is stopped first. ' : '') +
        'It leaves the task list, and its runs, logs and pull request links stay readable under Archived. ' +
        'Unarchive brings it back.'
    );
}

/**
 * The accessible face of Archive task: a presentational Headless UI `Dialog`. Focus trapping, Escape, the
 * backdrop and focus restoration to the menu trigger are the library's; `initialFocus` lands on Cancel.
 *
 * Mid-request the dialog is the whole world: `onClose` refuses (Escape and the backdrop included),
 * both buttons disable, and the confirm button reads Archiving… — a request in flight must not be
 * dismissable into a state nobody can see. A refusal keeps the dialog open and is announced once,
 * as an alert; the page navigates to the inbox only on success, so a failed archive leaves the
 * reader exactly where the decision was made.
 */
export function TaskArchiveDialog({
    open,
    name,
    running,
    archiving,
    error,
    onClose,
    onConfirm,
}: {
    /** Controlled by the page — the menu item in the header opens this, never mutates. */
    open: boolean;
    /** The task's display title (`taskTitleText`) — the same name the page's h1 carries. */
    name: string;
    /** Whether a run is live: the archive stops it first. */
    running: boolean;
    /** The page's in-flight guard: the mutation is one request, and it cannot be dismissed. */
    archiving: boolean;
    /** The board's refusal, announced once as an alert inside the open dialog. */
    error: string | null;
    onClose: () => void;
    onConfirm: () => void;
}) {
    return (
        <ConfirmDialog
            open={open}
            busy={archiving}
            title={archiveDialogTitle(name)}
            confirmClassName="chat-remove"
            confirmText={archiving ? 'Archiving\u2026' : 'Archive task'}
            onClose={onClose}
            onConfirm={onConfirm}
        >
            <p>{archiveDialogBody(running)}</p>
            {error !== null ? (
                <p className="status error" role="alert">
                    {error}
                </p>
            ) : null}
        </ConfirmDialog>
    );
}
