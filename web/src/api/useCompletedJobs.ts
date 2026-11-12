import type { Job } from './useJobs.js';
import { usePoll } from './usePoll.js';

const LIST_LIMIT = 8;
const VISIBLE_POLL_DELAY_MS = 30_000;
const HIDDEN_POLL_DELAY_MS = 60_000;

/**
 * The board's finished TASKS, for the dashboard's recently-completed view — one row per task, not
 * per run (issue 124): the server groups the terminal rows by thread, so a conversation with
 * follow-ups is one row whose wall clock is the thread's total and whose summary is the newest
 * run's.
 *
 * A second, slower poll of the list the tasks pages use — slower because the dashboard is a
 * report, not a chat: a quiet board's answer barely changes in thirty seconds. The
 * `status=terminal` filter is the SERVER's (the same set the thread-done computation uses),
 * so the limit bounds exactly the rows this hook returns — a busy queue cannot hide finished
 * tasks behind queued ones the way a client-side filter over a newest-N window would. The same
 * discipline as `useJobs`: one abortable chain, the last good answer survives a failed tick,
 * 401s go to the gate, and leaving the dashboard tears the chain down. The limit is EIGHT
 * because eight rows is what the dashboard's bounded board section renders (issue 168).
 */
export function useCompletedJobs(): { jobs: Job[] | null; error: string | null } {
    const polled = usePoll<{ jobs: Job[] }>(`/api/jobs?status=terminal&limit=${LIST_LIMIT}`, {
        // Every outcome re-arms: a failed tick keeps the last good rows and tries again; hidden tabs poll slower.
        refetchOnVisible: true,
        next: (_outcome, hidden) => (hidden ? HIDDEN_POLL_DELAY_MS : VISIBLE_POLL_DELAY_MS),
    });
    return { jobs: polled.data?.jobs ?? null, error: polled.error };
}
