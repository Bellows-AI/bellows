import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import { useDownwardAnchor } from '../anchor.js';
import { isTerminal, type Job } from '../api/useJobs.js';
import { PRODUCT_NAME } from '../brand.js';
import { Icon, type IconName } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';
import { RelativeTime } from '../components/RelativeTime.js';
import { wallClock } from '../format.js';
import { taskTitleText } from '../task-title.js';
import {
    type FollowUpEligibility,
    type FollowUpViewer,
    followUpEligibility,
    gateCounts,
    isWaitingForReview,
    threadOwnerOf,
} from '../task-outcome.js';
import {
    type TaskTone,
    taskDotClass,
    taskStatusLabel,
    taskSummary,
    taskTone,
    threadNeedsAnswer,
} from '../task-tree.js';

/** The composer's field — Ask for another pass lands the caret there instead of sending anything. */
export const FOLLOW_UP_INPUT_ID = 'follow-up-command';

/** Ask for another pass, wherever it is offered: the caret lands in the composer, nothing is sent. */
export const focusFollowUp = (): void => document.getElementById(FOLLOW_UP_INPUT_ID)?.focus();

/**
 * A failure the member can answer with another pass — the run's own, or a failed gate — on a task
 * nobody has closed and no review wait holds (an open wait is the workflow's to settle).
 */
export function needsAnotherPass(latest: Job): boolean {
    if (!isTerminal(latest.status) || latest.doneAt !== null || isWaitingForReview(latest)) return false;
    return latest.status === 'failed' || latest.status === 'dead' || gateCounts(latest.gates).failed > 0;
}

/** Why the viewer gets no composer on another member's task — one sentence, said the same everywhere. */
export const notAuthorMessage = (latest: Job): string =>
    `Only ${threadOwnerOf(latest)?.login ?? 'the task author'} can continue this session. You can still mark it done.`;

/**
 * Each tone's pill, per the status table in `docs/design-system.md`: the class, then the mark —
 * a glyph, or `lamp` for the embedded status dot a live run wears. The label is always
 * `taskStatusLabel`'s text; the mark is `aria-hidden`.
 */
const TONE_PILL: Record<TaskTone, { className: string; mark: IconName | 'lamp' | null }> = {
    none: { className: 'pill', mark: null },
    answer: { className: 'pill pill-accent', mark: 'circle-dot' },
    queued: { className: 'pill pill-done', mark: 'clock' },
    running: { className: 'pill pill-ok', mark: 'lamp' },
    stopping: { className: 'pill pill-done', mark: 'lamp' },
    waiting: { className: 'pill pill-done task-pill-wait', mark: 'clock' },
    review: { className: 'pill pill-accent', mark: 'circle-dot' },
    failed: { className: 'pill pill-bad', mark: 'alert-circle' },
    stopped: { className: 'pill pill-done', mark: 'minus-circle' },
    done: { className: 'pill pill-done task-pill-done', mark: 'check-circle' },
};

/**
 * A task's state as the one toned pill the header and the outcome rail share — the same
 * `taskTone` precedence the inbox row and the sidebar dot read, so the four never disagree.
 * `live` makes it the page's one polite live region — the header's; a poll that lands the same
 * text announces nothing, and a second live copy would announce every change twice.
 */
export function TaskStatePill({ jobs, live = false }: { jobs: Job[]; live?: boolean }) {
    const job = { ...jobs[jobs.length - 1]!, needsAnswer: threadNeedsAnswer(jobs) };
    const pill = TONE_PILL[taskTone(job)];
    return (
        <span className={pill.className} aria-live={live ? 'polite' : undefined}>
            {pill.mark === 'lamp' ? (
                <span className={`sidenav-dot ${taskDotClass(job)}`} aria-hidden="true" />
            ) : pill.mark !== null ? (
                <Icon name={pill.mark} size={14} />
            ) : null}
            {taskStatusLabel(job)}
        </span>
    );
}

/** The one primary action the matrix (plan §3.2) gives the newest run. */
export type PrimaryAction = 'stop' | 'stopping' | 'ask' | 'mark-done' | 'none';

/**
 * The action matrix as data: a live run is stopped (or is stopping, once this click or the
 * board's own stamp says so); a closed task has no primary; a failure — the run's own, or a
 * failed gate — asks for another pass when the viewer may send one and no review wait holds the
 * task; every other terminal task is marked done.
 */
export function primaryAction(latest: Job, stoppingId: string | null, eligibility: FollowUpEligibility): PrimaryAction {
    if (!isTerminal(latest.status)) {
        return stoppingId === latest.id || latest.cancelRequestedAt !== null ? 'stopping' : 'stop';
    }
    if (latest.doneAt !== null) return 'none';
    return needsAnotherPass(latest) && eligibility === 'eligible' ? 'ask' : 'mark-done';
}

