import { useEffect, useId, useRef, useState } from 'react';
import {
    bindTaskConnection,
    type ConnectionView,
    dismissRequirement,
    listConnections,
    startAuthorization,
} from '../api/connections.js';
import type { Job, JobIntegrationRequirement } from '../api/useJobs.js';
import type { FollowUpViewer } from '../task-outcome.js';

/** The caller's connections for one provider, as the block's picker reads them. */
export type Candidates =
    | { state: 'loading' }
    | { state: 'error'; error: string }
    | { state: 'ready'; connections: ConnectionView[] };

export type ConnectBusy = 'connect' | 'use' | 'dismiss';

const leadOf = (requirement: JobIntegrationRequirement): string => {
    const { label, reason, source } = requirement;
    const where = source === 'create' ? 'This task has not started' : 'The run is paused';
    if (reason === 'reconnect') return `${where}: its ${label} connection needs to be reconnected.`;
    if (reason === 'ambiguous') {
        return `${where}: you have more than one ${label} connection. Pick the one this task uses, or connect another.`;
    }
    return `${where}: it needs a ${label} connection. Connect your ${label} account, or continue without it.`;
};

/** What the picker area says while the caller's connections are not (yet) a list. */
function CandidatesNote({ label, candidates }: { label: string; candidates: Candidates }) {
    if (candidates.state === 'loading') return <p className="question-status">Loading your {label} connections…</p>;
    if (candidates.state === 'error') {
        return (
            <p className="question-error">
                Your {label} connections could not be loaded: {candidates.error}
            </p>
        );
    }
    return null;
}

/** The caller's existing connections of the provider, one radio each, and the button that binds the picked one. */
function ConnectionPicker({
    label,
    connections,
    picked,
    busy,
    onPick,
    onUse,
}: {
    label: string;
    connections: ConnectionView[];
    picked: string | null;
    busy: ConnectBusy | null;
    onPick: (connectionId: string) => void;
    onUse: () => void;
}) {
    const group = useId();
    return (
        <fieldset className="question-set" disabled={busy !== null}>
            <legend>Use one of your {label} connections</legend>
            {connections.map((connection) => (
                <label key={connection.id} className="question-option">
                    <input
                        type="radio"
                        name={group}
                        value={connection.id}
                        checked={picked === connection.id}
                        onChange={() => onPick(connection.id)}
                    />
                    <span>
                        {connection.account} · {connection.site}
                    </span>
                </label>
            ))}
            <div className="connect-actions">
                <button
                    type="button"
                    className="primary"
                    disabled={picked === null || busy !== null}
                    aria-busy={busy === 'use' || undefined}
                    onClick={onUse}
                >
                    Use selected connection
                </button>
            </div>
        </fieldset>
    );
}

/** The two ways past a requirement that need no pick: authorize (again), or go on without. */
function ConnectActions({
    label,
    reconnect,
    busy,
    onConnect,
    onDismiss,
}: {
    label: string;
    reconnect: boolean;
    busy: ConnectBusy | null;
    onConnect: () => void;
    onDismiss: () => void;
}) {
    return (
        <div className="connect-actions">
            <button
                type="button"
                className="primary"
                disabled={busy !== null}
                aria-busy={busy === 'connect' || undefined}
                onClick={onConnect}
            >
                {reconnect ? `Reconnect ${label}` : `Connect ${label}`}
            </button>
            <button
                type="button"
                disabled={busy !== null}
                aria-busy={busy === 'dismiss' || undefined}
                onClick={onDismiss}
            >
                Continue without it
            </button>
        </div>
    );
}

const waitingLine = (canAct: boolean, source: JobIntegrationRequirement['source'], who: string, label: string) => {
    if (!canAct) return `Waiting for ${who} to connect their ${label} account`;
    return source === 'create' ? 'Waiting to start until you decide' : 'Waiting for you to decide';
};

/**
 * One open connection requirement in its run's exchange, where a decision sits. Props in, markup
 * out: the provider's name arrives in the requirement, so nothing here knows a provider. Only the
 * task's execution user is offered the actions; anyone else reads who has to act.
 */
export function TaskConnectView({
    requirement,
    owner,
    canAct,
    candidates,
    picked,
    busy,
    error,
    onPick,
    onConnect,
    onUse,
    onDismiss,
}: {
    requirement: JobIntegrationRequirement;
    /** Who the requirement waits on: the execution user's name, else null. */
    owner: string | null;
    canAct: boolean;
    candidates: Candidates;
    picked: string | null;
    busy: ConnectBusy | null;
    error: string | null;
    onPick: (connectionId: string) => void;
    onConnect: () => void;
    onUse: () => void;
    onDismiss: () => void;
}) {
    const errorId = useId();
    const { label, reason, source } = requirement;
    const picking = canAct && reason !== 'reconnect';
    const offered = candidates.state === 'ready' ? candidates.connections : [];
    return (
        <section
            className="question"
            aria-label={`${label} connection needed`}
            aria-describedby={error !== null ? errorId : undefined}
        >
            <p>
                <span className="pill question-chip">{label}</span> {leadOf(requirement)}
            </p>
            {requirement.target !== null ? (
                <p className="question-status">The task needs: {requirement.target}</p>
            ) : null}
            {picking ? <CandidatesNote label={label} candidates={candidates} /> : null}
            {picking && offered.length > 0 ? (
                <ConnectionPicker
                    label={label}
                    connections={offered}
                    picked={picked}
                    busy={busy}
                    onPick={onPick}
                    onUse={onUse}
                />
            ) : null}
            {canAct ? (
                <ConnectActions
                    label={label}
                    reconnect={reason === 'reconnect'}
                    busy={busy}
                    onConnect={onConnect}
                    onDismiss={onDismiss}
                />
            ) : null}
            {error !== null ? (
                <p className="question-error" id={errorId}>
                    {error}
                </p>
            ) : null}
            <p className="question-status" aria-live="polite">
                {waitingLine(canAct, source, owner ?? 'the task owner', label)}
            </p>
        </section>
    );
}

