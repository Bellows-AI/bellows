import { useEffect, useId, useState } from 'react';
import { type Retention, readRetention } from '../api/retention.js';
import { StateNote } from '../components/StateNote.js';
import { commitDate } from '../format.js';

/**
 * The organization's retention window on the Organization settings page (docs/retention.md): how long a finished task
 * is kept, and a shorter window with the day it applies while its 30-day notice runs. Every member reads it.
 */
export function RetentionSection() {
    const ids = useId();
    const [retention, setRetention] = useState<Retention | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        void readRetention(controller.signal).then((result) => {
            if (result.ok) setRetention(result.retention);
            else if (!result.aborted) setError(result.error);
        });
        return () => controller.abort();
    }, []);

    return (
        <section className="panel" aria-labelledby={`${ids}-title`}>
            <h2 id={`${ids}-title`}>Data retention</h2>
            {error ? <StateNote state="error">{error}</StateNote> : null}
            {retention ? (
                <RetentionText retention={retention} />
            ) : error ? null : (
                <StateNote state="loading">Loading…</StateNote>
            )}
        </section>
    );
}

export function RetentionText({ retention }: { retention: Retention }) {
    const { days, pending } = retention;
    return (
        <>
            <p>
                {days === null
                    ? 'Finished tasks are kept until the organization is deleted.'
                    : `A finished task is deleted ${days} days after its last run ends, with its logs, transcripts and files.`}
            </p>
            {pending ? (
                <p className="muted">
                    From {commitDate(pending.effectiveAt)}, finished tasks are kept for {pending.days} days.
                </p>
            ) : null}
        </>
    );
}
