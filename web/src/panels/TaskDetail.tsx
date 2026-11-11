import { type MutableRefObject, type ReactNode, useEffect, useRef } from 'react';
import { isTerminal, type Job, type ServiceStatus } from '../api/useJobs.js';
import { useAttachmentLimits, useAttachments } from '../api/useAttachments.js';
import type { SubmittedFiles } from '../api/useTasks.js';
import { type ComposerDraftStore, threadScope } from '../composer-draft.js';
import type { ThreadActivity } from '../api/useJobActivity.js';
import { KeyValues } from '../components/KeyValues.js';
import { StateNote } from '../components/StateNote.js';
import { endedOnQuestion, type FollowUpViewer, followUpEligibility } from '../task-outcome.js';
import { useStickToBottom } from '../use-stick-to-bottom.js';
import { AttachmentDropZone } from './AttachmentDropZone.js';
import { attachmentHandlers } from './AttachmentPicker.js';
import { ChatInput } from './ChatInput.js';
import { FOLLOW_UP_INPUT_ID, notAuthorMessage } from './TaskHeader.js';
import { TaskActivity } from './TaskActivity.js';
import { TaskOutcome } from './TaskOutcome.js';
import { type OnAnswer, TaskRun, Verification } from './TaskRun.js';
import { TaskSection } from './TaskSection.js';

/** No run's activity has been answered yet — every run reads as loading. */
const NO_ACTIVITY: ThreadActivity = {};

/** The Services panel shows only the first few rows; the rest collapse into a count. */
const MAX_VISIBLE_SERVICES = 3;

/** Why a dead service died: its exit, reason, hint and last log lines; nothing for a live one. */
function ServiceEnding({ service }: { service: ServiceStatus }) {
    const { exitCode, reason, logTail, hint } = service;
    if (exitCode === undefined && !reason && !logTail?.trim()) return null;
    const how = `exit ${exitCode ?? 'unknown'}${reason ? ` (${reason})` : ''}`;
    return (
        <div>
            <p className="muted">
                {service.name} {service.state} — {how}
            </p>
            {hint ? <p className="muted">{hint}</p> : null}
            {logTail?.trim() ? (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable
                <pre className="chat-output" tabIndex={0}>
                    {logTail.trimEnd()}
                </pre>
            ) : null}
        </div>
    );
}

/** The newest attempt's last observed service states, capped and counted. */
function Services({ services }: { services: readonly ServiceStatus[] }) {
    const overflow = services.length - MAX_VISIBLE_SERVICES;
    const visible = services.slice(0, MAX_VISIBLE_SERVICES);
    return (
        <TaskSection title="Services" aside={String(services.length)}>
            {/* The fleet is torn down when the attempt ends, so these are its record of it, not a
            claim about now. */}
            <KeyValues pairs={visible.map((service) => [service.name, service.state] as [string, ReactNode])} />
            {visible.map((service) => (
                <ServiceEnding key={service.name} service={service} />
            ))}
            {overflow > 0 ? <p className="muted">and {overflow} more</p> : null}
        </TaskSection>
    );
}

/**
 * The composer: a visible label and a helper sentence (it continues the task, it does not start
 * a new one), the draft, and the send. A refusal — a 403 FORBIDDEN included — renders inside it,
 * beside the draft it refused, and the draft is kept.
 */