/** One block's state: the pick, the one request in flight, and why the last one did not land. */
function TaskConnectBlock({
    job,
    requirement,
    owner,
    canAct,
    candidates,
    onChanged,
}: {
    job: Job;
    requirement: JobIntegrationRequirement;
    owner: string | null;
    canAct: boolean;
    candidates: Candidates;
    onChanged: () => void;
}) {
    const [picked, setPicked] = useState<string | null>(null);
    const [busy, setBusy] = useState<ConnectBusy | null>(null);
    const [error, setError] = useState<string | null>(null);
    const inFlight = useRef(false);

    const run = async (kind: ConnectBusy, action: () => Promise<string | null>) => {
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(kind);
        setError(null);
        const refusal = await action().catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
        inFlight.current = false;
        setBusy(null);
        if (refusal === null) onChanged();
        else setError(refusal);
    };

    const connect = () =>
        run('connect', async () => {
            const started = await startAuthorization(requirement.provider, {
                jobId: job.id,
                returnTo: `/tasks/${job.rootJobId}`,
                ...(requirement.connectionId !== null ? { connectionId: requirement.connectionId } : {}),
            });
            if (!started.ok) return started.error;
            window.location.assign(started.authorizeUrl);
            return null;
        });

    return (
        <TaskConnectView
            requirement={requirement}
            owner={owner}
            canAct={canAct}
            candidates={candidates}
            picked={picked}
            busy={busy}
            error={error}
            onPick={setPicked}
            onConnect={() => void connect()}
            onUse={() => {
                if (picked !== null) {
                    void run('use', () => bindTaskConnection(job.id, picked, job.bindingRevision));
                }
            }}
            onDismiss={() => void run('dismiss', () => dismissRequirement(job.id, requirement.provider))}
        />
    );
}

/**
 * Every open requirement of the thread, one block each, rendered on the newest run. The caller's
 * connections are read once, and only for the execution user — nobody else can bind.
 */
/**
 * Whether a connection at `site` serves a requirement with `target`: no target takes any, a target takes its site
 * (any case). A web copy of the board's rule (`requirementMatches`), which the web cannot import.
 */
const servesTarget = (target: string | null, site: string): boolean =>
    target === null || site.toLowerCase() === target.toLowerCase();

/** The active connections the person may pick for `requirement`: its provider, its target, not already bound. */
export const candidatesFor = (
    requirement: JobIntegrationRequirement,
    connections: readonly ConnectionView[],
    bound: ReadonlySet<string | null>
): ConnectionView[] =>
    connections.filter(
        (c) =>
            c.provider === requirement.provider &&
            c.status === 'active' &&
            !bound.has(c.id) &&
            servesTarget(requirement.target, c.site)
    );

export function TaskConnect({ job, viewer, onChanged }: { job: Job; viewer: FollowUpViewer; onChanged: () => void }) {
    const requirements = job.integrationRequirements;
    const canAct = !viewer.loading && viewer.id !== null && job.executionUser?.id === viewer.id;
    const [read, setRead] = useState<Candidates>({ state: 'loading' });
    const wanted = canAct && requirements.length > 0;

    useEffect(() => {
        if (!wanted) return;
        let live = true;
        void listConnections().then((result) => {
            if (live)
                setRead(
                    result.ok
                        ? { state: 'ready', connections: result.connections }
                        : { state: 'error', error: result.error }
                );
        });
        return () => {
            live = false;
        };
    }, [wanted]);

    if (requirements.length === 0) return null;
    const bound = new Set(job.connections.filter((c) => c.live).map((c) => c.connectionId));
    const owner = job.executionUser?.name ?? job.executionUser?.login ?? null;
    return (
        <>
            {requirements.map((requirement) => (
                <TaskConnectBlock
                    key={requirement.provider}
                    job={job}
                    requirement={requirement}
                    owner={owner}
                    canAct={canAct}
                    candidates={
                        read.state === 'ready'
                            ? {
                                  state: 'ready',
                                  connections: candidatesFor(requirement, read.connections, bound),
                              }
                            : read
                    }
                    onChanged={onChanged}
                />
            ))}
        </>
    );
}
