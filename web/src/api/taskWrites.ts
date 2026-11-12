import type { ExecutorScope } from '@factory-ai/core';
import { request } from './request.js';
import type { QueueResult } from './useJobs.js';

/** The task mutations' wire calls, each one `request`: the hook re-arms the poll after a success. */

/**
 * A rename's answer: saved, refused because the title moved on since the page rendered it
 * (`stale` carries what the board holds now), or failed with a sentence to show.
 */
export type RenameOutcome =
    | { state: 'saved' }
    | { state: 'stale'; title: string; revision: number }
    | { state: 'failed'; error: string };

/** What starting a task takes — bundled so the queueing call stays under the param-count limit.
 * A null `workflow` is objective mode: the prompt runs as written. */
export interface QueueTaskInput {
    command: string;
    repo: string | null;
    executor: string;
    /** The scope `executor` names: the author's own profiles or the organization's. */
    executorScope: ExecutorScope;
    workflow: string | null;
    workflowParams: Record<string, string> | null;
    /** The branch the task works from; null is the repository's default branch. */
    baseBranch?: string | null;
    /** Built-in skills the prompt names with a `/name` token; absent when it names none. */
    skills?: string[];
    /** Completed upload ids; absent for a text-only task, so that body is unchanged. */
    attachments?: string[];
    /** Sent as the `Idempotency-Key` header, never in the body; set beside `attachments`. */
    idempotencyKey?: string;
}

/** The uploaded files a submission carries, and the key that makes its retry safe. */
export interface SubmittedFiles {
    attachments: string[];
    idempotencyKey: string;
}

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Starts a task. A 401 is handed to the gate rather than reported as this call's own error. */
export async function queueTask(input: QueueTaskInput): Promise<QueueResult> {
    const { idempotencyKey, ...body } = input;
    const result = await request<{ id: string }>('/api/jobs', {
        method: 'POST',
        body,
        ...(idempotencyKey === undefined ? {} : { headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey } }),
        verb: 'Could not queue the task',
    });
    return result.ok ? { id: result.value.id, error: null } : { id: null, error: result.error };
}

/** Queues a follow-up on an existing thread — the same wire shape as `queueTask`, one thread id. */
export async function followUpOnTask(id: string, command: string, files?: SubmittedFiles): Promise<QueueResult> {
    const result = await request<{ id: string }>(`/api/jobs/${id}/follow-up`, {
        method: 'POST',
        body: files === undefined ? { command } : { command, attachments: files.attachments },
        ...(files === undefined ? {} : { headers: { [IDEMPOTENCY_KEY_HEADER]: files.idempotencyKey } }),
        verb: 'Could not queue the follow-up',
    });
    return result.ok ? { id: result.value.id, error: null } : { id: null, error: result.error };
}

const HTTP_STATUS_CONFLICT = 409;

/** `PUT /api/jobs/:id/title`: compare-and-set on the revision the page rendered. A 409 names the current title. */
export async function renameTask(id: string, title: string, revision: number): Promise<RenameOutcome> {
    const result = await request(`/api/jobs/${id}/title`, {
        method: 'PUT',
        body: { title, revision },
        verb: 'Could not rename the task',
        empty: true,
    });
    if (result.ok) return { state: 'saved' };
    if (result.status === HTTP_STATUS_CONFLICT) {
        const current = result.body ?? {};
        if (typeof current.title === 'string' && typeof current.revision === 'number') {
            return { state: 'stale', title: current.title, revision: current.revision };
        }
    }
    return { state: 'failed', error: result.error };
}

/**
 * The shared shape of `markDone`/`stop`/`remove`: a bare POST that answers no body worth keeping,
 * where only the fallback `verb` differs between the three routes.
 */
export async function postTaskAction(url: string, verb: string): Promise<string | null> {
    const result = await request(url, { method: 'POST', verb, empty: true });
    return result.ok ? null : result.error;
}
