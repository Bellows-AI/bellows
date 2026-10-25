import { randomUUID } from 'node:crypto';
import type { ExecutionEvidence } from '@factory-ai/core';
import { emptyUsageFacts, type UsageFacts } from '../src/telemetry/usage-facts.js';
import { point } from './helpers-usage.js';

const T0 = Date.parse('2026-09-22T10:00:00.000Z');
/** An instant `minutes` after the world's start. */
export const minute = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function claim(over: Partial<ExecutionEvidence> & Pick<ExecutionEvidence, 'jobId' | 'rootJobId' | 'sessionId'>) {
    return {
        orgId: 'stub',
        claimSeq: 1,
        agent: 'claude-code',
        requestingJobId: null,
        requestingRootJobId: null,
        authorId: null,
        repo: 'acme/web',
        launch: 'observed',
        adoptsClaimSeq: null,
        origin: 'claim',
        live: false,
        removed: false,
        operational: true,
        startedAt: null,
        endedAt: null,
        ...over,
    } satisfies ExecutionEvidence;
}

/**
 * One task: a first run and a follow-up sharing a session, and a named review on a session of its own
 * (a separate thread, absent from the task's operational thread). Ids are generated per call.
 * Minutes: root [0,10], follow-up [12,20], review [30,40]; the shared session's minute-11 amount sits in
 * the gap between the two runs and is task-owned.
 */
export function activityWorld() {
    const [task, followUp, review, shared, reviewSession] = Array.from({ length: 5 }, () => randomUUID());
    const ids = { task: task!, followUp: followUp!, review: review! };
    const facts: UsageFacts = {
        ...emptyUsageFacts('stub'),
        board: [
            claim({
                jobId: ids.task,
                rootJobId: ids.task,
                sessionId: shared!,
                startedAt: minute(0),
                endedAt: minute(10),
            }),
            claim({
                jobId: ids.followUp,
                rootJobId: ids.task,
                sessionId: shared!,
                startedAt: minute(12),
                endedAt: minute(20),
            }),
            claim({
                jobId: ids.review,
                rootJobId: ids.review,
                requestingJobId: ids.task,
                requestingRootJobId: ids.task,
                sessionId: reviewSession!,
                startedAt: minute(30),
                endedAt: minute(40),
            }),
        ],
        contributions: [
            point(shared!, 'output', 100, minute(5)),
            point(shared!, 'input', 7, minute(5)),
            point(shared!, 'output', 40, minute(11)),
            point(shared!, 'output', 60, minute(15)),
            point(reviewSession!, 'output', 25, minute(35)),
        ],
        edits: [point(shared!, 'input', 3, minute(5))],
    };
    return { ids, facts };
}
