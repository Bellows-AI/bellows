import { INTEGRATION_CATALOG, MODEL_PROVIDERS, type ExecutorType } from '@factory-ai/core';
import { Link } from 'react-router-dom';
import type { ConnectionsRead } from '../api/useConnections.js';
import type { UseModelSetup } from '../api/useModelSetup.js';
import { trackedRepos, type UseRepos } from '../api/useRepos.js';
import type { Session } from '../api/useSession.js';
import type { UseWorkspace } from '../api/useWorkspace.js';
import { PROVIDER_META } from '../model-setup/providers.js';
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
const agentLabel = (type: ExecutorType | null | undefined) => (type ? EXECUTOR_TYPE_META[type].label : null);
/** A scope's provider is a model provider, or `platform`/`existing`, which name no provider. */
function providerLabel(provider: string | null | undefined): string | null {
    const known = MODEL_PROVIDERS.find((entry) => entry === provider);
    return known ? PROVIDER_META[known].label : null;
}

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

/** With no key the board can see, what a task would run on instead: the agent default, else the default profile. */
function withoutKeyRow(workspace: UseWorkspace): RowState {
    if (workspace.data === null) {
        if (workspace.error === null) return CHECKING;
        return { detail: 'Could not check the model.', lamp: 'idle', retry: workspace.refresh };
    }
    const { agentDefault, defaultExecutor } = workspace.data;
    if (agentDefault) return { detail: joined([agentLabel(agentDefault.agentType), agentDefault.model]), lamp: 'ok' };
    return { detail: joined(['Executor profile', defaultExecutor?.name]), lamp: 'ok' };
}

/** "Not connected" only when `showNoModel` says a task could not run; a failed read says so instead. */
function modelRow(
    setup: UseModelSetup,
    noModel: boolean,
    workspace: UseWorkspace,
    organization: string | null
): RowState {
    if (setup.error !== null) return { detail: 'Could not check the model.', lamp: 'idle', retry: setup.refresh };
    const view = setup.data;
    if (view === null) return CHECKING;
    if (view.effective === null) return noModel ? { detail: 'Not connected', lamp: 'wait' } : withoutKeyRow(workspace);
    if (view.effective === 'platform') {
        const choice = view.personal ?? view.org;
        return {
            detail: joined([agentLabel(choice?.agentType), choice?.model, 'provided by this deployment']),
            lamp: 'ok',
        };
    }
    if (view.effective === 'executor' && view.selected) {
        const { selected } = view;
        const who = selected.scope === 'org' ? `everyone in ${organization ?? 'the organization'}` : 'only you';
        return {
            detail: joined([
                selected.name,
                agentLabel(selected.agentType),
                providerLabel(selected.connection?.provider),
                selected.model,
                who,
            ]),
            lamp: 'ok',
        };
    }
    const scope = view.effective === 'executor' ? null : view[view.effective];
    const who = view.effective === 'org' ? `everyone in ${organization ?? 'the organization'}` : 'only you';
    return {
        detail: joined([agentLabel(scope?.agentType), providerLabel(scope?.provider), scope?.model, who]),
        lamp: 'ok',
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
    setup,
    noModel,
    workspace,
    connections,
    returnTo,
    here,
}: {
    session: Session | null;
    repos: UseRepos;
    setup: UseModelSetup;
    noModel: boolean;
    workspace: UseWorkspace;
    connections: ConnectionsRead;
    returnTo: string;
    here: string;
}) {
    const rows: Row[] = [
        { name: 'GitHub', detail: session ? `Signed in as ${session.user.login}` : 'Signed in', lamp: 'ok' },
        { name: 'Repositories', ...reposRow(repos), change: { href: reselectHref(here) } },
        {
            name: 'Model',
            ...modelRow(setup, noModel, workspace, session?.organization.name ?? null),
            change: { to: setupPath('model', returnTo) },
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
