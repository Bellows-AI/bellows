import { Link } from 'react-router-dom';
import { useBatchesOfTask } from '../api/useBatches.js';

/**
 * The batch a task belongs to, as a line above the task: a batch thread is batch history, so the
 * way back to the plan and its gate is one link. Renders nothing for a task no batch backs, and
 * nothing — with no fetch — while batches are off (BEL-264).
 */
export function BatchBacklink({ rootId, enabled }: { rootId: string | null; enabled: boolean }) {
    return enabled ? <BatchBacklinkOf rootId={rootId} /> : null;
}

/** The fetching half, mounted only while batches are on, so a board with them off never asks `/api/batches`. */
function BatchBacklinkOf({ rootId }: { rootId: string | null }) {
    const batches = useBatchesOfTask(rootId);
    if (batches.length === 0) return null;
    return (
        <p className="batch-backlink">
            Part of batch{batches.length > 1 ? 'es' : ''}{' '}
            {batches.map((batch, index) => (
                <span key={batch.id}>
                    {index > 0 ? ', ' : ''}
                    <Link to={`/batches/${batch.id}`}>{batch.title}</Link>
                </span>
            ))}
        </p>
    );
}
