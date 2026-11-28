import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { request } from '../api/request.js';
import { queueTask, type QueueTaskInput } from '../api/taskWrites.js';
import { useConnections } from '../api/useConnections.js';
import type { UseModelSetup } from '../api/useModelSetup.js';
import { trackedRepos, type UseRepos, useRepos } from '../api/useRepos.js';
import { useSession } from '../api/useSession.js';
import type { UseWorkspace } from '../api/useWorkspace.js';
import { ComposerDraftProvider, draftOwner, useComposerDraftStore } from '../composer-draft.js';
import { Icon } from '../components/Icon.js';
import { StateNote } from '../components/StateNote.js';
import { TaskComposer, TaskComposerSkeleton } from '../panels/TaskComposer.js';
import { initialComposerState } from '../task-composer.js';
import { composerExecutorOptions } from '../workspace/executors.js';
import { readReadyDraft, writeReadyDraft } from './ready-draft.js';
import { ReadySummary } from './ReadySummary.js';
import { setupPath } from './steps.js';
import { useSetupWalk } from './useSetupWalk.js';

/** The starter prompts under the composer: a chip fills the request, the member still presses Start. */
const STARTERS: readonly { label: string; prompt: string }[] = [
    { label: 'Write CONTRIBUTING.md', prompt: 'Add a CONTRIBUTING.md that explains how to run the tests locally.' },
    { label: 'Fix a flaky test', prompt: 'Find and fix one flaky test. Explain the cause in the pull request.' },
    { label: 'Upgrade a dependency', prompt: 'Upgrade one outdated dependency and make the build pass.' },
];

/** The Ready prompt's placeholder: a task for the chosen repository. */
const taskPlaceholder = (repo: string): string => (repo === '' ? 'Describe a task…' : `Describe a task for ${repo}…`);

/** A task created whose setup `complete` has not landed yet: the next Ready load finishes it, never creating again. */
const STARTED_KEY = 'setup-first-task';
const NO_MODEL_ID = 'ready-no-model';
const RESUME_FAILED = 'Your first task started, but setup could not be finished. Try again.';

/** Marks setup complete, then re-reads `/api/auth/me` so no stale `completed: false` sends the member back. */
async function completeSetup(): Promise<boolean> {
    const done = await request('/api/onboarding/setup/complete', {
        method: 'POST',
        empty: true,
        verb: 'Could not finish setup',
    });
    if (!done.ok) return false;
    const me = await request('/api/auth/me', { ungated: true, verb: 'Could not check the session' });
    return me.ok;
}

/**
 * Start from Ready: create the task with an Idempotency-Key (the same key while the request is the same,
 * so a retry never creates twice), then complete setup and open the task — even when `complete` fails,
 * since the task exists; the id is held so the next Ready load completes setup and opens it.
 */
function useFirstTask(owner: string | null) {
    const navigate = useNavigate();
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const attempt = useRef<{ body: string; key: string } | null>(null);

    const keyed = (input: QueueTaskInput): QueueTaskInput => {
        if (input.idempotencyKey !== undefined) return input;
        const body = JSON.stringify(input);
        if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
        return { ...input, idempotencyKey: attempt.current.key };
    };

    const send = async (input: QueueTaskInput): Promise<string | null> => {
        setError(null);
        setSending(true);
        try {
            const { id, error: refused } = await queueTask(keyed(input));
            if (id === null) {
                const message = refused ?? 'Could not queue the task';
                setError(message);
                return message;
            }
            attempt.current = null;
            // The task exists: its draft is done, whatever `complete` answers.
            writeReadyDraft(owner, null);
            window.sessionStorage.setItem(STARTED_KEY, id);
            if (await completeSetup()) window.sessionStorage.removeItem(STARTED_KEY);
            await navigate(`/tasks/${id}`);
            return null;
        } finally {
            setSending(false);
        }
    };
    return { sending, error, send };
}

/** A task started on an earlier load whose setup never completed: complete it once on mount, Try again after. */
function useStartedTask() {
    const navigate = useNavigate();
    const [started] = useState(() => window.sessionStorage.getItem(STARTED_KEY));
    const [failed, setFailed] = useState(false);
    const finish = useCallback(async () => {
        if (started === null) return;
        setFailed(false);
        if (!(await completeSetup())) {
            setFailed(true);
            return;
        }
        window.sessionStorage.removeItem(STARTED_KEY);
        await navigate(`/tasks/${started}`);
    }, [started, navigate]);
    useEffect(() => {
        void finish();
    }, [finish]);
    return { started, failed, retry: () => void finish() };
}

