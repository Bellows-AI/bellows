import { useEffect, useState } from 'react';
import type { TaskUsage, Tokens, UsageBlock } from '@factory-ai/core';
import type { Job } from './useJobs.js';

/** The four token types the board reports apart; `null` is a type never measured, never zero. */
export type TokenTypes = Tokens;

/**
 * One bucket of a run's span, as `GET /api/jobs/:id/activity` answers it: the tokens the run
 * processed, by type, and the edit decisions it made inside the bucket (null: none measured).
 * Copied from the route's payload, the same rule every client-side row shape follows.
 */
export interface JobActivityBucket {
    start: string;
    tokens: TokenTypes;
    edits: number | null;
}

/** The activity route's whole answer, for one run and the canonical task (reviews included) it belongs to. */
export interface JobActivity {
    jobId: string;
    sessionId: string | null;
    from: string | null;
    to: string | null;
    bucketMs: number | null;
    buckets: JobActivityBucket[];
    /** This run; `state` is `unmeasured` when it reported nothing - never a zero total. */
    usage: UsageBlock;
    /** The same payload from any run id of the task; null when no evidence names it. */
    task: TaskUsage | null;
}

/** A run's activity answer, or the board's refusal to give one. An absent run is still loading. */
export type RunActivity = JobActivity | 'unavailable';

/** Every run of the thread's activity answer, by job id. */
export type ThreadActivity = Readonly<Record<string, RunActivity>>;

/** A run with no session — or one that never started — has nothing the route could chart. */
const hasTelemetryKey = (job: Job): boolean => job.sessionId !== null && job.startedAt !== null;

/**
 * Everything that makes a run's activity answer worth refetching: its session first reported,
 * its start, and its finish (`finishedAt` lands: the final fetch). Never a timer — a chart that
 * redraws itself every two seconds is noise, not information.
 */
const refetchKeyOf = (job: Job): string => [job.id, job.sessionId, job.startedAt, job.finishedAt].join('|');

/**
 * The thread's per-run activity answers (issue 339, 530), fetched for EVERY run by its own id —
 * the pulse reads the newest run, the statistics modal reads them all, and any member's id
 * resolves to the same conversation so each run is asked for itself, never the URL-named one.
 * A run with no session reads `unavailable` without a request. An HTTP refusal answers
 * `unavailable` — an unreadable answer is not "keep a stale chart"; a network failure keeps the
 * run's last answer. Answers are keyed by job id, so one run's chart can never render as
 * another's, and a changed run keeps its previous answer on screen until the new one lands.
 */
export function useThreadActivity(jobs: readonly Job[] | null): ThreadActivity {
    const [answers, setAnswers] = useState<ThreadActivity>({});
    const runs = (jobs ?? []).filter(hasTelemetryKey);
    const key = runs.map(refetchKeyOf).join(',');

    useEffect(() => {
        const controller = new AbortController();
        const ids = key === '' ? [] : key.split(',').map((entry) => entry.split('|')[0]!);
        for (const id of ids) {
            void (async () => {
                try {
                    const response = await fetch(`/api/jobs/${id}/activity`, { signal: controller.signal });
                    const answer: RunActivity = response.ok ? ((await response.json()) as JobActivity) : 'unavailable';
                    setAnswers((previous) => ({ ...previous, [id]: answer }));
                } catch {
                    // Aborted mid-flight (the thread changed): the new fetch owns the state.
                    // A network failure that is not an abort keeps the run's last answer.
                }
            })();
        }
        return () => controller.abort();
    }, [key]);

    // A run without telemetry is answered here, so the modal never reads it as "still loading".
    const unmeasured = (jobs ?? []).filter((job) => !hasTelemetryKey(job));
    return { ...answers, ...Object.fromEntries(unmeasured.map((job) => [job.id, 'unavailable' as const])) };
}