function FollowUpComposer({
    rootId,
    draftStore,
    error,
    sending,
    onFollowUp,
    adder,
}: {
    /** The thread's root run: the key of this thread's draft in the shell's store. */
    rootId: string;
    draftStore: ComposerDraftStore;
    error: string | null;
    sending: boolean;
    onFollowUp: OnFollowUp;
    /** Where this composer publishes its `add`, so a drop anywhere on the conversation reaches it. */
    adder: MutableRefObject<((files: File[]) => void) | null>;
}) {
    // The text, the files and the submission key live in the shell's store, so a trip to
    // Settings (or to another task) and back finds this thread's draft as it was left.
    const held = draftStore.followUps[rootId];
    // A request in flight owns this thread's draft until it settles, however often the composer remounts.
    const frozen = sending || draftStore.submits[threadScope(rootId)] !== undefined;
    const draft = held?.text ?? '';
    const limits = useAttachmentLimits();
    const files = useAttachments(
        {
            draft: held ?? { attachments: [], submissionKey: null },
            update: (change) => draftStore.updateFollowUp(rootId, (current) => ({ ...current, ...change(current) })),
        },
        limits,
        frozen
    );
    const dropAndPaste = attachmentHandlers(limits !== null, files.add);
    const { add } = files;
    useEffect(() => {
        adder.current = limits === null ? null : add;
        return () => {
            adder.current = null;
        };
    }, [adder, limits, add]);
    const blocked = !draft.trim() || frozen || files.blocker !== null;
    const send = async () => {
        if (blocked) return;
        // No executor choice here: the adjustment is bound to the executor that ran the task.
        const ids = files.readyIds();
        const key = ids.length === 0 ? null : files.submissionKey();
        const submitted = key === null ? undefined : { attachments: ids, idempotencyKey: key };
        // The store clears exactly this draft on success and releases the lock either way, even
        // when this composer is gone by then.
        draftStore.beginSubmit(threadScope(rootId), key);
        let sent = false;
        try {
            sent = (await onFollowUp(draft, submitted)) === null;
        } finally {
            draftStore.finishSubmit(threadScope(rootId), sent);
        }
    };
    return (
        <div className="composer">
            {error !== null ? <p className="status">{error}</p> : null}
            <ChatInput
                id={FOLLOW_UP_INPUT_ID}
                label="Ask for a follow-up"
                value={draft}
                readOnly={frozen}
                onChange={(e) =>
                    draftStore.updateFollowUp(rootId, (current) => ({
                        ...current,
                        text: e.target.value,
                        submissionKey: null,
                    }))
                }
                fieldProps={{
                    ...dropAndPaste,
                    // Ctrl/⌘+Enter walks the same guarded path the arrow takes.
                    onKeyDown: (e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                    },
                }}
                files={files}
                limits={limits}
                send={{
                    label: frozen ? 'Sending…' : 'Send follow-up',
                    disabled: blocked,
                    busy: frozen,
                    onSend: () => void send(),
                }}
                status={
                    <span className="composer-blocker" role="status">
                        {files.blocker === null
                            ? ''
                            : files.blocker === 'uploading'
                              ? 'Wait for the files to finish uploading.'
                              : 'Remove or retry the failed files to continue.'}
                    </span>
                }
            />
        </div>
    );
}

/** What the follow-up composer hands up: the words, and the uploaded files when it carries any. */
type OnFollowUp = (command: string, files?: SubmittedFiles) => Promise<string | null>;

/** The fallback notice (issue 226): the run ended on a question and nothing could ask it in place. */
const ENDED_ON_QUESTION_REPLY = 'Claude ended with a question. Reply below to continue the same conversation.';
const ENDED_ON_QUESTION_AUTHOR = "Claude ended with a question. The task's author can reply with a follow-up.";

/**
 * The follow-up slot, by `followUpEligibility`: the composer for the task's author; a sentence
 * for a sessionless run or another member's task; nothing while the session loads (so the
 * author's own task never flashes a refusal), while the run moves, or once the task is closed.
 */
function FollowUp({
    latest,
    rootId,
    draftStore,
    viewer,
    error,
    sending,
    onFollowUp,
    adder,
}: {
    latest: Job;
    rootId: string;
    draftStore: ComposerDraftStore;
    viewer: FollowUpViewer;
    error: string | null;
    sending: boolean;
    onFollowUp: OnFollowUp;
    adder: MutableRefObject<((files: File[]) => void) | null>;
}) {
    const eligibility = followUpEligibility(latest, viewer);
    const asked = endedOnQuestion(latest);
    let body: ReactNode = null;
    if (eligibility === 'eligible') {
        body = (
            <>
                {asked ? <p className="status">{ENDED_ON_QUESTION_REPLY}</p> : null}
                <FollowUpComposer
                    rootId={rootId}
                    draftStore={draftStore}
                    error={error}
                    sending={sending}
                    onFollowUp={onFollowUp}
                    adder={adder}
                />
            </>
        );
    } else if (eligibility === 'not-author') {
        body = (
            <>
                {asked ? <p className="status">{ENDED_ON_QUESTION_AUTHOR}</p> : null}
                <p className="muted">{notAuthorMessage(latest)}</p>
            </>
        );
    }
    if (body === null) return null;
    return (
        <section className="task-follow-up" aria-label="Follow up">
            {body}
        </section>
    );
}

