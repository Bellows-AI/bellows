import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { TaskTitleOrigin } from '@factory-ai/core';
import { type AnswerOutcome, postAnswer } from './answer-question.js';
import { refetchOnVisible } from './usePoll.js';
import { fetchDepthPages, landRebuild, loadMoreTasksPage, TaskAuthExpired, fetchTaskPage } from './taskPages.js';
import {
    followUpOnTask,
    postTaskAction,
    queueTask,
    renameTask,
    type QueueTaskInput,
    type RenameOutcome,
    type SubmittedFiles,
} from './taskWrites.js';
import type { AuthorRef, JobStatus, QueueResult } from './useJobs.js';

/**
 * The client's copy of the task-summary read model (`GET /api/tasks`): one row per thread ROOT,
 * the present tense read off the chain's newest run. Copied rather than imported — the web owns
 * the shapes it renders — and camelCase as served. `status`/`author` reuse the job row's types:
 * the head run's status and the root's author are the same people and the same words.
 */
export type TaskState = 'attention' | 'running' | 'review' | 'past';
export type TaskSort = 'newest' | 'oldest';

export interface TaskSummary {
    /** The root job id — the route target. */
    id: string;
    /** The root command; the fallback title derives from it. */
    command: string;
    /** The root's stored title, or null while the fallback stands (BEL-252). */
    title: string | null;
    titleOrigin: TaskTitleOrigin | null;
    titleRevision: number;
    /** The newest run's status — the chain head's, not the root's. */
    status: JobStatus;
    cancelRequestedAt: string | null;
    doneAt: string | null;
    repo: string | null;
    executor: string | null;
    author: AuthorRef | null;
    /** The head's live activity line, while the head run is the one moving. */
    activity: string | null;
    /** The head's terminal summary — the agent's own last words on the newest run. */
    summary: string | null;
    waitReason: string | null;
    waitingSince: string | null;
    waitTerminalReason: string | null;
    createdAt: string;
    /** The head's newest of created/started/finished/done — what orders and paginates. */
    activityAt: string;
    /** Whether any run of the thread holds a question a member can still answer. */
    needsAnswer: boolean;
}

export interface TaskNavigation {
    counts: { running: number; review: number; past: number };
    /** Up to 3 running tasks, newest first — the sidenav's preview. */
    running: TaskSummary[];
    /** Up to 5 review tasks, newest first. */
    review: TaskSummary[];
}

export interface TaskListResponse {
    /** Organization-wide and filter-independent; the page below obeys the filters. */
    navigation: TaskNavigation;
    page: { items: TaskSummary[]; nextCursor: string | null };
}

/** The inbox filters, normalized. This is URL state, nothing else — no localStorage, no defaults
 * invented outside `inboxFiltersFromSearch`. */
export interface InboxFilters {
    state: TaskState;
    q: string | null;
    repo: string | null;
    author: string | null;
    sort: TaskSort;
}

export const DEFAULT_FILTERS: InboxFilters = {
    state: 'attention',
    q: null,
    repo: null,
    author: null,
    sort: 'newest',
};

const TASK_STATES: readonly TaskState[] = ['attention', 'running', 'review', 'past'];
/** A login shape, the same rule the route enforces — copied, never imported from the server. */
const AUTHOR_SHAPE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,98}[a-zA-Z0-9])?$/;
/** Two non-empty path-segment halves: anything else is not an owner/name repo and is not sent. */
const REPO_SHAPE = /^[^/\\]+\/[^/\\]+$/;
/** The search field's character cap — the same one `inboxFiltersFromSearch` clamps to, exported
 * so the inbox's input cannot drift from what the poll would actually send. */
export const QUERY_MAX = 200;

/**
 * The filters one URL search names, with every unknown clamped to the default — the URL is
 * user-editable input, and a hand-typed `?state=weird` must look like the default view, not
 * reach the API as a 400. Never throws.
 */
