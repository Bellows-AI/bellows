import { Link } from 'react-router-dom';
import { useBatchList } from '../api/useBatches.js';
import { summaryVerdict, VERDICT_LABEL, VERDICT_PILL, type BatchSummary } from '../batch-model.js';
import { DataTable, type DataTableColumn } from '../components/DataTable.js';
import { PageHeader } from '../components/PageHeader.js';
import { RelativeTime } from '../components/RelativeTime.js';

/**
 * The org's batches, newest first (docs/design-system/batches.md). A row is a link to the batch,
 * where a draft is edited and a started batch watched; creating one is the page's one action.
 */

const COLUMNS: DataTableColumn<BatchSummary>[] = [
    {
        key: 'title',
        label: 'Batch',
        cell: (batch) => <Link to={`/batches/${batch.id}`}>{batch.title}</Link>,
        sortValue: (batch) => batch.title,
    },
    {
        key: 'status',
        label: 'Status',
        cell: (batch) => {
            const verdict = summaryVerdict(batch);
            return <span className={VERDICT_PILL[verdict]}>{VERDICT_LABEL[verdict]}</span>;
        },
        sortValue: (batch) => VERDICT_LABEL[summaryVerdict(batch)],
    },
    {
        key: 'tasks',
        label: 'Tasks',
        cell: (batch) => batch.taskCount,
        sortValue: (batch) => batch.taskCount,
        align: 'end',
    },
    {
        key: 'created',
        label: 'Created',
        cell: (batch) => <RelativeTime at={batch.createdAt} />,
        sortValue: (batch) => Date.parse(batch.createdAt),
    },
];

export function BatchesPage() {
    const { data, error, loading } = useBatchList();
    return (
        <>
            <PageHeader
                title="Batches"
                description="Plan ordered stages of parallel tasks, start them, and follow them to the last merge."
                actions={
                    <Link className="batch-new" to="/batches/new">
                        New batch
                    </Link>
                }
            />
            {error ? (
                <p className="status error" role="alert">
                    {error}
                </p>
            ) : null}
            {loading && data === null ? <p className="status">Loading batches…</p> : null}
            {data ? (
                <>
                    <h2 id="batches-table-title" className="visually-hidden">
                        All batches
                    </h2>
                    <DataTable
                        labelledBy="batches-table-title"
                        rows={data}
                        columns={COLUMNS}
                        rowKey={(batch) => batch.id}
                        initialSort={{ key: 'created', direction: 'descending' }}
                        empty={<p className="muted">No batches yet. Create one to plan a run of parallel tasks.</p>}
                    />
                </>
            ) : null}
        </>
    );
}
