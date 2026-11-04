import { TASK_TITLE_MAX } from '@factory-ai/core';
import { useId, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * The rename dialog (BEL-252): one field, prefilled with the name the page shows. Save is dark for a blank
 * title and mid-request; a refusal — including the stale answer naming the title the board now holds — is
 * announced once, inside the open dialog. Presentational: the page owns the write and the revision.
 */
export function TaskRenameDialog({
    open,
    initial,
    saving,
    error,
    onClose,
    onSave,
}: {
    open: boolean;
    /** The display title the page rendered; the field starts here each time the dialog opens. */
    initial: string;
    saving: boolean;
    error: string | null;
    onClose: () => void;
    onSave: (title: string) => void;
}) {
    const [draft, setDraft] = useState(initial);
    const [wasOpen, setWasOpen] = useState(open);
    const fieldId = useId();
    // Each opening starts from what the page shows now, not from the last abandoned edit.
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) setDraft(initial);
    }
    const blank = draft.trim() === '';
    return (
        <ConfirmDialog
            open={open}
            busy={saving}
            title="Rename task"
            confirmClassName="primary"
            confirmText={saving ? 'Saving…' : 'Save'}
            confirmDisabled={blank}
            onClose={onClose}
            onConfirm={() => onSave(draft)}
        >
            <label htmlFor={fieldId} className="task-rename-label">
                Task title
            </label>
            <input
                id={fieldId}
                className="field task-rename-field"
                value={draft}
                maxLength={TASK_TITLE_MAX}
                disabled={saving}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && !blank && !saving) {
                        e.preventDefault();
                        e.stopPropagation();
                        onSave(draft);
                    }
                }}
            />
            {error !== null ? (
                <p className="status error" role="alert">
                    {error}
                </p>
            ) : null}
        </ConfirmDialog>
    );
}
