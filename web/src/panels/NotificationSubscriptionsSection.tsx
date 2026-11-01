import { useCallback, useEffect, useState } from 'react';
import { ADMIN_ROLE } from '@factory-ai/core';
import {
    createSubscription,
    deleteSubscription,
    listSubscriptions,
    sendTestNotification,
    testResultMessage,
    updateSubscription,
    type SubscriptionInput,
    type SubscriptionScope,
    type SubscriptionView,
} from '../api/notificationSubscriptions.js';
import type { Session } from '../api/useSession.js';
import {
    DeleteSubscriptionDialog,
    NotificationSubscriptionDialog,
} from '../components/NotificationSubscriptionDialog.js';
import { NotificationSubscriptionsPanel, type TestOutcome } from './NotificationSubscriptionsPanel.js';

const COPY: Record<SubscriptionScope, { heading: string; tableLabel: string; intro: string }> = {
    org: {
        heading: 'Organization notifications',
        tableLabel: 'Organization notification subscriptions',
        intro: 'Send task events to a channel for the whole organization. Each subscription picks the events, and can be limited to some repositories.',
    },
    workspace: {
        heading: 'My notifications',
        tableLabel: 'My notification subscriptions',
        intro: 'Updates for tasks you start and actions you take.',
    },
};

/** Where the dialog is: closed, adding, or editing this row. */
type Editing = { row: SubscriptionView | null } | null;

/**
 * One scope's notification subscriptions bound to their data:
 * the section owns the list, the writes, the test sends and both dialogs, the panel the markup.
 * The organization's rows are written by admins only (a member reads them); the member's own are
 * theirs on `/settings/workspace`. Every write re-reads the list, and a read that fails or does not
 * parse is an error with no Add button, never an empty table. `busy` is cleared on every outcome.
 */
export function NotificationSubscriptionsSection({
    session,
    scope,
}: {
    session: Session | null;
    scope: SubscriptionScope;
}) {
    const [subscriptions, setSubscriptions] = useState<SubscriptionView[] | null>(null);
    const [connectorKinds, setConnectorKinds] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [outcomes, setOutcomes] = useState<Record<string, TestOutcome>>({});
    const [editing, setEditing] = useState<Editing>(null);
    const [deleting, setDeleting] = useState<SubscriptionView | null>(null);

    const refresh = useCallback(async () => {
        const listed = await listSubscriptions(scope);
        if (!listed.ok) {
            setSubscriptions(null);
            setError(listed.error);
            return;
        }
        setSubscriptions(listed.subscriptions);
        setConnectorKinds(listed.connectorKinds);
    }, [scope]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    /** Runs one action with `busy` set, cleared whatever it comes to. */
    const run = async <T,>(action: () => Promise<T>): Promise<T> => {
        setBusy(true);
        try {
            return await action();
        } finally {
            setBusy(false);
        }
    };

    /** A write, then the re-read; resolves to the refusal's message or null. */
    const write = (action: () => Promise<string | null>) =>
        run(async () => {
            const message = await action();
            if (message === null) {
                setError(null);
                await refresh();
            }
            return message;
        });

    const submit = async (input: SubscriptionInput): Promise<string | null> => {
        const row = editing?.row ?? null;
        const message = await write(() =>
            row ? updateSubscription(scope, row.id, input) : createSubscription(scope, input)
        );
        if (message === null) setEditing(null);
        return message;
    };

    const toggle = async (row: SubscriptionView) => {
        // The credential stays where it is: a full body without one keeps the stored webhook.
        const { id: _id, createdAt: _created, updatedAt: _updated, ...fields } = row;
        const message = await write(() => updateSubscription(scope, row.id, { ...fields, enabled: !row.enabled }));
        if (message !== null) setError(message);
    };

    const remove = async (row: SubscriptionView) => {
        const message = await write(() => deleteSubscription(scope, row.id));
        if (message !== null) setError(message);
        setDeleting(null);
    };

    const test = (row: SubscriptionView) =>
        run(async () => {
            setError(null);
            setOutcomes(({ [row.id]: _previous, ...rest }) => rest);
            const sent = await sendTestNotification(scope, row.id);
            let outcome: TestOutcome = { message: sent.ok ? '' : sent.error, tone: 'bad' };
            if (sent.ok) {
                const { result } = sent;
                outcome = {
                    message: testResultMessage(result),
                    tone: result.status === 'delivered' ? 'info' : result.status === 'retryable' ? 'warn' : 'bad',
                };
            }
            setOutcomes((now) => ({ ...now, [row.id]: outcome }));
        });

    if (session === null) return null;
    const copy = COPY[scope];

    if (subscriptions === null) {
        return (
            <section className="panel" aria-label={copy.heading}>
                <h2>{copy.heading}</h2>
                {error ? (
                    <p className="status" role="alert">
                        {error}
                    </p>
                ) : (
                    <p className="status">Loading notifications…</p>
                )}
            </section>
        );
    }

    return (
        <>
            <NotificationSubscriptionsPanel
                {...copy}
                subscriptions={subscriptions}
                canWrite={scope === 'workspace' || session.role === ADMIN_ROLE}
                busy={busy}
                error={error}
                outcomes={outcomes}
                onAdd={() => setEditing({ row: null })}
                onEdit={(row) => setEditing({ row })}
                onTest={(row) => void test(row)}
                onToggle={(row) => void toggle(row)}
                onDelete={setDeleting}
            />
            <NotificationSubscriptionDialog
                open={editing !== null}
                editing={editing?.row ?? null}
                connectorKinds={connectorKinds}
                busy={busy}
                onClose={() => setEditing(null)}
                onSubmit={submit}
            />
            <DeleteSubscriptionDialog
                target={deleting}
                busy={busy}
                onClose={() => setDeleting(null)}
                onConfirm={() => {
                    if (deleting) void remove(deleting);
                }}
            />
        </>
    );
}
