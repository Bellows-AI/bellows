import { request } from './request.js';
import type { TaskListResponse, TaskNavigation, TaskSummary } from './useTasks.js';

/** The task list's keyset paging: one page, the depth rebuild a refresh runs, and Load more. */

/** Raised when a page answers 401: `request` has already told the gate, so the caller only stops quietly. */
export class TaskAuthExpired extends Error {}

const firstPageUrl = (query: string): string => (query === '' ? '/api/tasks' : `/api/tasks?${query}`);
const morePageUrl = (query: string, cursor: string): string =>
    `/api/tasks?${query === '' ? '' : `${query}&`}cursor=${encodeURIComponent(cursor)}`;

/**
 * One page read, for the org poll's chain and `loadMore`: refusals raise (the catch in `poll` keeps
 * the last good rows whole — never a half-rebuilt page), and a 401 raises {@link TaskAuthExpired} so
 * the poll stops quietly at the gate rather than bannering an error that would recur every tick.
 */
async function readTaskPage(url: string, signal: AbortSignal, verb?: string): Promise<TaskListResponse> {
    const result = await request<TaskListResponse>(url, { signal, ...(verb ? { verb } : {}) });
    if (result.ok) return result.value;
    if (result.unauthenticated) throw new TaskAuthExpired();
    throw new Error(result.error);
}

export const fetchTaskPage = (url: string, signal: AbortSignal) => readTaskPage(url, signal);

/** One older page, for `loadMore` — the failure text is Load-more's own. */
const fetchMorePage = (query: string, cursor: string, signal: AbortSignal) =>
    readTaskPage(morePageUrl(query, cursor), signal, 'Could not load more tasks');

/**
 * Appends an older page's rows to the loaded ones, deduped by id. The keyset contract says no
 * duplicates; a task whose activity stamp moved between page reads could straddle two of them
 * anyway, and one row twice would be a visible lie. Latest activity wins the spot.
 */
function mergeTaskPage(prev: TaskSummary[] | null, items: TaskSummary[]): TaskSummary[] {
    if (prev === null) return items;
    const known = new Set(prev.map((task) => task.id));
    return [...prev, ...items.filter((task) => !known.has(task.id))];
}

/** The setters `loadMore` hands one older page's landing to — bundled so `loadMoreTasksPage` stays
 * under the param-count limit. */
interface LoadMoreSetters {
    setNavigation: (navigation: TaskNavigation) => void;
    setItems: (updater: (prev: TaskSummary[] | null) => TaskSummary[]) => void;
    setNextCursor: (cursor: string | null) => void;
    setLoadMoreError: (error: string | null) => void;
    onDepthIncrement: () => void;
}

/**
 * One Load-more page, start to landing: the last good rows and cursor stay as they are on any
 * failure, and a 401 is handed to the gate rather than reported as this call's own error.
 */
export async function loadMoreTasksPage(
    query: string,
    cursor: string,
    signal: AbortSignal,
    setters: LoadMoreSetters
): Promise<void> {
    try {
        const body = await fetchMorePage(query, cursor, signal);
        if (signal.aborted) return;
        setters.setNavigation(body.navigation);
        setters.setItems((prev) => mergeTaskPage(prev, body.page.items));
        setters.setNextCursor(body.page.nextCursor);
        setters.onDepthIncrement();
    } catch (e) {
        if (signal.aborted) return;
        if (e instanceof TaskAuthExpired) return;
        setters.setLoadMoreError((e as Error).message);
    }
}

/**
 * The most pages one refresh will rebuild. The chain is inherently serial — page n+1's cursor is
 * only known once page n answered — so an uncapped depth turns a member who clicked Load more ten
 * times into eleven sequential `GET /api/tasks` round trips every three seconds. Past the cap the
 * deeper pages simply go stale — they are NOT re-read, and {@link refreshLanding} keeps them on
 * screen rather than dropping them.
 */
export const MAX_REFRESH_DEPTH = 3;

