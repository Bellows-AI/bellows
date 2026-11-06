import {
    Listbox,
    ListboxButton,
    ListboxOption,
    ListboxOptions,
    Popover,
    PopoverButton,
    PopoverPanel,
} from '@headlessui/react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, RefObject } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDownwardAnchor } from '../anchor.js';
import { Avatar } from '../components/Avatar.js';
import { Icon } from '../components/Icon.js';
import type { IconName } from '../components/Icon.js';
import { PageHeader } from '../components/PageHeader.js';
import { RelativeTime } from '../components/RelativeTime.js';
import { StateNote } from '../components/StateNote.js';
import { useTasksPage } from './TasksLayout.js';
import { trackedRepos } from '../api/useRepos.js';
import { inboxQueryString, QUERY_MAX } from '../api/useTasks.js';
import type { InboxFilters, TaskNavigation, TaskSummary, UseTasks } from '../api/useTasks.js';
import { groupByDay } from '../inbox-groups.js';
import { taskTitleText } from '../task-title.js';
import { taskDotClass, taskStatusLabel, taskTone } from '../task-tree.js';
import type { TaskStatus, TaskTone } from '../task-tree.js';

/**
 * `/tasks` — the task inbox. Everything it renders comes from the ONE task poll the shell owns
 * (`useTasksPage()`), never from a poll of its own; the query normalization and fetch logic live
 * in `useTasks.ts`. The filters are URL state (see `inboxFiltersFromSearch`): linkable, and
 * Back/Forward moves them — this page only writes back what its controls change.
 *
 * Top to bottom: the header (title and New task), the state tabs carrying the organization
 * counts, one quiet toolbar — search, then the repository, author and sort triggers in the
 * composer's borderless `select-trigger` skin, each applied the moment it is picked — one chip per
 * applied filter, the rows grouped by local day, and a footer that counts only what is loaded.
 * The row grammar: a status mark, the title (the row's ONE link, stretched over the row) over its
 * one-line summary, the state as a toned pill with a VISIBLE label, repository over executor,
 * author, and the relative last activity backed by a precise `<time>`.
 */

/** The tabs. `review` is still a URL state (the sidenav's "more need review" link opens it), but
 * it is a subset of Needs attention, so it has no tab: it shows as a removable chip instead. */
const STATES: readonly { value: InboxFilters['state']; label: string }[] = [
    { value: 'attention', label: 'Needs attention' },
    { value: 'running', label: 'Running' },
    { value: 'past', label: 'Past' },
];

const SORTS: readonly { value: InboxFilters['sort']; label: string; short: string }[] = [
    { value: 'newest', label: 'Newest first', short: 'Newest' },
    { value: 'oldest', label: 'Oldest first', short: 'Oldest' },
];

/** The filters a chip stands for — state has its tab and sort its trigger. */
const CHIPS: readonly { key: 'q' | 'repo' | 'author'; label: string }[] = [
    { key: 'q', label: 'Search' },
    { key: 'repo', label: 'Repository' },
    { key: 'author', label: 'Author' },
];

/** A tab's organization-wide count. Needs attention is every unclosed task — running plus
 * review, the server's own `attention` predicate — so it adds the two counts the poll carries. */
const tabCount = (state: InboxFilters['state'], counts: TaskNavigation['counts']): number =>
    state === 'attention' ? counts.running + counts.review : state === 'running' ? counts.running : counts.past;

/**
 * Each tone's pill, per the status table in `docs/design-system.md`: the pill class, then the
 * leading glyph — an icon, or the live lamp embedded for a run that is still moving. Waiting and
 * Done carry a region modifier: the waiting edge, the done check's green.
 */
const STATE_PILL: Record<TaskTone, { className: string; mark: IconName | 'lamp' | null }> = {
    none: { className: 'pill', mark: null },
    answer: { className: 'pill pill-accent', mark: 'circle-dot' },
    queued: { className: 'pill pill-done', mark: 'clock' },
    running: { className: 'pill pill-ok', mark: 'lamp' },
    stopping: { className: 'pill pill-done', mark: 'lamp' },
    waiting: { className: 'pill pill-done inbox-state-waiting', mark: 'clock' },
    review: { className: 'pill pill-accent', mark: 'circle-dot' },
    failed: { className: 'pill pill-bad', mark: 'alert-circle' },
    stopped: { className: 'pill pill-done', mark: 'minus-circle' },
    done: { className: 'pill pill-done inbox-state-done', mark: 'check-circle' },
};

