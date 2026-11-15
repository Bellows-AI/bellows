import { Description } from '@headlessui/react';
import type { ConnectionView } from '../api/connections.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export const WRITE_CONSENT_TITLE = 'Allow adding comments';
/** The comment-access choice wherever a connection is asked for: a connect dialog, a setup card, a row action. */
export const ALLOW_COMMENTS_LABEL = 'Allow adding comments';
/** What the comment-access choice changes, for a provider by its catalog name. */
export const commentsHelp = (label: string): string =>
    `Without it tasks can only look ${label} up; with it they can also add comments.`;

/**
 * The confirmation before a read connection asks the provider for comment access, in the
 * `OrgExecutorConfirmDialog` shape. `authority` names whose consent screen the member is sent to
 * (`consentAuthority`). It states the consequence the board enforces: granting write on a grant
 * makes the tasks earlier bound read-only to that account refuse. Presentational — the section
 * starts the reconnect.
 */
export function WriteConsentDialog({
    connection,
    authority,
    busy,
    onClose,
    onConfirm,
}: {
    connection: ConnectionView | null;
    authority: string;
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
            confirmText={busy ? `Opening ${authority}…` : `Continue to ${authority}`}
            onClose={onClose}
            onConfirm={onConfirm}
        >
            <Description as="p">
                {authority} will ask {connection?.account ?? 'you'} to approve adding comments. Once granted, read-bound
                tasks of this account will be refused until they are started again with the new access.
            </Description>
        </ConfirmDialog>
    );
}
