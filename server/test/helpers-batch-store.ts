import { randomUUID } from 'node:crypto';
import type { BatchPlan } from '@factory-ai/core';
import {
    BATCH_DRAFT,
    BATCH_STARTED,
    type BatchIdempotency,
    type BatchRecord,
    type BatchStore,
} from '../src/db/batch-store.js';
import { IdempotencyKeyReusedError } from '../src/db/job-store-idempotency.js';

/**
 * The in-memory double the route tests drive: the same version/status/idempotency semantics as
 * the SQL store, none of the SQL. The store's own rules are pinned by server/test-db/batch-store.test.ts.
 */
export interface MemoryBatchStore extends BatchStore {
    /** Every write that reached the store, in order — what "changes nothing" asserts against. */
    readonly writes: string[];
}

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
                rootJobId: null,
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
                plan,
                tasks: taskStates(plan),
            });
            stamp(createdBy, idempotency, id);
            writes.push('create');
            return { id, version: 1 };
        },
        async get(id) {
            return batches.get(id) ?? null;
        },
        async list() {
            return [...batches.values()].map((batch) => ({
                id: batch.id,
                title: batch.plan.title,
                status: batch.status,
                version: batch.version,
                taskCount: batch.tasks.length,
                createdBy: batch.createdBy,
                createdAt: batch.createdAt,
                updatedAt: batch.updatedAt,
                startedAt: batch.startedAt,
            }));
        },
        async replace(id, version, plan) {
            const batch = batches.get(id);
            if (!batch) return { result: 'missing' };
            if (batch.status === BATCH_STARTED) return { result: 'started' };
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
            if (batch.status === BATCH_STARTED) return { result: 'started' };
            if (batch.version !== version) return { result: 'stale', version: batch.version };
            batches.set(id, {
                ...batch,
                status: BATCH_STARTED,
                startedBy,
                startedAt: new Date().toISOString(),
                plan: plan as unknown as BatchPlan,
            });
            stamp(startedBy, idempotency, id);
            writes.push('start');
            return { result: 'ok' };
        },
    };
}