/** The rows whose turn it is: a question or a result waiting on a person wears the accent edge, a
 * failure the stop lamp's. Every other row has no edge. */
const ROW_EDGE: Partial<Record<TaskTone, string>> = {
    answer: ' inbox-row-turn',
    review: ' inbox-row-turn',
    failed: ' inbox-row-failed',
};

/** The URL for a filter set: `inboxQueryString` decides what a filter set serializes to — one
 * home, so a new filter key cannot be added to the poll and forgotten in the shareable link. */
const filtersUrl = (filters: InboxFilters): string => {
    const query = inboxQueryString(filters);
    return query === '' ? '/tasks' : `/tasks?${query}`;
};

/** The tracked repositories, plus the currently filtered one if it has since
 * disappeared from the configuration — a linkable URL must keep rendering its own filter. */
function repoOptionsFor(
    workspaceRepos: readonly { owner: string; name: string }[],
    filterRepo: string | null
): string[] {
    const options = workspaceRepos.map((repo) => `${repo.owner}/${repo.name}`);
    if (filterRepo !== null && !options.includes(filterRepo)) options.push(filterRepo);
    return options;
}

/** The authors the loaded rows name, plus the filtered one if no loaded row carries it. */
function authorOptionsFor(items: readonly TaskSummary[] | null, filterAuthor: string | null): string[] {
    const logins = new Set<string>();
    for (const task of items ?? []) if (task.author !== null) logins.add(task.author.login);
    if (filterAuthor !== null) logins.add(filterAuthor);
    return [...logins].sort((a, b) => a.localeCompare(b));
}

/** The last segment of `owner/name`: the trigger is narrow, the option list and title carry the full name. */
const shortRepo = (repo: string): string => repo.slice(repo.indexOf('/') + 1);

/** The state tabs, each with its organization count once the poll has landed. The count never
 * reads the filters: the number is the organization's, whatever the list below is narrowed to. */
function InboxTabs({ filters, counts }: { filters: InboxFilters; counts: TaskNavigation['counts'] | null }) {
    return (
        <nav className="tabs inbox-tabs" aria-label="Task state">
            {STATES.map((state) => {
                const active = filters.state === state.value;
                const count = counts === null ? null : tabCount(state.value, counts);
                return (
                    <Link
                        key={state.value}
                        to={filtersUrl({ ...filters, state: state.value })}
                        className={active ? 'inbox-tab is-active' : 'inbox-tab'}
                        aria-current={active ? 'page' : undefined}
                        aria-label={count === null ? undefined : `${state.label}, ${count} across the organization`}
                    >
                        {state.label}
                        {count === null ? null : <span className="inbox-tab-count">{count}</span>}
                    </Link>
                );
            })}
        </nav>
    );
}

/**
 * A field's draft, reset whenever the URL's value changes under it — a removed chip, Clear
 * filters or Back must not leave the old text sitting in the box. Controlled rather than
 * remounted, so the control a keyboard user just pressed keeps its focus.
 */
function useFilterDraft(value: string | null): [string, (next: string) => void] {
    const [draft, setDraft] = useState(value ?? '');
    useEffect(() => setDraft(value ?? ''), [value]);
    return [draft, setDraft];
}

/** `/` focuses the search from anywhere on the page that is not already taking text. */
function useSlashFocus(target: RefObject<HTMLInputElement | null>) {
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
            const active = document.activeElement;
            if (
                active instanceof HTMLElement &&
                (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
            )
                return;
            event.preventDefault();
            target.current?.focus();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [target]);
}