/** The closure's attribution, never a disabled control: who closed it, and when. */
function ClosedBy({ latest }: { latest: Job }) {
    return (
        <p className="muted task-closed">
            {latest.doneBy !== null ? `Closed by ${latest.doneBy.login}` : 'Closed'} ·{' '}
            <RelativeTime at={latest.doneAt} />
        </p>
    );
}

/** The one primary control the matrix picked — or, on a closed task, the closure in words. */
function PrimaryControl({
    latest,
    primary,
    marking,
    onStop,
    onDone,
}: {
    latest: Job;
    primary: PrimaryAction;
    marking: boolean;
    onStop: (id: string) => Promise<void>;
    onDone: (id: string) => Promise<void>;
}) {
    switch (primary) {
        case 'stop':
            return (
                <button type="button" className="chat-resume chat-stop" onClick={() => void onStop(latest.id)}>
                    Stop run
                </button>
            );
        case 'stopping':
            // This click in flight and the board's landed stamp read the same: busy, not clickable.
            return (
                <button type="button" className="chat-resume chat-stop" disabled aria-busy="true">
                    Stopping…
                </button>
            );
        case 'ask':
            // No send: the caret lands in the composer, and the member says what the pass is for.
            return (
                <button type="button" className="primary" onClick={focusFollowUp}>
                    Ask for another pass
                </button>
            );
        case 'mark-done':
            return (
                <button type="button" className="primary" disabled={marking} onClick={() => void onDone(latest.id)}>
                    {marking ? 'Marking done…' : 'Mark done'}
                </button>
            );
        case 'none':
            return <ClosedBy latest={latest} />;
    }
}

/**
 * The **More task actions** overflow: Mark done while the primary is Ask for another pass, Rename
 * task for its author or an admin, and Remove task while no member of the thread is running (the
 * board's 409 TASK_RUNNING stays the authority on any race the UI cannot see). Remove is the
 * destructive voice and lives nowhere else. Null when it would hold nothing.
 */
function MoreMenu({
    markDone,
    marking,
    removeAvailable,
    onDone,
    onRemoveRequest,
    onRenameRequest,
}: {
    markDone: boolean;
    marking: boolean;
    removeAvailable: boolean;
    onDone: () => void;
    onRemoveRequest: () => void;
    onRenameRequest: (() => void) | null;
}) {
    // Downward-only (issue 224): Headless UI's `anchor` prop always adds a `flip` middleware
    // with no way to disable it, so it is bypassed in favor of `useDownwardAnchor`.
    const { setReference, setFloating, floatingStyles } = useDownwardAnchor('end');
    if (!markDone && !removeAvailable && onRenameRequest === null) return null;
    return (
        <Menu>
            <MenuButton ref={setReference} className="chat-resume" aria-label="More task actions">
                More
                <Icon name="chevron-down" size={14} />
            </MenuButton>
            {/* Focus lands back on this trigger — the menu restores it on close, and the dialogs
            Rename and Remove open restore it to the element focused before they captured the caret. */}
            <MenuItems ref={setFloating} style={floatingStyles} portal className="popover">
                {markDone ? (
                    <MenuItem>
                        <button type="button" className="popover-option" disabled={marking} onClick={onDone}>
                            {marking ? 'Marking done…' : 'Mark done'}
                        </button>
                    </MenuItem>
                ) : null}
                {onRenameRequest !== null ? (
                    <MenuItem>
                        <button type="button" className="popover-option" onClick={onRenameRequest}>
                            Rename task
                        </button>
                    </MenuItem>
                ) : null}
                {removeAvailable ? (
                    <MenuItem>
                        <button type="button" className="popover-option chat-remove" onClick={onRemoveRequest}>
                            Remove task
                        </button>
                    </MenuItem>
                ) : null}
            </MenuItems>
        </Menu>
    );
}

/** A task id is a uuid; the head names it by its first block, with the whole id on hover. */
const SHORT_ID_LENGTH = 8;

/**
 * The page-level head of `/tasks/:id`, derived from the loaded thread: the task's name — its stored
 * title, else the root command's first line (`taskTitleText`) — as the page's one `h1`, and
 * `#id · Opened …` beneath it. Who opened it, the repo, the state and the actions are the right
 * column's (`TaskControls`, `TaskActivity`), never repeated here.
 */