export function inboxFiltersFromSearch(search: string): InboxFilters {
    const params = new URLSearchParams(search);
    const state = params.get('state');
    const sort = params.get('sort');
    const rawQ = params.get('q');
    const q = rawQ === null ? null : rawQ.trim().slice(0, QUERY_MAX) || null;
    const repo = params.get('repo');
    const author = params.get('author');
    const trimmedAuthor = author === null ? null : author.trim();
    return {
        state: state !== null && TASK_STATES.includes(state as TaskState) ? (state as TaskState) : 'attention',
        q,
        repo: repo !== null && REPO_SHAPE.test(repo) ? repo : null,
        author: trimmedAuthor !== null && AUTHOR_SHAPE.test(trimmedAuthor) ? trimmedAuthor : null,
        sort: sort === 'oldest' || sort === 'newest' ? sort : 'newest',
    };
}

/**
 * The query string a filter set polls with — the defaults omitted, so the default inbox asks for
 * exactly `GET /api/tasks` and a link that shares a view carries only what makes it that view.
 */
export function inboxQueryString(filters: InboxFilters): string {
    const params = new URLSearchParams();
    if (filters.state !== 'attention') params.set('state', filters.state);
    if (filters.q !== null) params.set('q', filters.q);
    if (filters.repo !== null) params.set('repo', filters.repo);
    if (filters.author !== null) params.set('author', filters.author);
    if (filters.sort !== 'newest') params.set('sort', filters.sort);
    return params.toString();
}

/** What `useTasks` returns — published through the shell's outlet context, like the stats poll. */
export interface UseTasks {
    /** Organization-wide; kept through a filter change until the new response lands. */
    navigation: TaskNavigation | null;
    /** The loaded pages: the first page plus every Load-more append. Null until one lands. */
    items: TaskSummary[] | null;
    nextCursor: string | null;
    /** The first page is in flight with nothing to show yet — the skeletons state. */
    initial: boolean;
    /** A Load more request is in flight — the button disables itself on this. */
    loadingMore: boolean;
    /** A first-page refetch (poll, retry or post-mutation) is in flight over existing rows. */
    refreshing: boolean;
    /** The first page failed with nothing to show — the inline error state. */
    error: string | null;
    /** A background refresh failed; the last good rows stay beside it. */
    refreshError: string | null;
    /** An older-page fetch failed; the loaded rows stay beside it. */
    loadMoreError: string | null;
    /** The normalized filters in effect — the URL's on the inbox, the defaults elsewhere. */
    filters: InboxFilters;
    retry: () => void;
    loadMore: () => void;
    refresh: () => void;
    /** The task mutations, named as a group so the pages read `tasks.actions.queue(...)`. */
    actions: {
        queue: (input: QueueTaskInput) => Promise<QueueResult>;
        followUp: (id: string, command: string, files?: SubmittedFiles) => Promise<QueueResult>;
        markDone: (id: string) => Promise<string | null>;
        stop: (id: string) => Promise<string | null>;
        remove: (id: string) => Promise<string | null>;
        rename: (id: string, title: string, revision: number) => Promise<RenameOutcome>;
        answerQuestion: (jobId: string, questionId: string, answers: Record<string, string>) => Promise<AnswerOutcome>;
    };
}

/** The first-page failure: the retained refresh error with nothing beside it. Exported pure so
 * the offline suite pins the depth test — a failed refresh WITH rows keeps the rows beside the
 * banner; without them it IS the page's inline error, and the skeleton state never swallows it. */
export function firstPageError(items: TaskSummary[] | null, refreshError: string | null): string | null {
    return items === null ? refreshError : null;
}

const VISIBLE_MOVING_POLL_MS = 3_000;
const VISIBLE_IDLE_POLL_MS = 30_000;
const HIDDEN_MOVING_POLL_MS = 15_000;
const HIDDEN_IDLE_POLL_MS = 60_000;

