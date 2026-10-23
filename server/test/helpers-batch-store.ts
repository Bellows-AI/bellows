import { randomUUID } from 'node:crypto';
import {
    BATCH_COMPLETION_ACCEPTED,
    GATE_PASSED,
    holdsSlot,
    isRetryable,
    TASK_CANCELLED,
    TASK_RETRY,
    TASK_SUCCEEDED,
    type BatchPlan,
} from '@factory-ai/core';
import {
    BATCH_DRAFT,
    BATCH_ROW_STARTED,
    BATCH_RUNNING,
    lifecycleOf,
    type BatchIdempotency,
    type BatchRecord,
    type BatchStore,
    type BatchTaskState,
} from '../src/db/batches/batch-store.js';
import { IdempotencyKeyReusedError } from '../src/db/jobs/job-store-idempotency.js';

/**
 * The in-memory double the route tests drive: the same version/status/idempotency semantics as
 * the SQL store, none of the SQL. The store's own rules are pinned by server/test-db/batch-store.test.ts.
 */
export interface MemoryBatchStore extends BatchStore {
    /** Every write that reached the store, in order — what "changes nothing" asserts against. */
    readonly writes: string[];
    /** Plants a task's runtime state, standing in for the scheduler the SQL store's own suite pins. */
    mark(id: string, taskKey: string, state: Partial<BatchTaskState>): void;
    /** Stamps the batch's time limit as passed, standing in for the scheduler pass the SQL suite pins. */
    expire(id: string): void;
    /** Stamps the batch complete, standing in for the scheduler pass the SQL suite pins. */
    complete(id: string): void;
}

/** Held records keep `draft` or `running`; reads answer the lifecycle the SQL store derives. */
const statusOf = (batch: BatchRecord) =>
    lifecycleOf({ ...batch, status: batch.status === BATCH_DRAFT ? BATCH_DRAFT : BATCH_ROW_STARTED });

