import { useRef, type ReactNode } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

/**
 * The shell of the confirmation dialogs (`TaskRemoveDialog`, `OrgExecutorConfirmDialog`,
 * `JiraWriteConsentDialog`): the shared `dialog` panel at the remove dialog's width, `initialFocus`
 * on Cancel so the consequential answer is never the first thing a keypress reaches, and no
 * dismissal mid-request (`busy` also disables both buttons). `children` is everything between the
 * title and the buttons — the caller owns the body element, so its accessible description stays
 * its own. Presentational — the caller owns the write.
 */
export function ConfirmDialog({
    open,
    busy,
    title,
    children,
    confirmClassName,
    confirmText,
    confirmDisabled = false,
    onClose,
    onConfirm,
}: {
    open: boolean;
    /** The in-flight guard: the mutation is one request, and it cannot be dismissed. */
    busy: boolean;
    title: ReactNode;
    children: ReactNode;
    /** `chat-remove` for a destructive answer, `primary` otherwise. */
    confirmClassName: string;
    confirmText: ReactNode;
    /** The answer is not yet askable (an empty field): the confirm button stays dark. */
    confirmDisabled?: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    return (
        <Dialog
            open={open}
            onClose={() => {
                if (!busy) onClose();
            }}
            className="dialog-layer"
            initialFocus={cancelRef}
        >
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="dialog task-remove">
                    {/* The page's one h1 is the header's; a dialog title is an h2. */}
                    <DialogTitle as="h2" className="task-remove-title">
                        {title}
                    </DialogTitle>
                    {children}
                    <div className="task-remove-actions">
                        <button ref={cancelRef} type="button" className="chat-resume" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button
                            type="button"
                            className={confirmClassName}
                            onClick={onConfirm}
                            disabled={busy || confirmDisabled}
                        >
                            {confirmText}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