/**
 * The org poll's cadence: faster while anything in the organization is moving, slower when
 * nothing can, and slower again in a hidden tab — the same floor a failed tick retries at.
 */
function nextOrgPollDelay(moving: boolean): number {
    if (document.hidden) return moving ? HIDDEN_MOVING_POLL_MS : HIDDEN_IDLE_POLL_MS;
    return moving ? VISIBLE_MOVING_POLL_MS : VISIBLE_IDLE_POLL_MS;
}

/**
 * The ONE task-overview poll. Same discipline as the polls it replaces (`useJobs`): one abortable
 * chain, the last good answer stays on screen through a failed tick, 401s are handed to the gate
 * rather than bannered, and a hidden tab slows to a crawl. The cadence rides the ORG's motion —
 * 3s while anything in the organization is moving, 30s when nothing can move, 15s/60s in a hidden
 * tab — because the board is shared: another member's queued task must appear without anybody
 * here acting first.
 *
 * One instance, owned by the shell, gated to the tasks area; the filters come from the URL on the
 * inbox (`/tasks` exactly) and are the defaults on the composer and detail routes. A filter change
 * is a new page: the loaded rows and cursor reset and the in-flight request is aborted, while the
 * navigation summary — org-wide, filter-independent — is kept until the new response lands.
 */
/** The refs and setters {@link runOrgPollLifecycle} needs — bundled so it stays under the
 * param-count limit. */
interface PollLifecycleContext {
    controller: { current: AbortController | null };
    moreController: { current: AbortController | null };
    depthRef: { current: number };
    stopChain: () => void;
    start: () => void;
    setNavigation: (navigation: TaskNavigation | null) => void;
    setItems: (items: TaskSummary[] | null) => void;
    setNextCursor: (cursor: string | null) => void;
    setRefreshError: (error: string | null) => void;
    setLoadMoreError: (error: string | null) => void;
    setRefreshing: (refreshing: boolean) => void;
    setLoadingMore: (loading: boolean) => void;
}

/**
 * Arms or disarms the org poll for one `(enabled, query)` pair — the poll's mount/filter-change
 * effect body, pulled out so `useOrgTaskPoll` stays short. Leaving the tasks area tears the chain
 * down and blanks every state; a filter change is a new PAGE, not a new board — the loaded rows
 * and cursor reset, the in-flight request is aborted, and the org-wide navigation is kept until
 * the fresh response lands, so the counts and preview must not flicker because the view narrowed.
 */
function runOrgPollLifecycle(enabled: boolean, ctx: PollLifecycleContext): (() => void) | undefined {
    ctx.controller.current?.abort();
    ctx.moreController.current?.abort();
    ctx.stopChain();
    if (!enabled) {
        // Leaving the tasks area stops the question: no chain, no timer, no stale answer held in
        // wait for the next visit.
        ctx.setNavigation(null);
        ctx.setItems(null);
        ctx.setNextCursor(null);
        ctx.setRefreshError(null);
        ctx.setLoadMoreError(null);
        ctx.setRefreshing(false);
        ctx.setLoadingMore(false);
        return undefined;
    }
    ctx.setItems(null);
    ctx.setNextCursor(null);
    ctx.setRefreshError(null);
    ctx.setLoadMoreError(null);
    ctx.setLoadingMore(false);
    ctx.depthRef.current = 1;
    ctx.start();
    return () => {
        ctx.controller.current?.abort();
        ctx.moreController.current?.abort();
        ctx.stopChain();
    };
}

/** What the org poll owns — everything `useTasks` publishes except the URL-derived filters. */
interface OrgTaskPoll {
    navigation: TaskNavigation | null;
    items: TaskSummary[] | null;
    nextCursor: string | null;
    loadingMore: boolean;
    refreshing: boolean;
    refreshError: string | null;
    loadMoreError: string | null;
    retry: () => void;
    loadMore: () => void;
    refresh: () => void;
}