/** The inline composer with its own held draft: the first tracked repository preselected, the starters under the prompt. */
function FirstTaskComposer({
    repos,
    workspace,
    owner,
}: {
    repos: UseRepos;
    workspace: UseWorkspace;
    owner: string | null;
}) {
    const draftStore = useComposerDraftStore();
    const first = useFirstTask(owner);
    // The stored draft goes into the store before the composer mounts: it reads the store once, at mount.
    const [seeded, setSeeded] = useState(() => readReadyDraft(owner) === null);
    useEffect(() => {
        if (seeded) return;
        const held = readReadyDraft(owner);
        if (held !== null) draftStore.save(held);
        setSeeded(true);
    }, [seeded, owner, draftStore]);
    // Every change the composer writes to the store is mirrored to storage; a cleared draft drops it.
    useEffect(() => {
        if (seeded) writeReadyDraft(owner, draftStore.state);
    }, [seeded, owner, draftStore.state]);
    // A starter writes the held draft and remounts the composer, which reads the draft once at mount.
    const [generation, setGeneration] = useState(0);
    const tracked = trackedRepos(repos);
    const executors = composerExecutorOptions(workspace.data?.executors ?? [], workspace.data?.orgExecutors ?? []);
    const defaultExecutor = workspace.data?.defaultExecutor ?? null;

    const fill = (prompt: string) => {
        const held = draftStore.state;
        const base =
            held === null
                ? initialComposerState(null, { repos: tracked.repos, executors, defaultExecutor })
                : (({ owner: _owner, ...rest }) => rest)(held);
        draftStore.save({ ...base, draft: prompt });
        setGeneration((count) => count + 1);
    };

    if (!seeded) return <TaskComposerSkeleton />;
    return (
        <TaskComposer
            key={generation}
            repos={tracked.repos}
            reposError={tracked.error}
            onRetryRepos={repos.refresh}
            workspaceLoaded={workspace.data !== null}
            workspaceError={workspace.error}
            onRetryWorkspace={workspace.refresh}
            executors={executors}
            defaultExecutor={defaultExecutor}
            workflows={null}
            actionError={first.error}
            sending={first.sending}
            onSend={first.send}
            draftStore={draftStore}
            inline
            placeholderFor={taskPlaceholder}
            starters={
                <div className="ready-starters">
                    {STARTERS.map((starter) => (
                        <button key={starter.label} type="button" onClick={() => fill(starter.prompt)}>
                            {starter.label}
                        </button>
                    ))}
                </div>
            }
        />
    );
}

/**
 * Ready's body: the summary, then the first task — the inline composer, or, with no model confirmed,
 * the warning back to the model step and an `aria-disabled` Start — and "Go to the dashboard instead",
 * which completes setup and returns to `returnTo`.
 */
export function ReadyStep({
    setup,
    workspace,
    noModel,
}: {
    setup: UseModelSetup;
    workspace: UseWorkspace;
    /** `showNoModel`'s answer: a task could not run, so Start stays dark. */
    noModel: boolean;
}) {
    const walk = useSetupWalk();
    const { session, loading: sessionLoading } = useSession();
    const repos = useRepos(true);
    const connections = useConnections();
    const { pathname, search } = useLocation();
    const started = useStartedTask();

    let task: ReactNode;
    if (started.started !== null) {
        task = started.failed ? (
            <StateNote state="error">{RESUME_FAILED}</StateNote>
        ) : (
            <StateNote state="loading">Finishing setup…</StateNote>
        );
    } else if (noModel) {
        task = (
            <div className="banner-warn ready-no-model" id={NO_MODEL_ID}>
                <Icon name="alert-triangle" size={24} />
                <p>
                    No model yet — tasks will wait until one is connected.{' '}
                    <Link to={setupPath('model', walk.returnTo)}>Connect a model</Link>
                </p>
            </div>
        );
    } else {
        task = (
            <ComposerDraftProvider session={session}>
                {sessionLoading ? (
                    <TaskComposerSkeleton />
                ) : (
                    <FirstTaskComposer repos={repos} workspace={workspace} owner={draftOwner(session)} />
                )}
            </ComposerDraftProvider>
        );
    }

    return (
        <>
            <ReadySummary
                session={session}
                repos={repos}
                setup={setup}
                noModel={noModel}
                workspace={workspace}
                connections={connections}
                returnTo={walk.returnTo}
                here={`${pathname}${search}`}
            />
            {task}
            {walk.error ? <StateNote state="error">{walk.error}</StateNote> : null}
            <div className="setup-actions">
                <button
                    type="button"
                    className="tertiary"
                    aria-disabled={walk.busy || undefined}
                    onClick={walk.complete}
                >
                    Go to the dashboard instead
                </button>
                {started.failed ? (
                    <button type="button" className="primary" onClick={started.retry}>
                        Try again
                    </button>
                ) : null}
                {noModel && started.started === null ? (
                    <button type="button" className="primary" aria-disabled="true" aria-describedby={NO_MODEL_ID}>
                        Start task
                    </button>
                ) : null}
            </div>
        </>
    );
}
