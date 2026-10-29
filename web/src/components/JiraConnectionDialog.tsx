import { useEffect, useId, useRef, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import type { StartAuthorizationInput } from '../api/connections.js';

export const CONNECT_DIALOG_TITLE = 'Connect Jira';
export const CONNECT_SUBMIT_LABEL = 'Continue to Atlassian';
export const ALLOW_COMMENTS_LABEL = 'Allow adding comments';
export const SITE_HELP =
    'Leave blank to connect every site the Atlassian account can reach, or name one, as example.atlassian.net.';
export const COMMENTS_HELP = 'Without it tasks can only look Jira up; with it they can also add comments.';

/**
 * Connect Jira: an optional site and the comment-access checkbox stacked one per row in the
 * executor dialog's field layout. Headless UI owns the focus trap, Escape, the backdrop and focus
 * restoration; no `<form>` because the CSP sends `form-action 'none'`. Nothing secret is typed
 * here: the consent happens at Atlassian, so a refusal (the 503 naming the operator's missing
 * configuration, a malformed site) keeps the dialog and shows the route's message as sent, and a
 * start that succeeds leaves the page for the consent screen.
 */
export function JiraConnectionDialog({
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
    const [site, setSite] = useState('');
    const [comments, setComments] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const ids = useId();
    const siteRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) {
            setSite('');
            setComments(false);
            setFailure(null);
        }
    }, [open]);

    const close = () => {
        if (!saving) onClose();
    };
    const start = async () => {
        const trimmed = site.trim();
        setFailure(await onStart({ access: comments ? 'write' : 'read', ...(trimmed ? { site: trimmed } : {}) }));
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            className="dialog-layer"
            aria-labelledby={`${ids}-title`}
            initialFocus={siteRef}
        >
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="dialog picker">
                    <DialogTitle as="h2" id={`${ids}-title`}>
                        {CONNECT_DIALOG_TITLE}
                    </DialogTitle>

                    <div className="picker-field">
                        <label htmlFor={`${ids}-site`}>Jira site (optional)</label>
                        <input
                            ref={siteRef}
                            id={`${ids}-site`}
                            className="field"
                            type="text"
                            placeholder="example.atlassian.net"
                            value={site}
                            disabled={saving}
                            aria-describedby={`${ids}-site-help`}
                            onChange={(e) => setSite(e.target.value)}
                        />
                        <p className="picker-help" id={`${ids}-site-help`}>
                            {SITE_HELP}
                        </p>
                    </div>

                    <div className="picker-field">
                        <label className="settings-toggle" htmlFor={`${ids}-comments`}>
                            <input
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
                            {COMMENTS_HELP}
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
                            {saving ? 'Opening Atlassian…' : CONNECT_SUBMIT_LABEL}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
