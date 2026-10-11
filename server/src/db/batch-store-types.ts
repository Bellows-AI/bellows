import type { BatchPlan, ResolvedBatchPlan } from '@factory-ai/core';

export const BATCH_DRAFT = 'draft';
export const BATCH_STARTED = 'started';
export type BatchStatus = typeof BATCH_DRAFT | typeof BATCH_STARTED;

/** Newest first; the list is a board overview, not a report. */
export const BATCH_LIST_LIMIT = 100;

export const BATCH_CREATE = 'batch-create';
export const BATCH_START = 'batch-start';
export type BatchOperation = typeof BATCH_CREATE | typeof BATCH_START;

export interface BatchIdempotency {
    operation: BatchOperation;
    key: string;
    fingerprint: string;
}

/** The per-task state fields: declared here, given their transitions by the dispatch and PR issues. */
export interface BatchTaskState {
    key: string;
    stage: string;
    execution: string;
    pr: string;
    gate: string;
    waitReason: string | null;
    rootJobId: string | null;
}

export interface BatchSummary {
    id: string;
    title: string;
    status: BatchStatus;
    version: number;
    taskCount: number;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
}

export interface BatchRecord extends Omit<BatchSummary, 'title' | 'taskCount'> {
    startedBy: string | null;
    /** As written while a draft; the resolved plan once started. */
    plan: BatchPlan;
    tasks: BatchTaskState[];
}

/** Why a draft write or freeze did not happen. `version` is the draft's current one when stale. */
export type BatchWriteRefusal = { result: 'missing' } | { result: 'started' } | { result: 'stale'; version: number };

export interface BatchStartInput {
    id: string;
    /** The draft version the resolved plan was derived from. */
    version: number;
    plan: ResolvedBatchPlan;
    startedBy: string | null;
    idempotency?: BatchIdempotency | undefined;
}

export interface BatchStore {
    create(
        plan: BatchPlan,
        createdBy: string | null,
        idempotency?: BatchIdempotency
    ): Promise<{ id: string; version: number; replayed?: boolean }>;
    get(id: string): Promise<BatchRecord | null>;
    list(): Promise<BatchSummary[]>;
    /** Replaces the whole draft, bumping its version; conditional on the version the caller last read. */
    replace(
        id: string,
        version: number,
        plan: BatchPlan
    ): Promise<{ result: 'ok'; version: number } | BatchWriteRefusal>;
    /** The batch a key already started, without writing — the route's replay check before its launch checks. */
    replayOfStart(createdBy: string | null, idempotency: BatchIdempotency): Promise<string | null>;
    /** Freezes the resolved plan, conditional on the draft's version. Queues nothing. */
    start(input: BatchStartInput): Promise<{ result: 'ok'; replayed?: boolean } | BatchWriteRefusal>;
}
