import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react';
import { isTerminal, type GateCheck, type Job } from '../api/useJobs.js';
import type { AnswerOutcome } from '../api/answer-question.js';
import { Icon } from '../components/Icon.js';
import { elapsedSeconds } from '../format.js';
import { FAILURE_KIND_LABEL, GATE_PILL, gateCounts, gateStatusLabel, inClosePhase } from '../task-outcome.js';
import type { FollowUpViewer } from '../task-outcome.js';
import { AttachmentHistory } from './AttachmentList.js';
import { TaskConnect } from './TaskConnect.js';
import { TaskQuestion } from './TaskQuestion.js';
import { TaskSection } from './TaskSection.js';

/**
 * One output well: a clipped log a keyboard user can actually reach. The wrapping section names
 * the region; the `pre` carries the focus, because it is the element that scrolls — keyboard
 * scroll chains walk up from the focused element, never down into a descendant. `gate` is a
 * verification gate's variant: sunken, lines kept whole and scrolled.
 */
function OutputWell({
    text,
    label,
    gate = false,
    liveRef,
}: {
    text: string;
    label?: string;
    gate?: boolean;
    liveRef?: Ref<HTMLPreElement> | undefined;
}) {
    return (
        <section className="run-well" aria-label={label}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-focusable or its overflow is unreachable */}
            <pre className={gate ? 'chat-output gate-output' : 'chat-output'} tabIndex={0} ref={liveRef}>
                {text}
            </pre>
        </section>
    );
}

/**
 * The one raw-output disclosure every run shares, live or finished. Controlled by the run's own
 * `open` state, so polling and the live-to-finished transition keep the reader's choice; the well
 * stays mounted while collapsed, so a live log keeps updating. Opening a live run lands on its
 * newest line.
 */
function RawOutput({
    text,
    open,
    live,
    onOpenChange,
    liveRef,
}: {
    text: string;
    open: boolean;
    live: boolean;
    onOpenChange: (open: boolean) => void;
    liveRef?: Ref<HTMLPreElement> | undefined;
}) {
    return (
        <details
            className="run-output"
            open={open}
            onToggle={(e) => {
                const details = e.currentTarget;
                onOpenChange(details.open);
                const log = details.querySelector('pre');
                if (details.open && live && log) log.scrollTop = log.scrollHeight;
            }}
        >
            <summary>View raw output</summary>
            <OutputWell text={text} label="Raw output" liveRef={liveRef} />
        </details>
    );
}

/** How the page answers a question: the board's answer POST, settled to the state it shows. */
export type OnAnswer = (jobId: string, questionId: string, answers: Record<string, string>) => Promise<AnswerOutcome>;

/** What the newest run needs to raise the thread's connection requirements. */
export interface ConnectContext {
    viewer: FollowUpViewer;
    /** Re-reads the thread once a requirement was bound or dismissed. */
    onChanged: () => void;
}

/**
 * The run's decisions: the thread's open connection requirements first (only the newest run carries
 * `connect`), then its AskUserQuestion calls, oldest first — each one its own form or its settled record.
 */
function RunQuestions({
    job,
    onAnswer,
    connect,
}: {
    job: Job;
    onAnswer: OnAnswer;
    connect?: ConnectContext | undefined;
}) {
    const asked = [...job.questions].sort((a, b) => a.askedAt.localeCompare(b.askedAt));
    return (
        <>
            {connect !== undefined ? (
                <TaskConnect job={job} viewer={connect.viewer} onChanged={connect.onChanged} />
            ) : null}
            {asked.map((question) => (
                <TaskQuestion
                    key={question.id}
                    question={question}
                    onAnswer={(questionId, answers) => onAnswer(job.id, questionId, answers)}
                />
            ))}
        </>
    );
}

/**
 * The live run's one-line pulse: once the agent has finished and the declared gates are walking,
 * a spinner and "Running checks" (the gates themselves are the Verification tile's); before that,
 * the agent's own activity line. Nothing when neither is known.
 */
function LiveActivity({ job }: { job: Job }) {
    if (inClosePhase(job)) {
        return (
            <p className="chat-activity run-checking" role="status">
                <span className="run-spinner" aria-hidden="true" />
                Running checks
            </p>
        );
    }
    if (job.status !== 'running' || job.runtime?.activity == null) return null;
    return <p className="chat-activity">{job.runtime.activity}</p>;
}

/**
 * The agent response/activity body: a terminal run's summary, or a live run's activity
 * line, then the run's questions, then the run's raw-output disclosure. Split out of `TaskRun` — the nested "which branch of
 * the run's life is this" choice was the bulk of its cognitive complexity.
 */
