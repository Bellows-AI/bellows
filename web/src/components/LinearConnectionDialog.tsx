import { useEffect, useId, useRef, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import type { StartAuthorizationInput } from '../api/connections.js';
import { ALLOW_COMMENTS_LABEL, commentsHelp } from './WriteConsentDialog.js';

export const LINEAR_DIALOG_TITLE = 'Connect Linear';
export const LINEAR_SUBMIT_LABEL = 'Continue to Linear';
export const LINEAR_WORKSPACE_HELP =
    'Linear asks which workspace to connect on its own consent screen, every time, so there is nothing to name here.';
export const LINEAR_COMMENTS_HELP = commentsHelp('Linear');

/**
 * Connect Linear: the comment-access checkbox in the executor dialog's field layout and no site field — Linear's
 * consent screen, asked with `prompt=consent` on every connect, is where the member picks the workspace. Headless UI
 * owns the focus trap, Escape, the backdrop and focus restoration; no `<form>` because the CSP sends
 * `form-action 'none'`. A refusal keeps the dialog and shows the route's message as sent; a start that succeeds
 * leaves the page for the consent screen.
 */
export function LinearConnectionDialog({
    open,
    saving,
    onClose,
    onStart,
}: {
    open: boolean;
    saving: boolean;
    onClose: () => void;
    /** Resolves to the refusal message, or null when the browser is on its way to the consent screen. */
    onStart: (input: StartAuthorizationInput) => Promise<string | null>;
}) {
    const [comments, setComments] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const ids = useId();
    const commentsRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) {
            setComments(false);
            setFailure(null);
        }
    }, [open]);

    const close = () => {
        if (!saving) onClose();
    };
    const start = async () => {
        setFailure(await onStart({ access: comments ? 'write' : 'read' }));
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            className="dialog-layer"
            aria-labelledby={`${ids}-title`}
            aria-describedby={`${ids}-workspace-help`}
            initialFocus={commentsRef}
        >
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="dialog picker">
                    <DialogTitle as="h2" id={`${ids}-title`}>
                        {LINEAR_DIALOG_TITLE}
                    </DialogTitle>

                    <p className="picker-help" id={`${ids}-workspace-help`}>
                        {LINEAR_WORKSPACE_HELP}
                    </p>

                    <div className="picker-field">
                        <label className="settings-toggle" htmlFor={`${ids}-comments`}>
                            <input
                                ref={commentsRef}
                                id={`${ids}-comments`}
                                type="checkbox"
                                checked={comments}
                                disabled={saving}
                                aria-describedby={`${ids}-comments-help`}
                                onChange={(e) => setComments(e.target.checked)}
                            />
                            {ALLOW_COMMENTS_LABEL}
                        </label>
                        <p className="picker-help" id={`${ids}-comments-help`}>
                            {LINEAR_COMMENTS_HELP}
                        </p>
                    </div>

                    {failure ? (
                        <p className="status" role="alert">
                            {failure}
                        </p>
                    ) : null}
                    {/* type="button" throughout: a submitting form would be blocked by form-action 'none'. */}
                    <div className="picker-actions">
                        <button type="button" onClick={close} disabled={saving}>
                            Cancel
                        </button>
                        <button type="button" className="primary" disabled={saving} onClick={() => void start()}>
                            {saving ? 'Opening Linear…' : LINEAR_SUBMIT_LABEL}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
