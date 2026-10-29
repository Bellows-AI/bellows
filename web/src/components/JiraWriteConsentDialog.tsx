import { useRef } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Description } from '@headlessui/react';
import type { ConnectionView } from '../api/connections.js';

export const WRITE_CONSENT_TITLE = 'Allow adding comments';

/**
 * The confirmation before a read connection asks Atlassian for comment access, in the
 * `OrgExecutorConfirmDialog` shape. It states the consequence the board enforces: granting write
 * on a grant makes the tasks earlier bound read-only to that account refuse. Presentational —
 * the section starts the reconnect.
 */
export function JiraWriteConsentDialog({
    connection,
    busy,
    onClose,
    onConfirm,
}: {
    connection: ConnectionView | null;
    busy: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    return (
        <Dialog
            open={connection !== null}
            onClose={() => {
                if (!busy) onClose();
            }}
            className="dialog-layer"
            initialFocus={cancelRef}
        >
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="dialog task-remove">
                    <DialogTitle as="h2" className="task-remove-title">
                        {WRITE_CONSENT_TITLE}
                    </DialogTitle>
                    <Description as="p">
                        Atlassian will ask {connection?.account ?? 'you'} to approve adding comments. Once granted,
                        read-bound tasks of this account will be refused until they are started again with the new
                        access.
                    </Description>
                    <div className="task-remove-actions">
                        <button ref={cancelRef} type="button" className="chat-resume" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="button" className="primary" onClick={onConfirm} disabled={busy}>
                            {busy ? 'Opening Atlassian…' : 'Continue to Atlassian'}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