function RunResponseBody({
    terminal,
    job,
    open,
    onOpenChange,
    liveRef,
    questions,
}: {
    terminal: boolean;
    job: Job;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    liveRef?: Ref<HTMLPreElement> | undefined;
    questions: ReactNode;
}) {
    const hasOutput = job.output !== null;
    if (!terminal) {
        return (
            <>
                <LiveActivity job={job} />
                {questions}
                {hasOutput ? (
                    <RawOutput text={job.output!} open={open} live onOpenChange={onOpenChange} liveRef={liveRef} />
                ) : (
                    <p className="muted">Waiting for the executor…</p>
                )}
            </>
        );
    }
    let lead: ReactNode;
    if (job.summary !== null) {
        // The agent's own last words, flowing text — never a log wall.
        lead = <p className="run-summary">{job.summary}</p>;
    } else if (hasOutput) {
        lead = <p className="muted">No agent summary was captured.</p>;
    } else {
        lead = (
            <p className="muted">
                This run finished without a captured agent response. Check its exit status and checks below.
            </p>
        );
    }
    return (
        <>
            {lead}
            {questions}
            {hasOutput ? <RawOutput text={job.output!} open={open} live={false} onOpenChange={onOpenChange} /> : null}
        </>
    );
}

/** An admin's turn on another member's task: who queued it, and on behalf of whom. */
function ActingForNote({ job }: { job: Job }) {
    if (job.actingFor === null) return null;
    return (
        <span className="muted">
            queued by {job.author?.login ?? 'an admin'} on behalf of {job.actingFor.login}
        </span>
    );
}

/**
 * The run's own notes the right column does not already carry: why it failed, which workflow node
 * it ran, who queued it for whom, who stopped or closed it. Status, timestamps, executor, duration,
 * exit and tokens are the Controls and Task activity tiles' — never repeated per run. Nothing at
 * all when there is no note.
 */
function RunNotes({ job }: { job: Job }) {
    const quiet =
        job.failureKind == null &&
        job.workflowNode === null &&
        job.actingFor === null &&
        job.stoppedBy === null &&
        job.doneAt === null &&
        job.doneBy === null;
    if (quiet) return null;
    return (
        <p className="msg-meta">
            {/* The structured terminal reason (issue 339): the one-glance answer to "why did it
                fail", instead of making the reader scan the output tail for the driver's note. */}
            {job.failureKind != null ? (
                <span className="pill pill-bad">{FAILURE_KIND_LABEL[job.failureKind]}</span>
            ) : null}
            {job.workflowNode !== null ? <span className="muted">node {job.workflowNode}</span> : null}
            <ActingForNote job={job} />
            {job.stoppedBy !== null ? (
                <span className="pill chat-stop">
                    {job.status === 'stopped' ? 'stopped by' : 'stop requested by'} {job.stoppedBy.login}
                </span>
            ) : null}
            {job.doneAt !== null ? <span className="pill chat-done">done</span> : null}
            {job.doneBy !== null ? <span className="pill chat-done">done by {job.doneBy.login}</span> : null}
        </p>
    );
}

/**
 * One run of the conversation, as one article named `Run N` with a fixed reading order and no
 * section labels: the member's bubble, the agent's response (or its live activity), and a quiet
 * metadata footer last. The stored `summary`
 * is the terminal response; raw output is untrusted text in a labelled, keyboard-scrollable well,
 * behind one `View raw output` disclosure per run — never a fabricated response. `liveRef` lands on the newest non-terminal run's output pre, so the page
 * can follow the tail — the ref and its effect live in the page's panel, not here. Verification
 * and published work are the task's, not a run's: `TaskDetail` renders them once, below.
 */
export function TaskRun({
    job,
    index,
    liveRef,
    onAnswer,
    connect,
}: {
    /** The run's row. */
    job: Job;
    /** The run's 1-based position in the oldest-first chain — names the request. */
    index: number;
    /** Ref for the newest non-terminal run's output pre; absent everywhere else. */
    liveRef?: Ref<HTMLPreElement> | undefined;
    onAnswer: OnAnswer;
    /** Present on the newest run only: the thread's connection requirements render there. */
    connect?: ConnectContext | undefined;
}) {
    const terminal = isTerminal(job.status);
    // Live logs start expanded; a finished run's log starts collapsed behind its summary, and
    // expanded when it is all there is. State is per mounted run (keyed by job id in
    // `TaskDetail`), so polling, appended follow-ups and the live-to-finished transition keep it.
    const [open, setOpen] = useState(!terminal || job.summary === null);
    return (
        <article className="chat-exchange" aria-label={`Run ${index}`}>
            {/* The member's words are a chat bubble on the right: prose, not code, line breaks kept. */}
            <p className="msg-user">{job.command}</p>
            <AttachmentHistory attachments={job.attachments} />
            <RunResponseBody
                terminal={terminal}
                job={job}
                open={open}
                onOpenChange={setOpen}
                liveRef={liveRef}
                questions={<RunQuestions job={job} onAnswer={onAnswer} connect={connect} />}
            />
            <RunNotes job={job} />
        </article>
    );
}