/** Changes exactly when the thread's content does — a poll that brings the same rows leaves it. */
function threadContentKey(jobs: Job[] | null): string {
    return (jobs ?? [])
        .map(
            (j) => `${j.id}:${j.status}:${j.output?.length ?? 0}:${j.summary?.length ?? 0}:${j.questions?.length ?? 0}`
        )
        .join('|');
}

/** The output the live-following well tracks: the newest run's, only while it can still move. */
function liveOutputOf(latest: Job | null | undefined): string | null | undefined {
    return latest && !isTerminal(latest.status) ? latest.output : undefined;
}

/** Offered when output landed under a reader who scrolled up: the way back to the newest line. */
/**
 * The thread poll's failure, said as an alert with a way to ask again now. The poll keeps its own
 * retry pace; the button only spares the reader the wait.
 */
function ThreadError({ message, onRetry }: { message: string; onRetry: () => void }) {
    return (
        <>
            <StateNote state="error">{message}</StateNote>
            <button type="button" onClick={onRetry}>
                Retry
            </button>
        </>
    );
}

function JumpToLatest({ show, onJump }: { show: boolean; onJump: () => void }) {
    if (!show) return null;
    return (
        <button type="button" className="task-jump" onClick={onJump}>
            Jump to latest
        </button>
    );
}

/**
 * One task, whole: the page's `header`, the right column (`task-rail`) — the caller's `controls`
 * tile, then the outcome, verification, task activity and services tiles — and the main column:
 * the conversation (every run's request and response, the root first) and the follow-up. DOM
 * order is header, rail, main, so a narrow screen reads the title, the controls and the tiles
 * before the conversation; from 1024px the rail is a full-height right column beside both.
 *
 * Props in, markup out, like every panel: the detail poll lives in the page (`useThread`) and
 * this component owns only the follow-up draft and the live-output tail. Follow-ups are new rows
 * on the board (an audit record of what ran), but they are NOT new tasks here: the chain renders
 * top to bottom in this one view, and sending an adjustment extends it in place.
 */