/** One composer-style listbox: a quiet trigger with its icon and current value, options in the shared popover. */
function QuietListbox({
    label,
    icon,
    value,
    display,
    title = display,
    applied,
    options,
    onChange,
}: {
    label: string;
    icon: IconName;
    value: string;
    display: string;
    /** The full value, when `display` is a shortened one. */
    title?: string;
    applied: boolean;
    options: readonly { value: string; label: string }[];
    onChange: (next: string) => void;
}) {
    // Headless UI's own `anchor` flips the panel above the trigger near the viewport's bottom
    // with no way to disable it, so it is bypassed in favor of `useDownwardAnchor` (as the composer does).
    const anchor = useDownwardAnchor('start');
    return (
        <Listbox value={value} onChange={onChange}>
            <ListboxButton
                ref={anchor.setReference}
                className={applied ? 'select-trigger inbox-trigger is-applied' : 'select-trigger inbox-trigger'}
                aria-label={`${label}: ${display}`}
                title={title}
            >
                <Icon name={icon} />
                <span className="inbox-trigger-value">{display}</span>
            </ListboxButton>
            <ListboxOptions ref={anchor.setFloating} style={anchor.floatingStyles} portal className="popover">
                {options.map((option) => (
                    <ListboxOption key={option.value} value={option.value} className="popover-option">
                        {option.label}
                    </ListboxOption>
                ))}
            </ListboxOptions>
        </Listbox>
    );
}

/** The author trigger: the loaded rows' authors to pick from, and a login field for anyone else —
 * the filter matches any login, so a picker of only the loaded page would lose reach. */
function AuthorPicker({
    author,
    options,
    onChange,
}: {
    author: string | null;
    options: readonly string[];
    onChange: (next: string | null) => void;
}) {
    const anchor = useDownwardAnchor('start');
    const [draft, setDraft] = useFilterDraft(author);
    const display = author ?? 'Anyone';
    return (
        <Popover>
            <PopoverButton
                ref={anchor.setReference}
                className={author !== null ? 'select-trigger inbox-trigger is-applied' : 'select-trigger inbox-trigger'}
                aria-label={`Author: ${display}`}
                title={display}
            >
                <Icon name="user" />
                <span className="inbox-trigger-value">{display}</span>
            </PopoverButton>
            <PopoverPanel
                ref={anchor.setFloating}
                style={anchor.floatingStyles}
                portal
                className="popover inbox-author-panel"
            >
                {({ close }) => {
                    const pick = (next: string | null) => {
                        onChange(next);
                        close();
                    };
                    return (
                        <>
                            <input
                                className="inbox-author-field"
                                aria-label="Author login"
                                placeholder="Type a login, Enter to apply"
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key !== 'Enter') return;
                                    event.preventDefault();
                                    const login = draft.trim();
                                    pick(login === '' ? null : login);
                                }}
                            />
                            <button
                                type="button"
                                className="popover-option"
                                data-selected={author === null ? '' : undefined}
                                onClick={() => pick(null)}
                            >
                                Anyone
                            </button>
                            {options.map((login) => (
                                <button
                                    key={login}
                                    type="button"
                                    className="popover-option"
                                    data-selected={author === login ? '' : undefined}
                                    onClick={() => pick(login)}
                                >
                                    {login}
                                </button>
                            ))}
                        </>
                    );
                }}
            </PopoverPanel>
        </Popover>
    );
}

/**
 * The quiet toolbar: search (applied on Enter) and the repository, author and sort triggers
 * (applied on pick). Split out of `TaskInboxPage` so its own render tree does not add to the
 * page's cognitive complexity.
 */
