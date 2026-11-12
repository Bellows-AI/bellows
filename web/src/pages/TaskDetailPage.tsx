import { ADMIN_ROLE } from '@factory-ai/core';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { useThread } from '../api/useJobs.js';
import type { Job } from '../api/useJobs.js';
import { useThreadActivity } from '../api/useJobActivity.js';
import type { SubmittedFiles } from '../api/taskWrites.js';
import type { UseTasks } from '../api/useTasks.js';
import { useComposerDraftStore } from '../composer-draft.js';
import { BatchBacklink } from '../components/BatchBacklink.js';
import { TaskRemoveDialog } from '../components/TaskRemoveDialog.js';
import { TaskRenameDialog } from '../components/TaskRenameDialog.js';
import { TaskControls, TaskHeader } from '../panels/TaskHeader.js';
import { taskTitleText } from '../task-title.js';
import { TaskDetail } from '../panels/TaskDetail.js';
import type { OnAnswer } from '../panels/TaskRun.js';
import { useTasksPage } from './TasksLayout.js';

/**
 * The conversation-level actions: sending a follow-up, marking done, stopping — each guarded by
 * its own in-flight mark and by the generation counter, so a retired request from a previous
 * task id can never land on the one now on screen. Split out of `TaskDetailPage` so its own
 * line count stays under the limit.
 */
function useTaskConversationActions(
    id: string | null,
    tasks: UseTasks,
    detail: { jobs: Job[] | null; refresh: () => void },
    latest: Job | null
) {
    const [sending, setSending] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [followUpError, setFollowUpError] = useState<string | null>(null);
    const [stoppingId, setStoppingId] = useState<string | null>(null);
    const [doneId, setDoneId] = useState<string | null>(null);
    // See the module-level note on the removal hook's generation ref — the same discipline,
    // scoped to this hook's own state.
    const generation = useRef(0);
    useEffect(() => {
        generation.current += 1;
        setActionError(null);
        setFollowUpError(null);
        setSending(false);
        setStoppingId(null);
        setDoneId(null);
        return () => {
            generation.current += 1;
        };
    }, [id]);

    const followUp = async (command: string, files?: SubmittedFiles): Promise<string | null> => {
        if (latest === null) return 'No task to follow up on';
        const atStart = generation.current;
        setFollowUpError(null);
        setSending(true);
        try {
            // The adjustment continues the NEWEST run — it is the one that is finished and
            // carries the session the child inherits. No executor on the body: the board binds
            // the follow-up to the executor that ran the task.
            const result = await tasks.actions.followUp(latest.id, command, files);
            if (generation.current !== atStart) return result.error;
            if (result.error !== null) {
                // Said inside the composer, beside the draft it refused — a 403 FORBIDDEN too.
                setFollowUpError(result.error);
                return result.error;
            }
            // Same task, one message longer: the thread poll stopped when every run in it was
            // terminal, so it re-arms here to bring the queued adjustment in.
            detail.refresh();
            return null;
        } finally {
            // Only the current question releases the composer: a retired follow-up's settle
            // must not release task B's own in-flight send mid-request.
            if (generation.current === atStart) setSending(false);
        }
    };

    const doneTask = async (taskId: string) => {
        if (doneId !== null) return;
        const atStart = generation.current;
        setDoneId(taskId);
        try {
            setActionError(null);
            const message = await tasks.actions.markDone(taskId);
            if (generation.current !== atStart) return;
            if (message !== null) {
                setActionError(message);
                return;
            }
            // The thread poll stopped the moment every run went terminal — nothing in a finished
            // chain changes by itself — so the user's own verdict arrives only through a re-armed
            // poll. Without this the page would keep offering Done and the follow-up composer the
            // click just closed off.
            detail.refresh();
        } finally {
            if (generation.current === atStart) setDoneId(null);
        }
    };

    // The board settles the run at the worker's next heartbeat, so the button says "Stop" while
    // the request is in flight and "Stopping…" once the flag has landed but the run has not gone
    // yet — the polls repaint the header the moment the driver has parked it, and the row comes
    // back `stopped`: the turn ended, the composer below is open again.
    const stopTask = async (taskId: string) => {
        if (stoppingId !== null) return;
        const atStart = generation.current;
        setStoppingId(taskId);
        try {
            setActionError(null);
            const message = await tasks.actions.stop(taskId);
            if (generation.current !== atStart) return;
            if (message !== null) setActionError(message);
            // Success needs no navigation: re-arm the thread poll so the stamped run repaints
            // the header at once — otherwise the cleared guard would flash the clickable button
            // back on for up to one 2s tick before the poll carried the stamp in.
            else detail.refresh();
        } finally {
            if (generation.current === atStart) setStoppingId(null);
        }
    };

    return { sending, actionError, followUpError, stoppingId, doneId, followUp, doneTask, stopTask };
}

