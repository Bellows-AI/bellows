import { ADMIN_ROLE } from '@factory-ai/core';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { type ForgeStanding, type GitlabGrantView, useGitlabGrants } from '../api/forgeGrants.js';
import {
    deleteGitlabConnection,
    type GitlabConnectionView,
    startGitlabActivation,
    startGitlabLink,
    useGitlabConnections,
} from '../api/gitlab.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { IntegrationNoticeBanner } from '../components/IntegrationNoticeBanner.js';
import { PageHeader } from '../components/PageHeader.js';
import { StateNote } from '../components/StateNote.js';
import { GitlabConnectForm } from '../panels/GitlabConnectForm.js';
import { GitlabTracking } from '../panels/GitlabTracking.js';
import type { IntegrationNotice } from '../settings/integration-providers.js';
import { useSettingsPage } from './SettingsLayout.js';

/** The instance version below which a connection is refused, as the board states it (docs/gitlab.md). */
const MINIMUM_VERSION = '17.0';
/** The one redirect URI registered on every application (`GITLAB_CALLBACK_PATH` on the server). */
const CALLBACK_PATH = '/api/forge-grants/gitlab/callback';
const GITLAB_RESULT = 'gitlab';

/** What the callback's `?result=` says; any other value is a failure. */
const RESULT_NOTICE: Record<string, IntegrationNotice> = {
    linked: { message: 'GitLab account linked.', tone: 'info' },
    activated: { message: 'GitLab connection activated.', tone: 'info' },
    'version-too-old': {
        message: `That GitLab is older than ${MINIMUM_VERSION}, so it stays pending. Upgrade the instance and activate it again.`,
        tone: 'bad',
    },
    unconfirmed: {
        message: 'GitLab could not be reached to confirm the connection. Nothing changed; try again shortly.',
        tone: 'warn',
    },
};

const noticeOf = (integration: string | null, result: string | null): IntegrationNotice | null => {
    if (integration !== GITLAB_RESULT || !result) return null;
    return RESULT_NOTICE[result] ?? { message: `GitLab sign-in failed (${result}).`, tone: 'bad' };
};

const STANDING: Record<ForgeStanding, { pill: { text: string; className: string }; action: string | null }> = {
    live: { pill: { text: 'Linked', className: 'pill pill-ok' }, action: null },
    broken: { pill: { text: 'Needs reconnect', className: 'pill pill-accent' }, action: 'Reconnect GitLab account' },
    missing: { pill: { text: 'Not linked', className: 'pill' }, action: 'Link GitLab account' },
};

/** One OAuth start: the browser leaves on success; a refusal's sentence is returned for the caller to show. */
async function leaveFor(start: Promise<Awaited<ReturnType<typeof startGitlabLink>>>): Promise<string | null> {
    const started = await start;
    if (!started.ok) return started.error;
    window.location.assign(started.authorizeUrl);
    return null;
}

/** The member's own account on one active connection: link, or reconnect once the grant broke. */
function AccountRow({ grant, onError }: { grant: GitlabGrantView; onError: (message: string) => void }) {
    const [busy, setBusy] = useState(false);
    const words = STANDING[grant.standing];
    const act = async () => {
        setBusy(true);
        const message = await leaveFor(startGitlabLink(grant.id));
        if (message !== null) {
            onError(message);
            setBusy(false);
        }
    };
    return (
        <section className="integration-card" aria-label={`Your account on ${grant.host}`}>
            <span className="integration-card-text">
                <span className="integration-card-title">{grant.host}</span>
                <span className="integration-card-site">
                    {grant.standing === 'broken'
                        ? 'GitLab needs you to sign in again before tasks can act as you here.'
                        : grant.standing === 'missing'
                          ? 'Link your GitLab account to let tasks act as you here.'
                          : 'Tasks act as your GitLab account here.'}
                </span>
                {words.action ? (
                    <button type="button" disabled={busy} onClick={() => void act()}>
                        {words.action}
                    </button>
                ) : null}
            </span>
            <span className={words.pill.className}>{words.pill.text}</span>
        </section>
    );
}

const refusalSentence = (connection: GitlabConnectionView): string | null => {
    if (connection.active) return null;
    if (connection.activationRefusal === 'version-too-old') {
        const which = connection.version === null ? 'This GitLab' : `GitLab ${connection.version}`;
        return `${which} is older than ${MINIMUM_VERSION}, the minimum version. Upgrade the instance, then activate again.`;
    }
    if (connection.probe.status === 'unreachable') {
        return `The board could not reach this instance (${connection.probe.reason ?? 'unreachable'}). Nothing is refused; activation checks again.`;
    }
    return 'Waiting for an admin to activate it with their own GitLab account.';
};