function InboxToolbar({
    filters,
    repoOptions,
    authorOptions,
    repoRead,
    onApply,
}: {
    filters: InboxFilters;
    repoOptions: readonly string[];
    authorOptions: readonly string[];
    repoRead: { loading: boolean; error: string | null; onRetry: () => void };
    onApply: (next: InboxFilters) => void;
}) {
    const [q, setQ] = useFilterDraft(filters.q);
    const searchRef = useRef<HTMLInputElement>(null);
    useSlashFocus(searchRef);
    const submit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const next = q.trim().slice(0, QUERY_MAX);
        onApply({ ...filters, q: next === '' ? null : next });
    };
    const sort = SORTS.find((option) => option.value === filters.sort) ?? SORTS[0]!;
    return (
        <div className="inbox-toolbar">
            <form className="inbox-search" onSubmit={submit}>
                <Icon name="search" />
                <input
                    ref={searchRef}
                    name="q"
                    aria-label="Search"
                    value={q}
                    onChange={(event) => setQ(event.target.value)}
                    placeholder="Search task requests"
                    type="text"
                    autoComplete="off"
                />
                <span aria-hidden="true">
                    <kbd>/</kbd>
                </span>
            </form>
            <span className="inbox-toolbar-divider" aria-hidden="true" />
            <QuietListbox
                label="Repository"
                icon="repo"
                value={filters.repo ?? ''}
                display={filters.repo === null ? 'All repositories' : shortRepo(filters.repo)}
                title={filters.repo ?? 'All repositories'}
                applied={filters.repo !== null}
                options={[
                    { value: '', label: 'All repositories' },
                    ...repoOptions.map((repo) => ({ value: repo, label: repo })),
                ]}
                onChange={(repo) => onApply({ ...filters, repo: repo === '' ? null : repo })}
            />
            <AuthorPicker
                author={filters.author}
                options={authorOptions}
                onChange={(author) => onApply({ ...filters, author })}
            />
            <QuietListbox
                label="Sort"
                icon="sliders"
                value={filters.sort}
                display={sort.short}
                applied={false}
                options={SORTS}
                onChange={(next) => onApply({ ...filters, sort: next as InboxFilters['sort'] })}
            />
            {repoRead.error !== null && (
                <span className="status error" role="alert">
                    Repositories unavailable: {repoRead.error}{' '}
                    <button type="button" onClick={repoRead.onRetry}>
                        Retry
                    </button>
                </span>
            )}
            {repoRead.error === null && repoRead.loading && <span className="muted">Loading repositories…</span>}
        </div>
    );
}

/** One chip per applied search/repository/author filter — plus the tab-less Needs review state;
 * each × is a link to the same URL with that one param gone, and Clear filters is the bare inbox.
 * Nothing renders at the defaults. */
function InboxChips({ filters }: { filters: InboxFilters }) {
    const applied = CHIPS.filter((chip) => filters[chip.key] !== null);
    const review = filters.state === 'review';
    if (applied.length === 0 && !review) return null;
    return (
        <div className="inbox-chips">
            {review ? (
                <span className="inbox-chip">
                    State: Needs review
                    <Link
                        to={filtersUrl({ ...filters, state: 'attention' })}
                        className="inbox-chip-remove"
                        aria-label="Remove filter: State"
                    >
                        <Icon name="x" size={14} />
                    </Link>
                </span>
            ) : null}
            {applied.map((chip) => (
                <span key={chip.key} className="inbox-chip">
                    {chip.label}: {filters[chip.key]}
                    <Link
                        to={filtersUrl({ ...filters, [chip.key]: null })}
                        className="inbox-chip-remove"
                        aria-label={`Remove filter: ${chip.label}`}
                    >
                        <Icon name="x" size={14} />
                    </Link>
                </span>
            ))}
            <Link to="/tasks" className="inbox-clear">
                Clear filters
            </Link>
        </div>
    );
}

function StatePill({ status }: { status: TaskStatus }) {
    const pill = STATE_PILL[taskTone(status)];
    return (
        <span className={pill.className}>
            {pill.mark === 'lamp' ? (
                <span className={`sidenav-dot ${taskDotClass(status)}`} aria-hidden="true" />
            ) : pill.mark !== null ? (
                <Icon name={pill.mark} size={14} />
            ) : null}
            {taskStatusLabel(status)}
        </span>
    );
}

function Author({ author }: { author: TaskSummary['author'] }) {
    if (author === null) {
        return (
            <span className="inbox-author">
                <span className="avatar avatar-fallback" aria-hidden="true">
                    ?
                </span>
                <span className="inbox-cell-text">Unknown author</span>
            </span>
        );
    }
    return (
        <span className="inbox-author">
            <Avatar author={author} size={28} />
            <span className="inbox-cell-text" title={author.login}>
                {author.login}
            </span>
        </span>
    );
}

/** The line under the title: what a running task is doing, or what a finished one said. A
 * queued or parked task has neither, and a stale line would lie about a run no longer going. */
function rowSummary(task: TaskSummary): string | null {
    const line = task.status === 'running' ? task.activity : task.status === 'queued' ? null : task.summary;
    return line !== null && line.trim() !== '' ? line : null;
}