/** How long the Copied acknowledgement stays before the button reads Copy again. */
const COPIED_RESET_MS = 2000;

/**
 * Copies `text` to the clipboard. A refused clipboard leaves the button reading Copy — the text
 * is still on screen to select by hand. The accessible name says WHAT it copies. One reset timer
 * at a time, cleared on unmount, so a repeat click or a navigation never lands a stale reset.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false);
    const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (reset.current !== null) clearTimeout(reset.current);
        },
        []
    );
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            if (reset.current !== null) clearTimeout(reset.current);
            reset.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
        } catch {
            setCopied(false);
        }
    };
    return (
        <button type="button" className="chat-resume task-copy" aria-label={label} onClick={() => void copy()}>
            <Icon name="copy" size={14} />
            {copied ? 'Copied' : 'Copy'}
        </button>
    );
}

/** Gate outcomes in reading order: what failed first, then what passed, then what is still going. */
const GATE_ORDER: readonly GateCheck['status'][] = ['failed', 'passed', 'running', 'pending', 'skipped'];

/**
 * The count pills: one per outcome that happened, words carrying the meaning — the tint is never
 * the only signal, and a zero is never drawn at all ("0 failed" is no news).
 */
export function GateCountPills({
    gates,
    terminal,
}: {
    gates: GateCheck[] | null | undefined;
    /** Whether the run is over: a gate still `pending` then never ran. */
    terminal: boolean;
}) {
    const counts = gateCounts(gates);
    return (
        <>
            {GATE_ORDER.filter((status) => counts[status] > 0).map((status) => (
                <span key={status} className={GATE_PILL[status]}>
                    {counts[status]} {gateStatusLabel(status, terminal)}
                </span>
            ))}
        </>
    );
}

/**
 * The task's verification: the newest run's gates, as the board last reported them — there is no
 * history and no per-test tree, because the board stores neither. Each gate is a native
 * `<details>` (collapsible with no JavaScript, visible to the render-to-string suite); a failed
 * gate starts open, because its output is what the reader came for. The output is the gate's own
 * mono well with its own scroll and a copy button.
 */
export function Verification({ gates, terminal }: { gates: GateCheck[]; terminal: boolean }) {
    const counts = gateCounts(gates);
    const walking = !terminal && counts.running + counts.pending > 0;
    return (
        <TaskSection
            title="Verification"
            className="task-verification"
            defaultOpen={counts.failed > 0 || walking}
            aside={<GateCountPills gates={gates} terminal={terminal} />}
        >
            <ul className="chat-gate-list">
                {gates.map((gate) => {
                    // The running gate counts its seconds from the driver's stamp; the 2 s thread
                    // poll is the ticker.
                    const running = !terminal && gate.status === 'running';
                    const elapsed = running ? elapsedSeconds(gate.startedAt) : null;
                    return (
                        <li key={gate.name}>
                            <details open={gate.status === 'failed'}>
                                <summary>
                                    <span>{gate.name}</span>
                                    {elapsed !== null ? <span className="chat-activity">{elapsed}</span> : null}
                                    <span className={GATE_PILL[gate.status]}>
                                        {running ? <span className="run-spinner" aria-hidden="true" /> : null}
                                        {gateStatusLabel(gate.status, terminal)}
                                    </span>
                                    {gate.exitCode !== null ? (
                                        <span className="chat-exit">exit {gate.exitCode}</span>
                                    ) : null}
                                </summary>
                                {gate.output !== null ? (
                                    <div className="gate-output-wrap">
                                        <CopyButton text={gate.output} label={`Copy output of ${gate.name}`} />
                                        <OutputWell text={gate.output} label={`Output of ${gate.name}`} gate />
                                    </div>
                                ) : null}
                            </details>
                        </li>
                    );
                })}
            </ul>
        </TaskSection>
    );
}
