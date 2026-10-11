import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { batchActions, useBatch } from '../api/useBatches.js';
import { batchVerdict, BATCH_DRAFT, VERDICT_LABEL, VERDICT_PILL, type BatchRecord } from '../batch-model.js';
import { PageHeader } from '../components/PageHeader.js';
import { RelativeTime } from '../components/RelativeTime.js';
import { BatchDraft } from '../panels/BatchDraft.js';
import { BatchMonitor } from '../panels/BatchMonitor.js';

/**
 * `/batches/:id`: a draft opens its editor, a started batch its monitor. The record is the
 * board's, polled until it settles; every control below is a request, and the answer is read back
 * rather than assumed (docs/design-system/batches.md).
 */

function StartedBatch({ batch, refresh }: { batch: BatchRecord; refresh: () => void }) {
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const verdict = batchVerdict(batch);

    const act = async (key: string, request: () => Promise<{ ok: boolean; error?: string }>) => {
        setPending(key);
        setError(null);
        const result = await request();
        setPending(null);
        if (!result.ok) {
            setError(result.error ?? 'The board refused the request');
            return result.error ?? null;
        }
        refresh();
        return null;
    };

    const cancel = async () => {
        setConfirming(false);
        await act('batch', () => batchActions.cancel(batch.id));
    };

    return (
        <>
            <PageHeader
                eyebrow="Batches"
                title={batch.plan.title}
                meta={
                    <>
                        <span className={VERDICT_PILL[verdict]}>{VERDICT_LABEL[verdict]}</span>
                        <span className="muted">
                            started <RelativeTime at={batch.startedAt} />
                        </span>
                    </>
                }
                actions={
                    verdict === 'completed' || verdict === 'cancelled' ? undefined : confirming ? (
                        <>
                            <button type="button" className="danger" onClick={() => void cancel()}>
                                Confirm cancel
                            </button>
                            <button type="button" onClick={() => setConfirming(false)}>
                                Keep running
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            className="danger"
                            disabled={pending !== null}
                            onClick={() => setConfirming(true)}
                        >
                            Cancel batch
                        </button>
                    )
                }
            />
            {confirming ? (
                <p className="banner-warn" role="alert">
                    Cancelling stops every running task and starts nothing more. Merged pull requests stay merged.
                </p>
            ) : null}
            {error ? (
                <p className="status error" role="alert">
                    {error}
                </p>
            ) : null}
            <BatchMonitor
                batch={batch}
                pending={pending}
                onRetry={(key) => act(key, () => batchActions.retry(batch.id, key))}
                onAccept={(key) => act(key, () => batchActions.accept(batch.id, key))}
            />
        </>
    );
}

export function BatchDetailPage() {
    const { id } = useParams();
    const { data, error, loading, refresh } = useBatch(id ?? null);

    if (loading && data === null) return <p className="status">Loading the batch…</p>;
    if (data === null) {
        return (
            <>
                <PageHeader eyebrow="Batches" title="Batch not found" />
                <p className="status error" role="alert">
                    {error ?? 'No such batch.'}
                </p>
                <p>
                    <Link to="/batches">Back to batches</Link>
                </p>
            </>
        );
    }
    return data.status === BATCH_DRAFT ? (
        <BatchDraft key={data.id} record={data} onChanged={refresh} />
    ) : (
        <StartedBatch batch={data} refresh={refresh} />
    );
}