/** The row's leading mark: a question's speech bubble, else the status dot, else nothing. */
function RowMark({ tone, dot }: { tone: TaskTone; dot: string }) {
    if (tone === 'answer') return <Icon name="message-square" />;
    return dot !== '' ? <span className={`sidenav-dot ${dot}`} /> : null;
}

function Row({ task }: { task: TaskSummary }) {
    const status: TaskStatus = {
        status: task.status,
        cancelRequestedAt: task.cancelRequestedAt,
        doneAt: task.doneAt,
        waitReason: task.waitReason,
        waitTerminalReason: task.waitTerminalReason,
        needsAnswer: task.needsAnswer,
    };
    const tone = taskTone(status);
    const summary = rowSummary(task);
    const name = taskTitleText(task);
    const live = task.status === 'running' && summary !== null;
    return (
        <li className={`inbox-row${ROW_EDGE[tone] ?? ''}`}>
            <span className="inbox-mark" aria-hidden="true">
                <RowMark tone={tone} dot={taskDotClass(status)} />
            </span>
            <span className="inbox-title">
                <Link to={`/tasks/${task.id}`} title={name}>
                    {name}
                </Link>
                {summary !== null ? (
                    <span className={live ? 'inbox-summary is-live' : 'inbox-summary'} title={summary}>
                        {summary}
                    </span>
                ) : null}
            </span>
            <span className="inbox-state">
                <StatePill status={status} />
            </span>
            <span className="inbox-repo">
                <span className="inbox-repo-name">
                    <Icon name="repo" size={14} />
                    <span className="inbox-cell-text">{task.repo ?? '—'}</span>
                </span>
                {task.executor !== null ? <span className="inbox-executor">{task.executor}</span> : null}
            </span>
            <Author author={task.author} />
            {/* The shared stamp component: relative label, precise UTC stamp as its title. */}
            <span className="inbox-when">
                <RelativeTime at={task.activityAt} />
            </span>
        </li>
    );
}

/**
 * Exactly one of: loading, one of two empty states, or the loaded rows with their own
 * load-more error and action. Split out of `InboxTaskList` so its own 4-way state chain does not
 * add to that component's cognitive complexity — each branch is an early return rather than a
 * nested ternary.
 */
function InboxTaskListBody({
    tasks,
    noTasksAtAll,
    appendNote,
}: {
    tasks: UseTasks;
    noTasksAtAll: boolean;
    appendNote: string | null;
}) {
    if (tasks.initial) return <StateNote state="loading">Loading tasks…</StateNote>;
    if (noTasksAtAll) {
        return (
            <div className="inbox-empty">
                <StateNote state="empty">No tasks yet</StateNote>
                <Link to="/tasks/new">Start your first task</Link>
            </div>
        );
    }
    if (tasks.items === null) return null;
    if (tasks.items.length === 0) {
        return (
            <div className="inbox-empty">
                <StateNote state="empty">No tasks match these filters</StateNote>
                <Link to="/tasks">Clear filters</Link>
            </div>
        );
    }
    const loaded = tasks.items.length;
    const groups = groupByDay(tasks.items, (task) => task.activityAt, new Date());
    return (
        <>
            <div className="inbox-list">
                {groups.map((group) => (
                    // A day can recur in the list, so its first row's id keeps the key unique.
                    <section key={`${group.day}-${group.items[0]?.id}`} className="inbox-group" aria-label={group.day}>
                        <h2 className="inbox-group-head">
                            {group.day}
                            <span className="inbox-group-count">{group.items.length}</span>
                        </h2>
                        <ul className="inbox-rows">
                            {group.items.map((task) => (
                                <Row key={task.id} task={task} />
                            ))}
                        </ul>
                    </section>
                ))}
            </div>
            {tasks.loadMoreError !== null ? (
                <div className="inbox-error">
                    <StateNote state="error">Couldn't load more tasks — {tasks.loadMoreError}</StateNote>
                    <button type="button" onClick={tasks.loadMore}>
                        Retry
                    </button>
                </div>
            ) : null}
            <div className="inbox-footer">
                <p className="muted">
                    Showing {loaded} loaded {loaded === 1 ? 'task' : 'tasks'}
                </p>
                {tasks.nextCursor !== null ? (
                    <button type="button" onClick={tasks.loadMore} disabled={tasks.loadingMore}>
                        {tasks.loadingMore ? 'Loading…' : 'Load more'}
                    </button>
                ) : null}
            </div>
            <p className="inbox-note" role="status">
                {appendNote ?? ''}
            </p>
        </>
    );
}