export function TaskHeader({
    jobs,
}: {
    /** The task's whole chain, oldest first — null until the thread poll lands. */ jobs: Job[] | null;
}) {
    if (jobs === null || jobs.length === 0) {
        // No task yet, so there is nothing to name — the detail poll has not landed. No eyebrow:
        // "Tasks" over "Tasks" says the same thing twice.
        return <PageHeader title="Tasks" />;
    }
    const rootTask = jobs[0]!;
    const displayName = taskTitleText(rootTask);
    return (
        <PageHeader
            eyebrow="Tasks"
            title={displayName}
            titleClassName="task-heading"
            titleTooltip={displayName}
            description={
                <span className="task-meta-line">
                    <span title={rootTask.id}>#{rootTask.id.slice(0, SHORT_ID_LENGTH)}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                        Opened <RelativeTime at={rootTask.createdAt} />
                    </span>
                </span>
            }
        />
    );
}

/**
 * The right column's first tile: the task's wall clock, its state pill (the page's one live
 * region), the live summary, a review wait in words, and one small primary action plus the
 * overflow. The pill is `taskStatusLabel` / `taskTone` of the newest run — the one precedence the
 * inbox and sidebar share. The actions follow `primaryAction`; Stop, Mark done and Remove carry no
 * author restriction — only a follow-up does (`followUpEligibility`), because only the board's
 * follow-up route checks the author. Prop-driven: the mutations and dialogs live in the page.
 */
export function TaskControls({
    jobs,
    viewer,
    stoppingId,
    doneId,
    onStop,
    onDone,
    onRemoveRequest,
    onRenameRequest,
}: {
    /** The task's whole chain, oldest first; non-empty. */
    jobs: Job[];
    /** Who is looking — decides whether a failure asks for another pass or offers Mark done. */
    viewer: FollowUpViewer;
    /** The page's in-flight guards: a mutation mid-request relabels its control, once. */
    stoppingId: string | null;
    doneId: string | null;
    onStop: (id: string) => Promise<void>;
    onDone: (id: string) => Promise<void>;
    /** Opens the page's remove confirmation — the menu item never mutates by itself. */
    onRemoveRequest: () => void;
    /** Opens the page's rename dialog; offered only to the task's author or an admin. */
    onRenameRequest: () => void;
}) {
    // The newest member is the run the actions act on; the ROOT carries the author.
    const latestTask = jobs[jobs.length - 1]!;
    const rootTask = jobs[0]!;
    const primary = primaryAction(latestTask, stoppingId, followUpEligibility(latestTask, viewer));
    // Remove is hidden while any member is running — not merely the newest. Queued members do
    // not block it; nothing on the board is executing them.
    const removeAvailable = !jobs.some((task) => task.status === 'running');
    // The task's live summary — the newest run's activity line, while there is one.
    const summary = taskSummary(latestTask.id, jobs);
    const verificationFailed = gateCounts(latestTask.gates).failed > 0;
    const waiting = isWaitingForReview(latestTask);
    // The board checks the same: the task's author or an org admin renames (the viewer's role comes from the session).
    const canRename = !viewer.loading && (viewer.admin || (viewer.id !== null && rootTask.author?.id === viewer.id));
    const marking = doneId === latestTask.id;
    return (
        <section className="panel task-controls" aria-label="Task controls">
            {/* The overall wall clock: everything the board has banked for the task, plus the head
            run's live segment while it is going — the 2s poll is the ticker. A task that has
            never run says so with a dash, not a zero. */}
            <p className="task-clock">
                Wall clock{' '}
                <span className="task-clock-value">
                    {wallClock(latestTask.taskWallClockMs, latestTask.status === 'running' ? latestTask : null)}
                </span>
            </p>
            <p className="task-controls-state">
                <TaskStatePill jobs={jobs} live />
                {verificationFailed ? (
                    <span className="pill pill-bad">
                        <Icon name="alert-circle" size={14} />
                        Verification failed
                    </span>
                ) : null}
            </p>
            {summary !== null ? <p className="task-summary">{summary}</p> : null}
            {waiting ? (
                <p className="muted task-wait">
                    {PRODUCT_NAME} is waiting for review — no executor is occupied while it waits. Waiting since{' '}
                    <RelativeTime at={latestTask.waitingSince} />.
                </p>
            ) : null}
            {!waiting && latestTask.waitTerminalReason !== null ? (
                <p className="muted task-wait">Review wait ended: {latestTask.waitTerminalReason}.</p>
            ) : null}
            <div className="task-actions">
                <PrimaryControl
                    latest={latestTask}
                    primary={primary}
                    marking={marking}
                    onStop={onStop}
                    onDone={onDone}
                />
                <MoreMenu
                    markDone={primary === 'ask'}
                    marking={marking}
                    removeAvailable={removeAvailable}
                    onDone={() => void onDone(latestTask.id)}
                    onRemoveRequest={onRemoveRequest}
                    onRenameRequest={canRename ? onRenameRequest : null}
                />
            </div>
        </section>
    );
}
