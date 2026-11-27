import type { ExecutorScope } from '@factory-ai/core';
import type { ExecutorConnectionFields } from './useWorkspace.js';
import { request } from './request.js';

/**
 * The organization executor profiles' client half (issue 391): the administrators' CRUD over the
 * profiles every member of the organization may select. The list answers WITH configs to an
 * admin — the edit dialog cannot pre-fill without them — and as bare selection metadata to a
 * member, whose only consumer here is read-only.
 */

export interface OrgExecutorFull extends ExecutorConnectionFields {
    id: string;
    name: string;
    type: string;
    createdAt: string;
    updatedAt: string;
    gateFixRounds: number;
    /** The administrator who created (or last promoted) the row — an audit fact, not an ownership. */
    createdBy: string | null;
    config: object;
    /** The runner class the profile's tasks run in; null for the deployment's default. */
    runnerClass: string | null;
}

/** One validated org-profile payload, the shape POST and PUT take. */
export interface OrgExecutorInput {
    name: string;
    type: string;
    config: object;
    gateFixRounds: number;
    /** Always sent: the PUT is whole-entry, and an omitted class resets the profile to the default. */
    runnerClass: string | null;
    /** An id selects a connection, null clears it; absent keeps the row's (a legacy profile's write is unchanged). */
    providerConnectionId?: string | null;
}

/**
 * What a full org row must look like for the dialog to be safe: it pre-fills from these rows, so
 * a 2xx body that is not that shape is refused as an error result, never handed on to throw in
 * the render.
 */
const isOrgExecutorFull = (row: unknown): row is OrgExecutorFull =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as OrgExecutorFull).id === 'string' &&
    typeof (row as OrgExecutorFull).name === 'string' &&
    typeof (row as OrgExecutorFull).type === 'string' &&
    typeof (row as OrgExecutorFull).createdAt === 'string' &&
    typeof (row as OrgExecutorFull).gateFixRounds === 'number' &&
    typeof (row as OrgExecutorFull).config === 'object' &&
    (row as OrgExecutorFull).config !== null &&
    ((row as OrgExecutorFull).runnerClass === null || typeof (row as OrgExecutorFull).runnerClass === 'string');

/** The admin list's read — the dialog's opening state, configs included, fetched on demand. */
export const listOrgExecutorConfigs = async (): Promise<
    { ok: true; executors: OrgExecutorFull[] } | { ok: false; error: string }
> => {
    const result = await request<{ executors: OrgExecutorFull[] }>('/api/org/executors', {
        verb: 'Could not load the executors',
        guard: (body): body is { executors: OrgExecutorFull[] } => {
            const rows = (body as { executors?: unknown } | null)?.executors;
            return Array.isArray(rows) && rows.every(isOrgExecutorFull);
        },
        malformed: 'Could not load the executors: unexpected response shape.',
    });
    return result.ok ? { ok: true, executors: result.value.executors } : { ok: false, error: result.error };
};

/** One executor write, shared by the org CRUD and the personal by-id routes (issue 440). */
export async function executorWrite(
    url: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: unknown,
    fallbackError: string
): Promise<string | null> {
    // A bodyless write (DELETE) sends no content type either: `request` only declares JSON with a body.
    const result = await request(url, { method, body, verb: fallbackError, empty: true });
    return result.ok ? null : result.error;
}

export const createOrgExecutor = (input: OrgExecutorInput): Promise<string | null> =>
    executorWrite('/api/org/executors', 'POST', input, 'Could not save the executor');

export const updateOrgExecutor = (id: string, input: OrgExecutorInput): Promise<string | null> =>
    executorWrite(`/api/org/executors/${id}`, 'PUT', input, 'Could not save the executor');

export const deleteOrgExecutor = (id: string): Promise<string | null> =>
    executorWrite(`/api/org/executors/${id}`, 'DELETE', undefined, 'Could not delete the executor');

/** Suspends or resumes an org profile for every member (issue 440). */
export const suspendOrgExecutor = (id: string, suspended: boolean): Promise<string | null> =>
    executorWrite(
        `/api/org/executors/${id}/suspension`,
        'POST',
        { suspended },
        suspended ? 'Could not suspend the executor' : 'Could not resume the executor'
    );

/** The one route a profile's scope moves through: promote the admin's own row, or demote to it. */
export const changeOrgExecutorScope = (id: string, scope: ExecutorScope): Promise<string | null> =>
    executorWrite(`/api/org/executors/${id}/scope`, 'POST', { scope }, 'Could not move the executor');

/** Configures the organization's default executor by id: the profile every member without a default of their own launches on. */
export const setOrgDefaultExecutor = (id: string): Promise<string | null> =>
    executorWrite('/api/org/executors/default', 'PUT', { executorId: id }, 'Could not set the organization default');

/** Clears the organization's default executor; the legacy chain applies again. */
export const clearOrgDefaultExecutor = (): Promise<string | null> =>
    executorWrite('/api/org/executors/default', 'DELETE', undefined, 'Could not clear the organization default');