export function memoryBatchStore(): MemoryBatchStore {
    const batches = new Map<string, BatchRecord>();
    const keys = new Map<string, { fingerprint: string; id: string }>();
    const writes: string[] = [];
    const scope = (caller: string | null, idem: BatchIdempotency) => [caller ?? '', idem.operation, idem.key].join('|');
    const recorded = (caller: string | null, idem: BatchIdempotency | undefined) => {
        if (!idem) return null;
        const hit = keys.get(scope(caller, idem));
        if (!hit) return null;
        if (hit.fingerprint !== idem.fingerprint) throw new IdempotencyKeyReusedError();
        return hit.id;
    };
    const stamp = (caller: string | null, idem: BatchIdempotency | undefined, id: string) => {
        if (idem) keys.set(scope(caller, idem), { fingerprint: idem.fingerprint, id });
    };
    const taskStates = (plan: BatchPlan) =>
        plan.stages.flatMap((stage) =>
            stage.tasks.map((task) => ({
                key: task.key,
                stage: stage.key,
                execution: 'pending',
                pr: 'none',
                gate: 'open',
                waitReason: null,
                attention: null,
                closedAt: null,
                rootJobId: null,
                attempt: 0,
            }))
        );

    return {
        writes,
        async create(plan, createdBy, idempotency) {
            const replayed = recorded(createdBy, idempotency);
            if (replayed) return { id: replayed, version: batches.get(replayed)!.version, replayed: true };
            const id = randomUUID();
            const now = new Date().toISOString();
            batches.set(id, {
                id,
                status: BATCH_DRAFT,
                version: 1,
                createdBy,
                startedBy: null,
                createdAt: now,
                updatedAt: now,
                startedAt: null,
                cancelledAt: null,
                completedAt: null,
                deadlineAt: null,
                expiredAt: null,
                activeStage: null,
                plan,
                tasks: taskStates(plan),
                verification: [],
            });
            stamp(createdBy, idempotency, id);
            writes.push('create');
            return { id, version: 1 };
        },
        async get(id) {
            const batch = batches.get(id);
            return batch ? { ...batch, status: statusOf(batch) } : null;
        },
        async list(rootJobId) {
            const matching = [...batches.values()].filter(
                (batch) => rootJobId === undefined || batch.tasks.some((task) => task.rootJobId === rootJobId)
            );
            return matching.map((batch) => ({
                id: batch.id,
                title: batch.plan.title,
                status: statusOf(batch),
                version: batch.version,
                taskCount: batch.tasks.length,
                createdBy: batch.createdBy,
                createdAt: batch.createdAt,
                updatedAt: batch.updatedAt,
                startedAt: batch.startedAt,
                cancelledAt: batch.cancelledAt,
                completedAt: batch.completedAt,
                expiredAt: batch.expiredAt,
            }));
        },
        async replace(id, version, plan) {
            const batch = batches.get(id);
            if (!batch) return { result: 'missing' };
            if (batch.status !== BATCH_DRAFT) return { result: 'started' };
            if (batch.version !== version) return { result: 'stale', version: batch.version };
            batches.set(id, { ...batch, version: version + 1, plan, tasks: taskStates(plan) });
            writes.push('replace');
            return { result: 'ok', version: version + 1 };
        },
        async replayOfStart(createdBy, idempotency) {
            return recorded(createdBy, idempotency);
        },
        async start({ id, version, plan, startedBy, idempotency }) {
            if (recorded(startedBy, idempotency)) return { result: 'ok', replayed: true };
            const batch = batches.get(id);
            if (!batch) return { result: 'missing' };
            if (batch.status !== BATCH_DRAFT) return { result: 'started' };
            if (batch.version !== version) return { result: 'stale', version: batch.version };
            batches.set(id, {
                ...batch,
                status: BATCH_RUNNING,
                startedBy,
                startedAt: new Date().toISOString(),
                deadlineAt: new Date(Date.now() + plan.timeLimitMinutes * 60_000).toISOString(),
                plan: plan as unknown as BatchPlan,
            });
            stamp(startedBy, idempotency, id);
            writes.push('start');
            return { result: 'ok' };
        },
        async reconcile(id) {
            const batch = batches.get(id);
            if (!batch || batch.status === BATCH_DRAFT) return null;
            writes.push('reconcile');
            return {
                complete: batch.completedAt !== null,
                cancelled: batch.cancelledAt !== null,
                expired: batch.expiredAt !== null,
                active: batch.tasks.filter((task) => holdsSlot(task.execution)).length,
                waiting: batch.tasks.filter((task) => task.execution === TASK_RETRY).length,
            };
        },
        async reconcileOpen() {
            writes.push('reconcileOpen');
        },
        async cancel(id) {
            const batch = batches.get(id);
            if (!batch) return { result: 'missing' };
            if (batch.status === BATCH_DRAFT) return { result: 'not_started' };
            if (batch.cancelledAt) return { result: 'ok', replayed: true };
            if (batch.completedAt) return { result: 'finished' };
            batches.set(id, { ...batch, cancelledAt: new Date().toISOString() });
            writes.push('cancel');
            return { result: 'ok', replayed: false };
        },
        async retry(id, taskKey) {
            const batch = batches.get(id);
            if (!batch) return { result: 'missing' };
            if (batch.status === BATCH_DRAFT) return { result: 'not_started' };
            if (batch.cancelledAt) return { result: 'cancelled' };
            if (batch.expiredAt) return { result: 'expired' };
            const task = batch.tasks.find((candidate) => candidate.key === taskKey);
            if (!task) return { result: 'no_task' };
            if (!isRetryable(task)) return { result: 'not_retryable' };
            task.execution = TASK_RETRY;
            writes.push('retry');
            return { result: 'ok' };
        },
        async accept(id, taskKey, acceptedBy) {
            const batch = batches.get(id);
            if (!batch) return { result: 'missing' };
            if (batch.status === BATCH_DRAFT) return { result: 'not_started' };
            if (batch.cancelledAt) return { result: 'cancelled' };
            const task = batch.tasks.find((candidate) => candidate.key === taskKey);
            if (!task) return { result: 'no_task' };
            const planned = batch.plan.stages.flatMap((stage) => stage.tasks).find((t) => t.key === taskKey);
            if (planned?.completion.kind !== BATCH_COMPLETION_ACCEPTED) return { result: 'not_acceptable' };
            if (task.execution !== TASK_SUCCEEDED) return { result: 'not_ready' };
            task.gate = GATE_PASSED;
            writes.push(`accept:${acceptedBy}`);
            return { result: 'ok' };
        },
        async report(id) {
            const batch = batches.get(id);
            if (!batch || batch.status === BATCH_DRAFT) return null;
            return {
                id,
                title: batch.plan.title,
                state: batch.cancelledAt ? 'cancelled' : batch.expiredAt ? 'expired' : 'parked',
                startedAt: batch.startedAt!,
                deadlineAt: batch.deadlineAt!,
                expiredAt: batch.expiredAt,
                cancelledAt: batch.cancelledAt,
                completedAt: batch.completedAt,
                budgets: {
                    infraRetries: batch.plan.infraRetries,
                    repairs: batch.plan.repairs,
                    timeLimitMinutes: batch.plan.timeLimitMinutes,
                },
                prs: { merged: [], open: [] },
                verification: [],
                tasks: [],
                latestObservationAt: null,
                unavailable: ['tokens', 'cost'],
                totals: {
                    accepted: 0,
                    failed: 0,
                    needsAttention: 0,
                    infraRetries: 0,
                    repairs: 0,
                    wallClockMs: 0,
                    agentTurns: 0,
                },
            };
        },
        async closeTask(jobId, closedBy) {
            for (const [id, batch] of batches) {
                const task = batch.tasks.find((candidate) => candidate.rootJobId === jobId);
                if (!task) continue;
                const kept = task.execution === TASK_SUCCEEDED && task.gate === GATE_PASSED;
                if (!kept) task.execution = TASK_CANCELLED;
                writes.push(`close:${task.key}:${closedBy}`);
                const outcome = kept ? ('kept' as const) : ('cancelled' as const);
                return { batchId: id, task: task.key, outcome, pr: null, doneAt: new Date().toISOString() };
            }
            return null;
        },
        expire(id) {
            const batch = batches.get(id)!;
            batches.set(id, { ...batch, expiredAt: new Date().toISOString() });
        },
        complete(id) {
            const batch = batches.get(id)!;
            batches.set(id, { ...batch, completedAt: new Date().toISOString() });
        },
        mark(id, taskKey, state) {
            const task = batches.get(id)!.tasks.find((candidate) => candidate.key === taskKey)!;
            Object.assign(task, state);
        },
    };
}