/**
 * The inbox's content area: the load/refresh errors, then the body's one active state. Split out
 * of `TaskInboxPage` so its own render tree does not add to the page's cognitive complexity.
 */
function InboxTaskList({
    tasks,
    noTasksAtAll,
    appendNote,
}: {
    tasks: UseTasks;
    noTasksAtAll: boolean;
    appendNote: string | null;
}) {
    return (
        <>
            {tasks.error !== null ? (
                <div className="inbox-error">
                    <StateNote state="error">Couldn't load tasks — {tasks.error}</StateNote>
                    <button type="button" onClick={tasks.retry}>
                        Retry
                    </button>
                </div>
            ) : null}
            {/* Stale only when rows exist: a first-page failure carries the same message as
                `error` above, and there is no last successful update to show. */}
            {tasks.refreshError !== null && tasks.error === null ? (
                <div className="banner-warn" role="status">
                    <Icon name="alert-triangle" size={24} />
                    <p className="banner-title">Couldn't refresh tasks; showing the last successful update.</p>
                </div>
            ) : null}
            <InboxTaskListBody tasks={tasks} noTasksAtAll={noTasksAtAll} appendNote={appendNote} />
        </>
    );
}

export function TaskInboxPage() {
    const { tasks, repos } = useTasksPage();
    const [, setSearchParams] = useSearchParams();
    const filters = tasks.filters;

    // The polite note after an append: how many rows the last Load more brought in. Owned here
    // because it is presentation state, not poll state — the hook holds rows, not narration.
    const [appendNote, setAppendNote] = useState<string | null>(null);
    const lengthRef = useRef<number | null>(null);
    useEffect(() => {
        // Nothing loaded yet is no baseline: the first page landing is not "N more tasks loaded".
        // A reload (any filter link) drops the old narration with the old rows.
        if (tasks.items === null) {
            lengthRef.current = null;
            setAppendNote(null);
            return;
        }
        const length = tasks.items.length;
        const previous = lengthRef.current;
        lengthRef.current = length;
        if (previous !== null && length > previous) setAppendNote(`${length - previous} more tasks loaded`);
        if (previous !== null && length < previous) setAppendNote(null);
    }, [tasks.items]);

    const applyFilters = (next: InboxFilters) => {
        setAppendNote(null);
        setSearchParams(
            // The defaults come off the URL entirely, so Back/Forward sees clean states.
            new URLSearchParams(
                filtersUrl(next)
                    .replace(/^\/tasks/, '')
                    .replace(/^\?/, '')
            ),
            { replace: false }
        );
    };

    const tracked = trackedRepos(repos);
    const repoOptions = repoOptionsFor(tracked.repos ?? [], filters.repo);
    const authorOptions = authorOptionsFor(tasks.items, filters.author);
    const counts = tasks.navigation?.counts ?? null;
    const noTasksAtAll =
        tasks.items !== null && counts !== null && counts.running === 0 && counts.review === 0 && counts.past === 0;

    return (
        <section className="inbox">
            {/* The page's one heading lives in the shared PageHeader (issue 159): no eyebrow and no
                description, New task as the page's one action. The org-wide counts ride the tabs. */}
            <PageHeader
                title="Tasks"
                actions={
                    <Link to="/tasks/new" className="inbox-new">
                        <Icon name="plus" size={20} />
                        New task
                    </Link>
                }
            />

            <InboxTabs filters={filters} counts={counts} />

            <InboxToolbar
                filters={filters}
                repoOptions={repoOptions}
                authorOptions={authorOptions}
                repoRead={{ loading: repos.loading, error: tracked.error, onRetry: repos.refresh }}
                onApply={applyFilters}
            />

            <InboxChips filters={filters} />

            <InboxTaskList tasks={tasks} noTasksAtAll={noTasksAtAll} appendNote={appendNote} />
        </section>
    );
}
