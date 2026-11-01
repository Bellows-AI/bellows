import { useRef } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle, Description } from '@headlessui/react';
import type { ConnectionView } from '../api/connections.js';

/**
 * The confirmation before a connection is disconnected, in `TaskRemoveDialog`'s shape: ownership-changing verbs
 * confirm before they write. Focus starts on Cancel; mid-request the dialog cannot be dismissed. Presentational: the
 * page sends the DELETE and owns the refusal.
 */
export function ConnectionDisconnectDialog({
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
                        Disconnect {connection?.site}?
                    </DialogTitle>
                    <Description as="p">
                        Tasks will no longer reach {connection?.site} as {connection?.account}. You can connect it again
                        later.
                    </Description>
                    <div className="task-remove-actions">
                        <button ref={cancelRef} type="button" className="chat-resume" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="button" className="chat-remove" onClick={onConfirm} disabled={busy}>
                            {busy ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