/**
 * The remove confirmation's own state: the header's menu item only opens the dialog, the
 * dialog's Remove task is the one thing that mutates, and a refusal stays inside it. Success is
 * the one navigation — the rows are gone, the page has nothing left to render, and the inbox is
 * where the task list lives. Split out of `TaskDetailPage` for the same reason as
 * `useTaskConversationActions`.
 *
 * One page instance serves every `/tasks/:id`, so a refusal earned on task A would sit above
 * task B after a sidenav jump — the generation counter is what keeps a RETIRED request from
 * haunting the new task: every action captures it at start, and after each await its tail
 * (error, refresh, navigation, mark clearing) acts only while its own generation is still
 * current. Monotonic, so navigating back to A still counts as a new question, and the effect's
 * cleanup invalidates in-flight actions again on unmount.
 */
function useTaskRemoval(id: string | null, tasks: UseTasks, latest: Job | null, navigate: NavigateFunction) {
    const [removingId, setRemovingId] = useState<string | null>(null);
    const [removeOpen, setRemoveOpen] = useState(false);
    const [removeError, setRemoveError] = useState<string | null>(null);
    const generation = useRef(0);
    useEffect(() => {
        generation.current += 1;
        setRemovingId(null);
        setRemoveOpen(false);
        setRemoveError(null);
        return () => {
            generation.current += 1;
        };
    }, [id]);

    const openRemove = () => {
        setRemoveError(null);
        setRemoveOpen(true);
    };
    const closeRemove = () => setRemoveOpen(false);

    const removeTask = async () => {
        if (latest === null || removingId !== null) return;
        const taskId = latest.id;
        const atStart = generation.current;
        setRemovingId(taskId);
        try {
            setRemoveError(null);
            const message = await tasks.actions.remove(taskId);
            // A retired remove must not yank the reader off the task they navigated to.
            if (generation.current !== atStart) return;
            if (message !== null) {
                setRemoveError(message);
                return;
            }
            // Discarded on purpose: the route change is the last thing this does, and the
            // `finally` below must not wait on the transition to clear the pending flag.
            void navigate('/tasks');
        } finally {
            if (generation.current === atStart) setRemovingId(null);
        }
    };

    return { removingId, removeOpen, removeError, openRemove, closeRemove, removeTask };
}

/**
 * The rename dialog's own state (BEL-252). Saving sends the revision the page rendered; a stale answer keeps
 * the dialog open on the board's current title and retries on ITS revision. A saved rename re-arms the thread
 * poll — a terminal task's poll has stopped, so without that refetch its header would keep the old name.
 * Reset per task by the same generation rule as `useTaskRemoval`.
 */
function useTaskRename(id: string | null, tasks: UseTasks, root: Job | null, refreshThread: () => void) {
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [staleRevision, setStaleRevision] = useState<number | null>(null);
    const generation = useRef(0);
    useEffect(() => {
        generation.current += 1;
        setOpen(false);
        setSaving(false);
        setError(null);
        setStaleRevision(null);
        return () => {
            generation.current += 1;
        };
    }, [id]);

    const openRename = () => {
        setError(null);
        setStaleRevision(null);
        setOpen(true);
    };
    const save = async (title: string) => {
        if (root === null || saving) return;
        const atStart = generation.current;
        setSaving(true);
        try {
            const outcome = await tasks.actions.rename(root.id, title, staleRevision ?? root.titleRevision);
            if (generation.current !== atStart) return;
            if (outcome.state === 'saved') {
                setOpen(false);
                refreshThread();
            } else if (outcome.state === 'stale') {
                setStaleRevision(outcome.revision);
                setError(
                    `The title was changed to \u201C${outcome.title}\u201D while you edited. Save again to replace it.`
                );
                refreshThread();
            } else {
                setError(outcome.error);
            }
        } finally {
            if (generation.current === atStart) setSaving(false);
        }
    };

    return {
        renameOpen: open,
        renaming: saving,
        renameError: error,
        openRename,
        closeRename: () => setOpen(false),
        save,
    };
}

