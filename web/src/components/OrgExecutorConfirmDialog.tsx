import { ConfirmDialog } from './ConfirmDialog.js';
import {
    confirmBody,
    confirmBusyLabel,
    confirmLabel,
    confirmTitle,
    type ConfirmRequest,
} from '../panels/org-executor-confirm.js';

/**
 * The accessible face of the org executor row's Delete and Make personal (issue 411), in the
 * TaskRemoveDialog shape: the shared `dialog` panel at the remove dialog's
 * width, `initialFocus` on Cancel so the ownership-changing answer is never the first thing a
 * keypress reaches, and no dismissal mid-request. Presentational — the section owns the write.
 */
export function OrgExecutorConfirmDialog({
    confirm,
    busy,
    onClose,
    onConfirm,
    defaults,
}: {
    /** The pending action and the row it names, or null when nothing is pending. */
    confirm: ConfirmRequest | null;
    /** The in-flight guard: the mutation is one request, and it cannot be dismissed. */
    busy: boolean;
    onClose: () => void;
    onConfirm: () => void;
    /**
     * Set once the board refused because defaults still name the executor: its sentence (counts, no members), and the
     * explicit choice the write needs — clear them, or re-point them at another organization executor.
     */
    defaults?: {
        refusal: string;
        choice: string;
        options: readonly { value: string; label: string }[];
        onChoice: (value: string) => void;
    } | null;
}) {
    return (
        <ConfirmDialog
            open={confirm !== null}
            busy={busy}
            title={confirm ? confirmTitle(confirm) : ''}
            // Only the delete is destructive. A red "Make personal" would overstate a scope move an
            // admin can undo by promoting the row back.
            confirmClassName={confirm?.action === 'demote' ? 'primary' : 'chat-remove'}
            confirmText={confirm ? (busy ? confirmBusyLabel(confirm) : confirmLabel(confirm)) : ''}
            confirmDisabled={defaults ? defaults.choice === '' : false}
            onClose={onClose}
            onConfirm={onConfirm}
        >
            <p>{confirm ? confirmBody(confirm) : ''}</p>
            {defaults ? (
                <>
                    <p role="alert">{defaults.refusal}</p>
                    <label className="field">
                        <span>What happens to those defaults</span>
                        <select value={defaults.choice} onChange={(event) => defaults.onChoice(event.target.value)}>
                            <option value="">Choose…</option>
                            {defaults.options.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                </>
            ) : null}
        </ConfirmDialog>
    );
}
