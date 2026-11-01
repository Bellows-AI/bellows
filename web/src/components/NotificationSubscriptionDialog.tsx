import { useEffect, useId, useRef, useState } from 'react';
import { Description, Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { NOTIFICATION_KINDS, type NotificationKind } from '@factory-ai/core';
import {
    channelLabel,
    EVENT_KIND_LABELS,
    type SubscriptionInput,
    type SubscriptionView,
} from '../api/notificationSubscriptions.js';

export const ADD_DIALOG_TITLE = 'Add notification';
export const EDIT_DIALOG_TITLE = 'Edit notification';
export const DELETE_DIALOG_TITLE = 'Delete notification';
export const WEBHOOK_REQUIRED = 'Enter the webhook URL for this channel.';
export const NEW_CHANNEL_NEEDS_WEBHOOK =
    'A new channel needs its own webhook URL: the stored one belongs to the old channel.';
export const EVENTS_REQUIRED = 'Choose at least one event.';
const WEBHOOK_HELP_EDIT = 'Leave blank to keep the stored webhook. It is never shown again after saving.';
const WEBHOOK_HELP_ADD = 'Stored encrypted and never shown again.';

/** What a new subscription listens to: the task events a person acts on; admin actions are opt-in. */
const DEFAULT_EVENTS: readonly NotificationKind[] = ['task.ready', 'task.blocked', 'task.question'];

const linesOf = (text: string): string[] => [
    ...new Set(
        text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
    ),
];

/**
 * Add or edit one notification subscription: channel, the write-only webhook, the events, the repo
 * and workflow filters (one per line, empty = all) and Enabled, stacked in the executor dialog's
 * field layout. Headless UI owns the focus trap and Escape; no `<form>` because the CSP sends
 * `form-action 'none'`. The webhook is a password input that starts blank even on edit: blank
 * keeps the stored one, except on a changed channel, which cannot. A refusal (the connector's
 * problems on a 400) shows in the dialog's alert, which stays open.
 */
export function NotificationSubscriptionDialog({
    open,
    editing,
    connectorKinds,
    busy,
    onClose,
    onSubmit,
}: {
    open: boolean;
    /** The row being edited, or null for a new one. */
    editing: SubscriptionView | null;
    /** The channel kinds the board can send through (the list's `connectorKinds`). */
    connectorKinds: readonly string[];
    busy: boolean;
    onClose: () => void;
    /** Resolves to the refusal message, or null when saved. */
    onSubmit: (input: SubscriptionInput) => Promise<string | null>;
}) {
    const [kind, setKind] = useState('');
    const [webhook, setWebhook] = useState('');
    const [events, setEvents] = useState<readonly NotificationKind[]>([]);
    const [repos, setRepos] = useState('');
    const [workflows, setWorkflows] = useState('');
    const [enabled, setEnabled] = useState(true);
    const [failure, setFailure] = useState<string | null>(null);
    const ids = useId();
    const firstRef = useRef<HTMLSelectElement>(null);

    useEffect(() => {
        if (!open) return;
        setKind(editing?.connectorKind ?? connectorKinds[0] ?? '');
        setWebhook('');
        setEvents(editing?.eventKinds ?? DEFAULT_EVENTS);
        setRepos(editing?.repos.join('\n') ?? '');
        setWorkflows(editing?.workflows.join('\n') ?? '');
        setEnabled(editing?.enabled ?? true);
        setFailure(null);
    }, [open, editing, connectorKinds]);

    const channels =
        editing && !connectorKinds.includes(editing.connectorKind)
            ? [editing.connectorKind, ...connectorKinds]
            : connectorKinds;
    const close = () => {
        if (!busy) onClose();
    };
    const toggleEvent = (event: NotificationKind) =>
        setEvents((now) => (now.includes(event) ? now.filter((e) => e !== event) : [...now, event]));

    const save = async () => {
        const secret = webhook.trim();
        const kindChanged = editing !== null && editing.connectorKind !== kind;
        if (secret === '' && editing === null) return setFailure(WEBHOOK_REQUIRED);
        if (secret === '' && kindChanged) return setFailure(NEW_CHANNEL_NEEDS_WEBHOOK);
        if (events.length === 0) return setFailure(EVENTS_REQUIRED);
        setFailure(null);
        const message = await onSubmit({
            connectorKind: kind,
            connectorConfig: editing && !kindChanged ? editing.connectorConfig : {},
            ...(secret === '' ? {} : { credential: secret }),
            eventKinds: NOTIFICATION_KINDS.filter((event) => events.includes(event)),
            repos: linesOf(repos),
            workflows: linesOf(workflows),
            enabled,
        });
        setFailure(message);
    };

    return (
        <Dialog
            open={open}
            onClose={close}
            className="dialog-layer"
            aria-labelledby={`${ids}-title`}
            initialFocus={firstRef}
        >
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="dialog picker">
                    <DialogTitle as="h2" id={`${ids}-title`}>
                        {editing ? EDIT_DIALOG_TITLE : ADD_DIALOG_TITLE}
                    </DialogTitle>

                    <div className="picker-field">
                        <label htmlFor={`${ids}-kind`}>Channel</label>
                        <select
                            ref={firstRef}
                            id={`${ids}-kind`}
                            className="field"
                            value={kind}
                            disabled={busy}
                            onChange={(e) => setKind(e.target.value)}
                        >
                            {channels.map((channel) => (
                                <option key={channel} value={channel}>
                                    {channelLabel(channel)}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="picker-field">
                        <label htmlFor={`${ids}-webhook`}>Webhook URL</label>
                        <input
                            id={`${ids}-webhook`}
                            className="field"
                            type="password"
                            autoComplete="off"
                            value={webhook}
                            disabled={busy}
                            aria-describedby={`${ids}-webhook-help`}
                            onChange={(e) => setWebhook(e.target.value)}
                        />
                        <p className="picker-help" id={`${ids}-webhook-help`}>
                            {editing ? WEBHOOK_HELP_EDIT : WEBHOOK_HELP_ADD}
                        </p>
                    </div>

                    <fieldset className="picker-field">
                        <legend>Events</legend>
                        {NOTIFICATION_KINDS.map((event) => (
                            <label key={event} className="settings-toggle">
                                <input
                                    type="checkbox"
                                    checked={events.includes(event)}
                                    disabled={busy}
                                    onChange={() => toggleEvent(event)}
                                />
                                {EVENT_KIND_LABELS[event]}
                            </label>
                        ))}
                    </fieldset>

                    <div className="picker-field">
                        <label htmlFor={`${ids}-repos`}>Repositories (one per line, empty for all)</label>
                        <textarea
                            id={`${ids}-repos`}
                            className="field"
                            rows={3}
                            placeholder="owner/name"
                            value={repos}
                            disabled={busy}
                            onChange={(e) => setRepos(e.target.value)}
                        />
                    </div>

                    <div className="picker-field">
                        <label htmlFor={`${ids}-workflows`}>Workflows (one per line, empty for all)</label>
                        <textarea
                            id={`${ids}-workflows`}
                            className="field"
                            rows={3}
                            value={workflows}
                            disabled={busy}
                            onChange={(e) => setWorkflows(e.target.value)}
                        />
                    </div>

                    <div className="picker-field">
                        <label className="settings-toggle" htmlFor={`${ids}-enabled`}>
                            <input
                                id={`${ids}-enabled`}
                                type="checkbox"
                                checked={enabled}
                                disabled={busy}
                                onChange={(e) => setEnabled(e.target.checked)}
                            />
                            Enabled
                        </label>
                    </div>

                    {failure ? (
                        <p className="status" role="alert">
                            {failure}
                        </p>
                    ) : null}
                    {/* type="button" throughout: a submitting form would be blocked by form-action 'none'. */}
                    <div className="picker-actions">
                        <button type="button" onClick={close} disabled={busy}>
                            Cancel
                        </button>
                        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
                            {busy ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}

/**
 * The confirmation before a subscription is deleted, in the `JiraWriteConsentDialog` shape. Deleting
 * also retires the stored webhook, so it is not undoable. Presentational — the section deletes.
 */
export function DeleteSubscriptionDialog({
    target,
    busy,
    onClose,
    onConfirm,
}: {
    target: SubscriptionView | null;
    busy: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const cancelRef = useRef<HTMLButtonElement>(null);
    return (
        <Dialog
            open={target !== null}
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
                        {DELETE_DIALOG_TITLE}
                    </DialogTitle>
                    <Description as="p">
                        {target
                            ? `${channelLabel(target.connectorKind)} stops receiving these events, and its stored webhook is discarded. This cannot be undone.`
                            : ''}
                    </Description>
                    <div className="task-remove-actions">
                        <button ref={cancelRef} type="button" className="chat-resume" onClick={onClose} disabled={busy}>
                            Cancel
                        </button>
                        <button type="button" className="primary" onClick={onConfirm} disabled={busy}>
                            {busy ? 'Deleting…' : 'Delete'}
                        </button>
                    </div>
                </DialogPanel>
            </div>
        </Dialog>
    );
}