/** An admin's connection: its state, activation, removal and, once active, the tracking picker. */
function ConnectionCard({
    connection,
    onRemove,
    onError,
}: {
    connection: GitlabConnectionView;
    onRemove: () => void;
    onError: (message: string) => void;
}) {
    const [busy, setBusy] = useState(false);
    const activate = async () => {
        setBusy(true);
        const message = await leaveFor(startGitlabActivation(connection.id));
        if (message !== null) {
            onError(message);
            setBusy(false);
        }
    };
    const refusal = refusalSentence(connection);
    return (
        <section className="panel" aria-label={connection.host}>
            <h2>{connection.host}</h2>
            <span className={connection.active ? 'pill pill-ok' : 'pill pill-accent'}>
                {connection.active ? 'Active' : 'Pending'}
            </span>
            <p className="muted">
                Application {connection.clientId} · groups {connection.allowedGroups.join(', ')}
                {connection.version ? ` · GitLab ${connection.version}` : ''}
                {connection.hasCaBundle ? ' · custom CA bundle' : ''}
            </p>
            {refusal ? <p className="status">{refusal}</p> : null}
            <div className="picker-actions">
                {connection.active ? null : (
                    <button type="button" className="primary" disabled={busy} onClick={() => void activate()}>
                        Activate
                    </button>
                )}
                <button type="button" className="chat-remove" disabled={busy} onClick={onRemove}>
                    Remove
                </button>
            </div>
            {connection.active ? <GitlabTracking connectionId={connection.id} /> : null}
        </section>
    );
}

function AdminSection({ onError }: { onError: (message: string) => void }) {
    const read = useGitlabConnections(true);
    const [removing, setRemoving] = useState<GitlabConnectionView | null>(null);
    const [busy, setBusy] = useState(false);
    const remove = async () => {
        if (!removing) return;
        setBusy(true);
        const message = await deleteGitlabConnection(removing.id);
        setBusy(false);
        setRemoving(null);
        if (message !== null) onError(message);
        await read.reload();
    };
    return (
        <>
            {read.state === 'error' ? <StateNote state="error">{read.error}</StateNote> : null}
            {read.state === 'ok'
                ? read.connections.map((connection) => (
                      <ConnectionCard
                          key={connection.id}
                          connection={connection}
                          onRemove={() => setRemoving(connection)}
                          onError={onError}
                      />
                  ))
                : null}
            <GitlabConnectForm
                redirectUri={`${window.location.origin}${CALLBACK_PATH}`}
                onConnected={() => void read.reload()}
            />
            <ConfirmDialog
                open={removing !== null}
                busy={busy}
                title={`Remove ${removing?.host ?? ''}?`}
                confirmClassName="chat-remove"
                confirmText="Remove connection"
                onClose={() => setRemoving(null)}
                onConfirm={() => void remove()}
            >
                <p>
                    Members&apos; links to it end and its tracked projects leave the repository list. Running tasks wait
                    for a new link.
                </p>
            </ConfirmDialog>
        </>
    );
}

/**
 * Settings → Integrations → GitLab (docs/gitlab.md): an admin connects an instance and picks the projects the org
 * tracks; every member links their own account, which no task on a GitLab repository starts without. A failed read is
 * an alert, never "no connections".
 */
export function SettingsGitlabPage() {
    const { session } = useSettingsPage();
    const grants = useGitlabGrants();
    const [params] = useSearchParams();
    const [error, setError] = useState<string | null>(null);
    const notice = noticeOf(params.get('integration'), params.get('result'));
    return (
        <>
            <PageHeader
                eyebrow="Settings"
                title="GitLab"
                description="A self-hosted GitLab your tasks can use as you."
                actions={<Link to="/settings/integrations">Back to Integrations</Link>}
            />
            {notice ? <IntegrationNoticeBanner notice={notice} /> : null}
            {error ? (
                <p className="status error" role="alert">
                    {error}
                </p>
            ) : null}
            <section aria-labelledby="gitlab-account-title">
                <h2 id="gitlab-account-title">Your account</h2>
                {grants.state === 'loading' ? <StateNote state="loading">Loading GitLab connections…</StateNote> : null}
                {grants.state === 'error' ? <StateNote state="error">{grants.error}</StateNote> : null}
                {grants.state === 'ok' && grants.connections.length === 0 ? (
                    <StateNote state="empty">No GitLab instance is active for this organization yet.</StateNote>
                ) : null}
                {grants.state === 'ok'
                    ? grants.connections.map((grant) => <AccountRow key={grant.id} grant={grant} onError={setError} />)
                    : null}
            </section>
            {session?.role === ADMIN_ROLE ? <AdminSection onError={setError} /> : null}
        </>
    );
}
