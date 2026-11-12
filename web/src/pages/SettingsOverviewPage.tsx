import { Link } from 'react-router-dom';
import { roleLabel } from '../api/useSession.js';
import { Icon, type IconName } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';
import {
    deriveReadiness,
    type ReadinessItem,
    type ReadinessItemId,
    type ReadinessTone,
} from '../settings/readiness.js';
import { useSettingsPage } from './SettingsLayout.js';
import { StateNote } from '../components/StateNote.js';

/** A row's status: attention is the bad pill and pending the warning pill; a settled answer (ok, or a
 * neutral info fact) is plain text, because a calm row does not need a lamp. */
const STATUS_CLASS: Record<ReadinessTone, string> = {
    ok: 'settings-row-status',
    info: 'settings-row-status',
    attention: 'settings-row-status pill pill-bad',
    pending: 'settings-row-status pill pill-warn',
};

const ROW_ICON: Record<ReadinessItemId, IconName> = {
    organization: 'users',
    workspace: 'terminal',
    repositories: 'repo',
    executors: 'sliders',
    environment: 'layers',
};

/** Presentation only: `deriveReadiness` keeps its order, the page just sorts it into two groups. */
const GROUPS: { title: string; ids: ReadinessItemId[] }[] = [
    { title: 'General', ids: ['organization', 'workspace'] },
    { title: 'Development', ids: ['repositories', 'executors', 'environment'] },
];

/** One row: the icon, heading, value and chevron are a single link when the item has a destination.
 * Facts that are themselves links (the environment's per-scope edits) sit after it as siblings, so no
 * anchor ever holds another interactive element. */
function SettingsRow({ item }: { item: ReadinessItem }) {
    const headingId = `settings-row-${item.id}`;
    const statusId = `${headingId}-status`;
    const plain = item.facts.filter((fact) => !fact.link);
    const linked = item.facts.filter((fact) => fact.link);
    const body = (
        <>
            <span className="settings-row-icon">
                <Icon name={ROW_ICON[item.id]} />
            </span>
            <span className="settings-row-text">
                <h3 id={headingId}>{item.heading}</h3>
                <p className={STATUS_CLASS[item.tone]} id={statusId}>
                    {item.status}
                </p>
                {plain.map((fact) => (
                    <span key={fact.text} className="settings-row-fact">
                        {fact.text}
                    </span>
                ))}
            </span>
        </>
    );
    return (
        <li className="settings-row-item">
            {item.action ? (
                <Link
                    className="settings-row"
                    to={item.action.to}
                    aria-labelledby={headingId}
                    aria-describedby={statusId}
                >
                    {body}
                    <span className="settings-row-chevron">
                        <Icon name="chevron-right" />
                    </span>
                </Link>
            ) : (
                <div className="settings-row">{body}</div>
            )}
            {linked.length > 0 ? (
                <ul className="settings-row-scopes">
                    {linked.map((fact) => (
                        <li key={fact.text}>
                            {fact.text}
                            {fact.link ? (
                                <>
                                    {' — '}
                                    <Link to={fact.link.to}>{fact.link.label}</Link>
                                </>
                            ) : null}
                        </li>
                    ))}
                </ul>
            ) : null}
        </li>
    );
}

/**
 * The settings tree's index (issue 180): what is configured for this organization and this
 * member's workspace, read from the reads `SettingsLayout` already owns — the page itself
 * starts no request of any kind. Notably absent: an executor-config read (those carry credentials
 * and are fetched only when the dialog opens).
 *
 * Every row with a destination is one link named by its heading — there is no generic top-level Fix button.
 * Status is text, the tone class is decoration; and nothing here is a live region, because the
 * workspace poll updates these items and a polite announcement per tick is noise, not information
 * (the `countLabel` precedent in nav-model.ts).
 *
 * A later poll failure keeps the last-good items on screen and renders the error as its own
 * `.status` line below. On an INITIAL failure the item's own fact names the error, so the page
 * does not repeat it.
 */
export function SettingsOverviewPage() {
    const { session, workspace, repos, env } = useSettingsPage();
    const items = deriveReadiness({ session, workspace, repos, environment: env });
    const byId = new Map(items.map((item) => [item.id, item]));
    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="Overview"
                meta={
                    session ? (
                        // Identity, not authority: the display name and the role title, said once. No
                        // internal id, and no powers the API does not grant the role.
                        <p className="muted">
                            {session.organization.name} · {roleLabel(session.role)}
                        </p>
                    ) : (
                        <p className="muted">Checking your session…</p>
                    )
                }
            />

            {GROUPS.map((group) => (
                <section key={group.title} className="settings-group" aria-labelledby={`settings-group-${group.title}`}>
                    <h2 id={`settings-group-${group.title}`}>{group.title}</h2>
                    <ul className="settings-rows">
                        {group.ids.map((id) => {
                            const item = byId.get(id);
                            return item ? <SettingsRow key={id} item={item} /> : null;
                        })}
                    </ul>
                </section>
            ))}

            {/* Stale-data warnings only: with no data at all, each item's fact already names the
                error, and a second line would say it twice. */}
            {workspace.error && workspace.data ? <StateNote state="error">{workspace.error}</StateNote> : null}
            {env.error && env.data ? <StateNote state="error">{env.error}</StateNote> : null}
        </>
    );
}
