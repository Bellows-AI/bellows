import { channelLabel, EVENT_KIND_LABELS, type SubscriptionView } from '../api/notificationSubscriptions.js';
import { Icon, type IconName } from '../components/Icon.js';
import { ProviderMark } from '../components/ProviderMark.js';
import { RowActions } from '../components/RowActions.js';

export const ADD_SUBSCRIPTION_LABEL = 'Add notification';
export const SEND_TEST_LABEL = 'Send test notification';
export const MEMBER_NOTE = "Organization notifications are managed by your organization's admins.";
export const NO_SUBSCRIPTIONS_NOTE = 'No notifications yet.';

/** A row's last test verdict: the sentence and the banner it is shown in (`info` delivered, `warn` retryable, `bad` refused or failed). */
export interface TestOutcome {
    message: string;
    tone: 'info' | 'warn' | 'bad';
}

const OUTCOME_ICON = { info: 'info', warn: 'alert-triangle', bad: 'alert-circle' } as const;

const eventsOf = (row: SubscriptionView) => row.eventKinds.map((kind) => EVENT_KIND_LABELS[kind]).join(', ');
const rowName = (row: SubscriptionView) => `${channelLabel(row.connectorKind)} for ${eventsOf(row)}`;

/** An event's tag: its icon and tone. Purple is the Question tag's alone; an admin action stays neutral. */
const EVENT_TAGS: Record<SubscriptionView['eventKinds'][number], { icon: IconName; tone: string }> = {
    'task.ready': { icon: 'check-circle', tone: 'pill pill-ok' },
    'task.blocked': { icon: 'alert-triangle', tone: 'pill pill-warn' },
    'task.question': { icon: 'info', tone: 'pill pill-question' },
    'task.admin_action': { icon: 'users', tone: 'pill' },
};

/**
 * One scope's notification subscriptions: a row per channel with its events, repo filter, the
 * Enabled switch and, for a caller who can write, `RowActions` (Send test
 * notification inline, Edit and Delete in the menu). Presentational, like `JiraConnectionsPanel` —
 * the section owns the list, the writes and the dialogs. No row has a place to show a webhook.
 */
export function NotificationSubscriptionsPanel({
    heading,
    tableLabel,
    intro,
    subscriptions,
    canWrite,
    busy,
    error,
    outcomes,
    onAdd,
    onEdit,
    onTest,
    onToggle,
    onDelete,
}: {
    heading: string;
    tableLabel: string;
    intro: string;
    /** The scope's rows, as the last confirmed read gave them. */
    subscriptions: readonly SubscriptionView[];
    canWrite: boolean;
    /** A write or a test send is in flight: every control waits. */
    busy: boolean;
    /** A write failure, announced beside the rows it concerns. */
    error: string | null;
    /** The latest test verdict of each row, by id. */
    outcomes: Readonly<Record<string, TestOutcome>>;
    onAdd: () => void;
    onEdit: (row: SubscriptionView) => void;
    onTest: (row: SubscriptionView) => void;
    onToggle: (row: SubscriptionView) => void;
    onDelete: (row: SubscriptionView) => void;
}) {
    const shown = subscriptions.filter((row) => outcomes[row.id]);
    return (
        <section className="panel" aria-label={heading}>
            <div className="panel-head">
                <h2>
                    {heading}
                    <span className="count">{subscriptions.length}</span>
                </h2>
                {canWrite ? (
                    <button type="button" className="notification-subscription-add" disabled={busy} onClick={onAdd}>
                        <Icon name="plus" />
                        {ADD_SUBSCRIPTION_LABEL}
                    </button>
                ) : null}
            </div>
            <p className="muted">{intro}</p>
            {canWrite ? null : <p className="muted">{MEMBER_NOTE}</p>}
            {error ? (
                <p className="status" role="alert">
                    {error}
                </p>
            ) : null}
            {subscriptions.length === 0 ? (
                <p className="muted">{NO_SUBSCRIPTIONS_NOTE}</p>
            ) : (
                <section className="table-wrap">
                    <table className="data data-compact table-cards" aria-label={tableLabel}>
                        <thead>
                            <tr>
                                <th scope="col">Channel</th>
                                <th scope="col">Events</th>
                                <th scope="col">Repos</th>
                                <th scope="col">Enabled</th>
                                {canWrite ? (
                                    <th scope="col">
                                        <span className="visually-hidden">Actions</span>
                                    </th>
                                ) : null}
                            </tr>
                        </thead>
                        <tbody>
                            {subscriptions.map((row) => (
                                <tr key={row.id}>
                                    <td data-label="Channel">
                                        <ProviderMark provider={row.connectorKind} decorative />
                                        {channelLabel(row.connectorKind)}
                                    </td>
                                    <td data-label="Events">
                                        <div className="pill-list">
                                            {row.eventKinds.map((kind) => (
                                                <span key={kind} className={EVENT_TAGS[kind].tone}>
                                                    <Icon name={EVENT_TAGS[kind].icon} size={14} />
                                                    {EVENT_KIND_LABELS[kind]}
                                                </span>
                                            ))}
                                        </div>
                                    </td>
                                    <td data-label="Repos">
                                        <div className="pill-list">
                                            {row.repos.length === 0 ? (
                                                <span className="pill">
                                                    <Icon name="git-branch" size={14} />
                                                    All repositories
                                                </span>
                                            ) : (
                                                row.repos.map((repo) => (
                                                    <span key={repo} className="pill" title={repo}>
                                                        {repo}
                                                    </span>
                                                ))
                                            )}
                                        </div>
                                    </td>
                                    <td data-label="Enabled">
                                        <label className="settings-toggle">
                                            <input
                                                type="checkbox"
                                                role="switch"
                                                aria-checked={row.enabled}
                                                className="switch"
                                                checked={row.enabled}
                                                disabled={!canWrite || busy}
                                                aria-label={`Enabled, ${rowName(row)}`}
                                                onChange={() => onToggle(row)}
                                            />
                                        </label>
                                    </td>
                                    {canWrite ? (
                                        <td data-label="Actions">
                                            <RowActions
                                                rowName={rowName(row)}
                                                primary={{ label: SEND_TEST_LABEL, onSelect: () => onTest(row) }}
                                                actions={[
                                                    { label: 'Edit', onSelect: () => onEdit(row) },
                                                    { label: 'Delete', onSelect: () => onDelete(row), danger: true },
                                                ]}
                                                disabled={busy}
                                            />
                                        </td>
                                    ) : null}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </section>
            )}
            {shown.map((row) => {
                const outcome = outcomes[row.id]!;
                return (
                    <div
                        key={row.id}
                        className={`banner-${outcome.tone}`}
                        role={outcome.tone === 'info' ? 'status' : 'alert'}
                    >
                        <Icon name={OUTCOME_ICON[outcome.tone]} size={24} />
                        <p>
                            <span className="muted">{`${channelLabel(row.connectorKind)} · ${row.repos.join(', ') || 'all repos'}:`}</span>{' '}
                            <span>{outcome.message}</span>
                        </p>
                    </div>
                );
            })}
        </section>
    );
}
