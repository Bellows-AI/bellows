import { useEffect, useState } from 'react';
import { deletionDay, readRetention, type Retention } from '../api/retention.js';
import { isTerminal, type Job } from '../api/useJobs.js';
import { commitDate } from '../format.js';

/** The newest finish of a thread every run of which has ended, or null while one is still going. */
export function threadSettledAt(jobs: readonly Job[] | null): string | null {
    if (!jobs || jobs.length === 0 || !jobs.every((job) => isTerminal(job.status))) return null;
    const finishes = jobs.map((job) => job.finishedAt).filter((at): at is string => at !== null);
    return finishes.length === 0 ? null : finishes.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

/**
 * The day a finished task is deleted by its organization's retention window (docs/retention.md), under the task's
 * header. Read only once every run has ended; nothing renders for an unlimited window or a failed read.
 */
export function TaskDeletionNote({ jobs }: { jobs: readonly Job[] | null }) {
    const settledAt = threadSettledAt(jobs);
    const [retention, setRetention] = useState<Retention | null>(null);

    useEffect(() => {
        if (settledAt === null) return;
        const controller = new AbortController();
        void readRetention(controller.signal).then((result) => {
            if (result.ok) setRetention(result.retention);
        });
        return () => controller.abort();
    }, [settledAt]);

    const day = deletionDay(settledAt, retention?.days ?? null);
    if (!day) return null;
    return (
        <p className="muted">
            Deleted on {commitDate(day.toISOString())}, when the organization’s retention window ends, unless the task
            runs again.
        </p>
    );
}
