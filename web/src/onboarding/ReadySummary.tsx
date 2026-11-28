import { INTEGRATION_CATALOG, type ExecutorType } from '@factory-ai/core';
import { Link } from 'react-router-dom';
import type { ConnectionsRead } from '../api/useConnections.js';
import { trackedRepos, type UseRepos } from '../api/useRepos.js';
import type { Session } from '../api/useSession.js';
import type { DefaultExecutorRead } from '../providers/default-executor.js';
import { PROVIDER_META } from '../providers/providers.js';
import { connectionState } from '../settings/integration-providers.js';
import { EXECUTOR_TYPE_META } from '../workspace/executors.js';
import { reselectHref, setupPath } from './steps.js';

/** A row's lamp: ok (set up), wait (left for later) or idle (not yet known). */
type Lamp = 'ok' | 'wait' | 'idle';

interface Row {
    name: string;
    detail: string;
    lamp: Lamp;
    /** A full-page address (the reselect round trip) or an in-app path. */
    change?: { href: string } | { to: string };
    /** Set when the row's read did not answer: says nothing about the setup, asks again. */
    retry?: () => void;
}

type RowState = Pick<Row, 'detail' | 'lamp' | 'retry'>;

const CHECKING = { detail: 'Checking…', lamp: 'idle' } as const;
const joined = (parts: readonly (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');
const agentLabel = (type: ExecutorType) => EXECUTOR_TYPE_META[type].label;

/** An empty listing that came with GitHub's error is unknown, never "0 selected" (the composer's own reading). */
function reposRow(read: UseRepos): RowState {
    const tracked = trackedRepos(read);
    if (tracked.repos === null || read.data === null) {
        if (read.data === null && read.error === null) return CHECKING;
        return { detail: "Couldn't load repositories", lamp: 'idle', retry: read.refresh };
    }
    const { repos, installation } = read.data;
    const scope =
        installation?.repositorySelection === 'all'
            ? `all ${repos.length}, including future ones`
            : `${repos.length} selected`;
    return { detail: joined([installation?.account, scope]), lamp: repos.length > 0 ? 'ok' : 'wait' };
}

const UNREAD = { detail: 'Could not check the provider.', lamp: 'idle' } as const;

/** "Not connected" only on a confirmed read that found no default executor; a failed read says so instead. */
function providerRow(read: DefaultExecutorRead, organization: string | null): RowState {
    if (read.state === 'loading') return CHECKING;
    if (read.state === 'error') return { ...UNREAD, retry: read.retry };
    if (read.state === 'none') return { detail: 'Not connected', lamp: 'wait' };
    const { connection, scope } = read.executor;
    if (!connection) return { detail: 'Its connection is not visible to you', lamp: 'ok' };
    const who = scope === 'org' ? `everyone in ${organization ?? 'the organization'}` : 'only you';
    return {
        detail: joined([PROVIDER_META[connection.provider].label, `connection ${connection.name}`, who]),
        lamp: 'ok',
    };
}

/** The default executor by name and model; its model is unknown to a member who cannot read an organization's configuration. */
function executorRow(read: DefaultExecutorRead): RowState {
    if (read.state === 'loading') return CHECKING;
    if (read.state === 'error')
        return { ...UNREAD, detail: 'Could not check the default executor.', retry: read.retry };
    if (read.state === 'none') return { detail: 'None yet — tasks need a default executor', lamp: 'wait' };
    const { executor, detail } = read;
    const model = detail?.model;
    return {
        detail: joined([
            model ? `${executor.name} — ${model}` : `${executor.name} (${agentLabel(executor.agentType)})`,
            executor.suspended ? 'suspended' : null,
        ]),
        lamp: executor.suspended ? 'wait' : 'ok',
    };
}

function trackerRow(read: ConnectionsRead): RowState {
    if (read.state === 'loading') return CHECKING;
    if (read.state === 'error') {
        return { detail: 'Could not check the issue trackers.', lamp: 'idle', retry: () => void read.reload() };
    }
    const live = read.connections.filter((row) => connectionState(row) === 'connected');
    if (live.length === 0) return { detail: 'Not connected — optional', lamp: 'wait' };
    const label = (id: string) => INTEGRATION_CATALOG.find((entry) => entry.id === id)?.label ?? id;
    return { detail: live.map((row) => joined([label(row.provider), row.site])).join(' · '), lamp: 'ok' };
}

/**
 * Ready's summary: one row per part of the setup with its lamp and a Change back to the step that sets
 * it. Repositories' Change is the reselect round trip back to this page — bare `/onboarding` has no
 * pending sign-in behind it.
 */
export function ReadySummary({
    session,
    repos,
    provider,
    connections,
    returnTo,
    here,
}: {
    session: Session | null;
    repos: UseRepos;
    provider: DefaultExecutorRead;
    connections: ConnectionsRead;
    returnTo: string;
    here: string;
}) {
    const rows: Row[] = [
        { name: 'GitHub', detail: session ? `Signed in as ${session.user.login}` : 'Signed in', lamp: 'ok' },
        { name: 'Repositories', ...reposRow(repos), change: { href: reselectHref(here) } },
        {
            name: 'Provider',
            ...providerRow(provider, session?.organization.name ?? null),
            change: { to: setupPath('provider', returnTo) },
        },
        {
            name: 'Default executor',
            ...executorRow(provider),
            change: { to: setupPath('provider', returnTo) },
        },
        { name: 'Issue tracker', ...trackerRow(connections), change: { to: setupPath('tools', returnTo) } },
    ];
    return (
        <ul className="ready-summary" aria-label="Setup summary">
            {rows.map((row) => (
                <li key={row.name} className="ready-row" aria-label={row.name}>
                    <span className="ready-lamp" data-state={row.lamp} aria-hidden="true" />
                    <span className="ready-row-body">
                        <span className="ready-row-name">{row.name}</span>
                        <span className="ready-row-detail">{row.detail}</span>
                    </span>
                    {row.retry ? (
                        <button
                            type="button"
                            className="tertiary"
                            aria-label={`Retry ${row.name.toLowerCase()}`}
                            onClick={row.retry}
                        >
                            Retry
                        </button>
                    ) : null}
                    {row.change === undefined ? null : 'href' in row.change ? (
                        <a href={row.change.href} aria-label={`Change ${row.name.toLowerCase()}`}>
                            Change
                        </a>
                    ) : (
                        <Link to={row.change.to} aria-label={`Change ${row.name.toLowerCase()}`}>
                            Change
                        </Link>
                    )}
                </li>
            ))}
        </ul>
    );
}