/**
 * The ONE task-overview poll, split out of `useTasks` so that hook stays a thin wrapper: one
 * abortable chain, the last good answer stays on screen through a failed tick, 401s are handed to
 * the gate rather than bannered, and a hidden tab slows to a crawl. A filter change (a new
 * `query`) is a new page — the loaded rows and cursor reset and the in-flight request is aborted,
 * while the org-wide navigation is kept until the new response lands.
 */
function useOrgTaskPoll(enabled: boolean, query: string): OrgTaskPoll {
    const [navigation, setNavigation] = useState<TaskNavigation | null>(null);
    const [items, setItems] = useState<TaskSummary[] | null>(null);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [refreshError, setRefreshError] = useState<string | null>(null);
    const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

    const timer = useRef<number | null>(null);
    const controller = useRef<AbortController | null>(null);
    const moreController = useRef<AbortController | null>(null);
    /** How many keyset pages the member has loaded — the depth every refresh must rebuild. */
    const depthRef = useRef(1);
    /** Bound at the latest render, so the callbacks below re-arm the current chain. */
    const enabledRef = useRef(enabled);
    enabledRef.current = enabled;
    /** The query the CURRENT question polls with, kept beside the chain. */
    const queryRef = useRef(query);
    queryRef.current = query;

    const stopChain = () => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = null;
    };

    const poll = useCallback(async (signal: AbortSignal) => {
        if (signal.aborted) return;
        // The query the chain was armed with — read off the ref at tick time, not closure time,
        // so a re-armed chain always asks the CURRENT question.
        setRefreshing(true);
        try {
            const rebuilt = await fetchDepthPages(
                (url) => fetchTaskPage(url, signal),
                queryRef.current,
                depthRef.current
            );
            // The chain can complete after the area was left or the filters moved; landing it
            // would paint one question's answer onto another.
            if (signal.aborted) return;
            landRebuild(rebuilt, depthRef, { setNavigation, setItems, setNextCursor });
            setRefreshError(null);
            setLoadMoreError(null);
            setRefreshing(false);
            const delay = nextOrgPollDelay(rebuilt.navigation.counts.running > 0);
            timer.current = window.setTimeout(() => void poll(signal), delay);
        } catch (e) {
            if (signal.aborted) return;
            if (e instanceof TaskAuthExpired) {
                setRefreshing(false);
                return;
            }
            setRefreshError((e as Error).message);
            setRefreshing(false);
            // A failed tick must not end the chain: a transient 503 during a deploy would
            // otherwise freeze the inbox until somebody acts. The quiet floor is the retry pace.
            const retryDelay = document.hidden ? HIDDEN_IDLE_POLL_MS : VISIBLE_IDLE_POLL_MS;
            timer.current = window.setTimeout(() => void poll(signal), retryDelay);
        }
    }, []);

    const start = useCallback(() => {
        if (!enabledRef.current) return;
        controller.current?.abort();
        // Retire an in-flight Load more with it: its own finally skips on abort, so the flag
        // would stay raised and hold the button disabled under the fresh chain.
        moreController.current?.abort();
        setLoadingMore(false);
        stopChain();
        const own = new AbortController();
        controller.current = own;
        void poll(own.signal);
    }, [poll]);

    useEffect(
        () =>
            runOrgPollLifecycle(enabled, {
                controller,
                moreController,
                depthRef,
                stopChain,
                start,
                setNavigation,
                setItems,
                setNextCursor,
                setRefreshError,
                setLoadMoreError,
                setRefreshing,
                setLoadingMore,
            }),
        [start, enabled, query]
    );

    // A tab coming back to the front asks now instead of waiting out a hidden-pace tick (up to a minute).
    useEffect(() => {
        const onVisibilityChange = () => {
            if (refetchOnVisible(enabledRef.current, document.hidden, timer.current !== null)) start();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    }, [start]);

    const loadMore = useCallback(() => {
        const cursor = nextCursor;
        if (cursor === null || loadingMore || !enabledRef.current) return;
        moreController.current?.abort();
        const own = new AbortController();
        moreController.current = own;
        setLoadingMore(true);
        setLoadMoreError(null);
        void loadMoreTasksPage(queryRef.current, cursor, own.signal, {
            setNavigation,
            setItems,
            setNextCursor,
            setLoadMoreError,
            onDepthIncrement: () => {
                depthRef.current += 1;
            },
        }).finally(() => {
            if (!own.signal.aborted) setLoadingMore(false);
        });
    }, [nextCursor, loadingMore]);

    return {
        navigation,
        items,
        nextCursor,
        loadingMore,
        refreshing,
        refreshError,
        loadMoreError,
        retry: start,
        loadMore,
        // The poll's own re-arm, exposed for the mutations: an action changes the org's state.
        refresh: start,
    };
}