/**
 * Lands one rebuild onto the rows already on screen. When the rebuild reached the loaded depth —
 * or the list shrank and the chain ran out of cursors — the rebuild IS the list, and the loaded
 * depth follows it. When the cap stopped the chain short of the loaded depth while the list still
 * had more, the pages past the cap were never re-read: replacing the list with the capped rebuild
 * would make rows the member is reading disappear every tick and collapse the loaded depth to the
 * cap, so those rows are kept (deduped by id, the rebuild's position winning) and the caller
 * leaves the cursor and the depth where Load more put them.
 */
export function refreshLanding(
    prev: TaskSummary[] | null,
    loadedDepth: number,
    rebuilt: { items: TaskSummary[]; nextCursor: string | null; pages: number }
): { items: TaskSummary[]; capped: boolean } {
    const capped = rebuilt.nextCursor !== null && loadedDepth > rebuilt.pages;
    if (!capped) return { items: rebuilt.items, capped: false };
    return { items: mergeTaskPage(rebuilt.items, prev ?? []), capped: true };
}

/**
 * Reads enough successive keyset pages to REBUILD a previously loaded depth, deduped by task id
 * (first occurrence wins — the newest position). Exported with the fetch injected so the offline
 * suite can drive the whole chain: a plain first-page swap on refresh would collapse the pages
 * the member already paged through, every three seconds while anything runs.
 *
 * The rebuild reads at most {@link MAX_REFRESH_DEPTH} pages however deep the member paged.
 *
 * Returns page one's navigation (org-wide, so any page could serve it — the first is simply the
 * freshest), the merged rows, the cursor of the LAST page read (null when the list shrank below
 * the old depth — the loaded depth collapses to what the list still serves), and how many pages
 * the chain actually read.
 */
export async function fetchDepthPages(
    fetchPage: (url: string) => Promise<TaskListResponse>,
    query: string,
    depth: number
): Promise<{
    navigation: TaskNavigation;
    items: TaskSummary[];
    nextCursor: string | null;
    pages: number;
}> {
    const first = await fetchPage(firstPageUrl(query));
    const items: TaskSummary[] = [];
    const known = new Set<string>();
    for (const task of first.page.items) {
        if (!known.has(task.id)) {
            known.add(task.id);
            items.push(task);
        }
    }
    let cursor = first.page.nextCursor;
    let pages = 1;
    while (cursor !== null && pages < Math.min(depth, MAX_REFRESH_DEPTH)) {
        const next = await fetchPage(morePageUrl(query, cursor));
        for (const task of next.page.items) {
            if (!known.has(task.id)) {
                known.add(task.id);
                items.push(task);
            }
        }
        cursor = next.page.nextCursor;
        pages += 1;
    }
    return { navigation: first.navigation, items, nextCursor: cursor, pages };
}

/**
 * Lands one rebuild on the poll's state. A rebuild that reached the loaded depth replaces the
 * list and owns the cursor and the depth; a CAPPED one keeps the pages past the cap on screen
 * (see {@link refreshLanding}) and leaves the cursor and the depth where Load more put them, so
 * neither the rows nor the loaded depth collapse to the cap every tick.
 */
export function landRebuild(
    rebuilt: { navigation: TaskNavigation; items: TaskSummary[]; nextCursor: string | null; pages: number },
    depthRef: { current: number },
    setters: {
        setNavigation: (navigation: TaskNavigation) => void;
        setItems: (updater: (prev: TaskSummary[] | null) => TaskSummary[]) => void;
        setNextCursor: (cursor: string | null) => void;
    }
): void {
    const loadedDepth = depthRef.current;
    setters.setNavigation(rebuilt.navigation);
    setters.setItems((prev) => refreshLanding(prev, loadedDepth, rebuilt).items);
    if (refreshLanding(null, loadedDepth, rebuilt).capped) return;
    setters.setNextCursor(rebuilt.nextCursor);
    depthRef.current = rebuilt.pages;
}