/**
 * `/tasks/:id`, one task — the WHOLE follow-up chain, from the root command to the newest
 * adjustment, as one conversation. Any member's id resolves to the same view, and a follow-up
 * does NOT navigate away: the board records it as a new row (an audit record of what ran), the
 * thread refetches, and the adjustment appears as the newest message of the task it continues.
 *
 * The page header (status, wall clock, activity, the task's actions) and the conversation panel
 * both read the same polled chain. The composer and the Done verdict act on the NEWEST run — the
 * only one that is finished and not yet closed — so the page reads it off the polled chain
 * rather than off the URL.
 */
export function TaskDetailPage() {
    const { tasks, session, sessionLoading } = useTasksPage();
    const navigate = useNavigate();
    const params = useParams();
    const id = params.id ?? null;
    const detail = useThread(id);
    const draftStore = useComposerDraftStore();

    // A different id is a different conversation — the NEWEST run is the one the composer and
    // the Done verdict act on, the only one that is finished and not yet closed.
    const latest =
        detail.jobs !== null && detail.jobs.length > 0 ? (detail.jobs[detail.jobs.length - 1] ?? null) : null;

    // The thread's per-run activity (issues 339, 530): fetched for every run by its own id —
    // any member's id resolves to this page — once live and once final, keyed off the thread
    // poll's own changes.
    const activity = useThreadActivity(detail.jobs);

    const { sending, actionError, followUpError, stoppingId, doneId, followUp, doneTask, stopTask } =
        useTaskConversationActions(id, tasks, detail, latest);
    // Who is looking: the task owner or an org admin may follow it up (the board checks the same).
    const viewer = { loading: sessionLoading, id: session?.user.id ?? null, admin: session?.role === ADMIN_ROLE };
    const { removingId, removeOpen, removeError, openRemove, closeRemove, removeTask } = useTaskRemoval(
        id,
        tasks,
        latest,
        navigate
    );
    const rename = useTaskRename(id, tasks, detail.jobs?.[0] ?? null, detail.refresh);
    // A settled answer — ours, or the 409 that says what the board already holds — re-arms the
    // thread poll, so the stored answer, its author and its time replace the local overlay.
    const answerQuestion: OnAnswer = async (jobId, questionId, answers) => {
        const outcome = await tasks.actions.answerQuestion(jobId, questionId, answers);
        if (outcome.state !== 'failed') detail.refresh();
        return outcome;
    };

    return (
        <>
            {tasks.error ? <p className="status">{tasks.error}</p> : null}
            <TaskDetail
                key={id ?? 'none'}
                header={
                    <>
                        <TaskHeader jobs={detail.jobs} />
                        <BatchBacklink rootId={detail.jobs?.[0]?.id ?? null} enabled={session?.batches === true} />
                    </>
                }
                controls={
                    detail.jobs !== null && detail.jobs.length > 0 ? (
                        <TaskControls
                            jobs={detail.jobs}
                            viewer={viewer}
                            stoppingId={stoppingId}
                            doneId={doneId}
                            onStop={stopTask}
                            onDone={doneTask}
                            onRemoveRequest={openRemove}
                            onRenameRequest={rename.openRename}
                        />
                    ) : null
                }
                jobs={detail.jobs}
                viewer={viewer}
                error={detail.error}
                onRetry={detail.refresh}
                actionError={actionError}
                followUpError={followUpError}
                sending={sending}
                onFollowUp={followUp}
                draftStore={draftStore}
                onAnswer={answerQuestion}
                onConnectionChange={detail.refresh}
                activity={activity}
            />
            {detail.jobs !== null && detail.jobs.length > 0 ? (
                <TaskRemoveDialog
                    open={removeOpen}
                    name={taskTitleText(detail.jobs[0]!)}
                    runCount={detail.jobs.length}
                    removing={removingId !== null}
                    error={removeError}
                    onClose={closeRemove}
                    onConfirm={() => void removeTask()}
                />
            ) : null}
            {detail.jobs !== null && detail.jobs.length > 0 ? (
                <TaskRenameDialog
                    open={rename.renameOpen}
                    initial={taskTitleText(detail.jobs[0]!)}
                    saving={rename.renaming}
                    error={rename.renameError}
                    onClose={rename.closeRename}
                    onSave={(title) => void rename.save(title)}
                />
            ) : null}
        </>
    );
}