/** The task mutations, moved whole from useJobs: every one re-arms the first page on success, so
 * the member sees the follow-up appear, or the done state land, on the next tick. */
function useTaskActions(start: () => void): UseTasks['actions'] {
    return useMemo(
        () => ({
            async queue(input: QueueTaskInput): Promise<QueueResult> {
                const result = await queueTask(input);
                if (result.error === null) start();
                return result;
            },
            async followUp(id: string, command: string, files?: SubmittedFiles): Promise<QueueResult> {
                const result = await followUpOnTask(id, command, files);
                if (result.error === null) start();
                return result;
            },
            async markDone(id: string): Promise<string | null> {
                const error = await postTaskAction(`/api/jobs/${id}/done`, 'Could not mark the task done');
                if (error === null) start();
                return error;
            },
            async stop(id: string): Promise<string | null> {
                const error = await postTaskAction(`/api/jobs/${id}/stop`, 'Could not stop the task');
                if (error === null) start();
                return error;
            },
            async remove(id: string): Promise<string | null> {
                const error = await postTaskAction(`/api/jobs/${id}/remove`, 'Could not remove the task');
                if (error === null) start();
                return error;
            },
            async rename(id: string, title: string, revision: number): Promise<RenameOutcome> {
                const outcome = await renameTask(id, title, revision);
                if (outcome.state !== 'failed') start();
                return outcome;
            },
            async answerQuestion(
                jobId: string,
                questionId: string,
                answers: Record<string, string>
            ): Promise<AnswerOutcome> {
                const outcome = await postAnswer(jobId, questionId, answers);
                if (outcome.state !== 'failed') start();
                return outcome;
            },
        }),
        [start]
    );
}

export function useTasks(enabled: boolean): UseTasks {
    const location = useLocation();
    const onInbox = location.pathname === '/tasks';
    const filters = useMemo(
        () => (onInbox ? inboxFiltersFromSearch(location.search) : DEFAULT_FILTERS),
        [onInbox, location.search]
    );
    const query = inboxQueryString(filters);

    const poll = useOrgTaskPoll(enabled, query);
    const actions = useTaskActions(poll.refresh);

    // The first-page failure is the retained refresh error with nothing to show beside it — one
    // state, not two: a failed first page and a failed refresh are the same fact at different
    // depths, and the page renders it inline with a Retry while the rows exist.
    const error = firstPageError(poll.items, poll.refreshError);
    return {
        navigation: poll.navigation,
        items: poll.items,
        nextCursor: poll.nextCursor,
        // The skeletons state: a first page in flight with nothing to show yet — including a
        // filter change, whose previous rows are deliberately gone.
        initial: poll.items === null && error === null,
        loadingMore: poll.loadingMore,
        refreshing: poll.refreshing,
        error,
        refreshError: poll.refreshError,
        loadMoreError: poll.loadMoreError,
        filters,
        retry: poll.retry,
        loadMore: poll.loadMore,
        refresh: poll.refresh,
        actions,
    };
}