export function TaskDetail({
    header,
    controls,
    jobs,
    viewer,
    error,
    onRetry,
    actionError,
    followUpError,
    sending,
    onFollowUp,
    draftStore,
    onAnswer,
    onConnectionChange,
    activity = NO_ACTIVITY,
}: {
    /** The page's head: title, id line, batch backlink. Rendered whatever the poll holds. */
    header: ReactNode;
    /** The right column's first tile (the page's `TaskControls`); null until the thread lands. */
    controls: ReactNode;
    /** The task's whole chain, oldest first — null until the thread poll lands. */
    jobs: Job[] | null;
    /** Who is looking — only the task's author is offered the composer. */
    viewer: FollowUpViewer;
    /** Why the thread poll's last tick failed. Said in place, never silently; the poll keeps trying. */
    error: string | null;
    /** Polls the thread again now, instead of waiting for the next tick. */
    onRetry: () => void;
    /** Why the last stop or Mark done did not land. Said under the header. */
    actionError: string | null;
    /** Why the last follow-up did not queue. Said inside the composer, beside the draft. */
    followUpError: string | null;
    sending: boolean;
    onFollowUp: OnFollowUp;
    /** The shell's held drafts: this thread's follow-up draft lives there. */
    draftStore: ComposerDraftStore;
    /** Answers a run's question; the page refreshes the thread once it settles. */
    onAnswer: OnAnswer;
    /** Re-reads the thread after a connection requirement was bound or dismissed. */
    onConnectionChange: () => void;
    /**
     * Every run's activity answer (issues 339, 530), fetched by the page's hook — the panel draws
     * what it is handed, and a run with no answer yet is "loading", never a zero.
     */
    activity?: ThreadActivity;
}) {
    const followUpAdd = useRef<((files: File[]) => void) | null>(null);

    // The conversation continues on the newest run: the composer, the live-output tail and the
    // Done verdict all belong to it. Computed before the early return, because the scroll effect
    // below needs it on every render.
    const latest = jobs === null || jobs.length === 0 ? null : jobs[jobs.length - 1];

    // Three scrollers follow what streams in, each only while its reader is near its own bottom
    // (BEL-263): the conversation (with a Jump to latest when the reader is away), and the live
    // run's raw-output well. The log opened from its summary lands on the tail in `TaskRun`.
    // `jobs` changes identity with every poll; the hook judges height, not identity.
    const conversation = useStickToBottom<HTMLElement>(threadContentKey(jobs));
    const liveWell = useStickToBottom<HTMLPreElement>(liveOutputOf(latest));

    if (jobs === null || jobs.length === 0) {
        return (
            <>
                {header}
                <section className="panel">
                    {error !== null ? (
                        <ThreadError message={error} onRetry={onRetry} />
                    ) : (
                        <p className="muted">Loading the task…</p>
                    )}
                </section>
            </>
        );
    }

    // The early return above guarantees a non-empty chain, and `latestTask` is its newest member.
    const latestTask = latest as Job;
    const gates = latestTask.gates ?? null;
    const services = latestTask.runtime?.services ?? null;

    return (
        <div className="task-layout">
            <div className="task-head">
                {header}
                {/* The action error sits under the title — it is about the reader's last stop or
                Mark done, not about either column's content. */}
                {actionError !== null ? <p className="status">{actionError}</p> : null}
                {error !== null ? <ThreadError message={error} onRetry={onRetry} /> : null}
            </div>
            <aside className="task-rail" aria-label="Task details">
                {controls}
                <TaskOutcome jobs={jobs} />
                {gates !== null && gates.length > 0 ? (
                    <Verification gates={gates} terminal={isTerminal(latestTask.status)} />
                ) : null}
                {/* The thread's execution facts, the latest run's pulse and the statistics modal (issue 530). */}
                <TaskActivity jobs={jobs} activity={activity} />
                {services !== null && services.length > 0 ? <Services services={services} /> : null}
            </aside>
            <AttachmentDropZone
                className="task-main"
                accepts={() => followUpAdd.current !== null}
                onFiles={(dropped) => followUpAdd.current?.(dropped)}
            >
                <div className="task-thread">
                    {/* The one scroll region: the composer below is its sibling, never inside it. */}
                    <section className="task-conversation" aria-label="Conversation" ref={conversation.ref}>
                        <div className="panel-head">
                            <h2>Conversation</h2>
                        </div>
                        {jobs.map((task, index) => (
                            <TaskRun
                                key={task.id}
                                job={task}
                                index={index + 1}
                                liveRef={
                                    task.id === latestTask.id && !isTerminal(task.status) ? liveWell.ref : undefined
                                }
                                onAnswer={onAnswer}
                                connect={
                                    task.id === latestTask.id ? { viewer, onChanged: onConnectionChange } : undefined
                                }
                            />
                        ))}
                    </section>
                    <JumpToLatest show={conversation.hasUnseen} onJump={conversation.jumpToLatest} />
                </div>
                <FollowUp
                    latest={latestTask}
                    rootId={jobs[0]?.id ?? latestTask.id}
                    draftStore={draftStore}
                    viewer={viewer}
                    error={followUpError}
                    sending={sending}
                    onFollowUp={onFollowUp}
                    adder={followUpAdd}
                />
            </AttachmentDropZone>
        </div>
    );
}
