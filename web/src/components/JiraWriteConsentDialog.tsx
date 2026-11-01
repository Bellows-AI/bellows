import { Description } from '@headlessui/react';
import type { ConnectionView } from '../api/connections.js';
import { ConfirmDialog } from './ConfirmDialog.js';

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
    return (
        <ConfirmDialog
            open={connection !== null}
            busy={busy}
            title={WRITE_CONSENT_TITLE}
            confirmClassName="primary"
            confirmText={busy ? 'Opening Atlassian…' : 'Continue to Atlassian'}
            onClose={onClose}
            onConfirm={onConfirm}
        >
            <Description as="p">
                Atlassian will ask {connection?.account ?? 'you'} to approve adding comments. Once granted, read-bound
                tasks of this account will be refused until they are started again with the new access.
            </Description>
        </ConfirmDialog>
    );
}
