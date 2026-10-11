import { validateBatchPlan, type BatchPlan, type BatchPlanIssue } from '@factory-ai/core';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { batchActions, newIdempotencyKey } from '../api/useBatches.js';
import { useRepos } from '../api/useRepos.js';
import { blankPlan, type BatchRecord } from '../batch-model.js';
import { PageHeader } from '../components/PageHeader.js';
import { BatchEditor } from './BatchEditor.js';
import { BatchPlanReview } from './BatchPlanReview.js';

/**
 * A draft, new or saved: the editor over the plan, and the three things the board does with a
 * draft — save it whole (create, or `PUT` on the version last read), check it against the launch
 * rules, start it. Start and check act on what is SAVED, so both stay off while the form differs
 * from it. The plan is judged by `validateBatchPlan` before a write; the board judges it again and
 * is the authority (docs/batches.md).
 */

const sameplan = (a: BatchPlan, b: BatchPlan | null): boolean => b !== null && JSON.stringify(a) === JSON.stringify(b);

/** Start retried after a lost reply must answer once: one key per (draft, version), minted on first use. */
function useStartKey() {
    const keys = useRef(new Map<string, string>());
    return (scope: string) => {
        const known = keys.current.get(scope);
        if (known) return known;
        const minted = newIdempotencyKey();
        keys.current.set(scope, minted);
        return minted;
    };
}

type Persisted =
    | { ok: true; id: string; plan: BatchPlan; issues: BatchPlanIssue[] }
    | { ok: false; error: string; issues: BatchPlanIssue[] };

/** Judge the plan, then write it: a create for a new draft, a `PUT` on the version last read for a saved one. */
async function persistDraft(plan: BatchPlan, record: BatchRecord | null): Promise<Persisted> {
    const checked = validateBatchPlan(plan);
    if (!checked.ok) {
        return { ok: false, error: 'The plan has problems; each is marked at its field.', issues: checked.issues };
    }
    const result = record
        ? await batchActions.replace(record.id, record.version, checked.plan)
        : await batchActions.create(checked.plan, newIdempotencyKey());
    if (!result.ok) return { ok: false, error: result.error, issues: result.issues ?? [] };
    return { ok: true, id: result.data.id, plan: checked.plan, issues: [] };
}

export function BatchDraft({ record, onChanged }: { record: BatchRecord | null; onChanged: () => void }) {
    const navigate = useNavigate();
    const repos = useRepos(true).data?.repos.map((repo) => `${repo.owner}/${repo.name}`) ?? [];
    const [plan, setPlan] = useState<BatchPlan>(() => record?.plan ?? blankPlan(''));
    const [issues, setIssues] = useState<BatchPlanIssue[]>([]);
    const [message, setMessage] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const startKey = useStartKey();

    const saved = record?.plan ?? null;
    const dirty = !sameplan(plan, saved);

    const run = async (action: () => Promise<string | null>) => {
        setBusy(true);
        setMessage('');
        setError(null);
        try {
            const failed = await action();
            if (failed) setError(failed);
        } finally {
            setBusy(false);
        }
    };

    const save = () =>
        run(async () => {
            const written = await persistDraft(plan, record);
            setIssues(written.issues);
            if (!written.ok) return written.error;
            setPlan(written.plan);
            setMessage('Draft saved.');
            if (record) onChanged();
            else void navigate(`/batches/${written.id}`, { replace: true });
            return null;
        });

    const check = () =>
        run(async () => {
            if (!record) return null;
            const result = await batchActions.validate(record.id);
            if (!result.ok) return result.error;
            setMessage('Launch checks passed. Starting freezes this plan.');
            return null;
        });

    const start = () =>
        run(async () => {
            if (!record) return null;
            const result = await batchActions.start(
                record.id,
                record.version,
                startKey(`${record.id}:${record.version}`)
            );
            if (!result.ok) return result.error;
            onChanged();
            return null;
        });

    return (
        <>
            <PageHeader
                eyebrow="Batches"
                title={record ? plan.title || 'Untitled draft' : 'New batch'}
                description="Ordered stages of parallel tasks. Starting freezes the plan; the board then runs it, one stage at a time."
                actions={
                    <>
                        <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void save()}>
                            Save draft
                        </button>
                        <button type="button" disabled={busy || !record || dirty} onClick={() => void check()}>
                            Check launch
                        </button>
                        <button
                            type="button"
                            className={record && !dirty ? 'primary' : undefined}
                            disabled={busy || !record || dirty}
                            onClick={() => void start()}
                        >
                            Start batch
                        </button>
                    </>
                }
            />
            <p className="status" role="status">
                {message}
            </p>
            {error ? (
                <p className="status error" role="alert">
                    {error}
                </p>
            ) : null}
            {record && dirty ? <p className="muted">Unsaved changes — save before checking or starting.</p> : null}
            <BatchEditor plan={plan} onChange={setPlan} issues={issues} repos={repos} disabled={busy} />
            {saved ? <BatchPlanReview plan={saved} /> : null}
        </>
    );
}
