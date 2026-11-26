import {
    isModelProvider,
    type ModelProvider,
    type ProviderConnectionMeta,
    type ProviderConnectionModels,
    type ProviderConnectionScope,
} from '@factory-ai/core';
import { request } from './request.js';

/**
 * The provider connections' client half (docs/api.md, `/api/provider-connections`): the safe-metadata list, the guarded
 * writes and the live model read. Nothing here holds or returns a stored key — a key travels only in a create or a
 * rotation body, and no answer echoes one.
 */

export type { ProviderConnectionMeta, ProviderConnectionModels, ProviderConnectionScope };

export const PROVIDER_CONNECTIONS_URL = '/api/provider-connections';

/** What a list row must look like before a page renders it: a malformed 2xx is an error, never a crash. */
const isMeta = (row: unknown): row is ProviderConnectionMeta => {
    const meta = row as ProviderConnectionMeta | null;
    return (
        typeof meta === 'object' &&
        meta !== null &&
        typeof meta.id === 'string' &&
        typeof meta.name === 'string' &&
        isModelProvider(meta.provider) &&
        (meta.scope === 'org' || meta.scope === 'personal')
    );
};

export type ConnectionsRead = { ok: true; connections: ProviderConnectionMeta[] } | { ok: false; error: string };

/** The connections the member may see (their own and the organization's); a failed read is an error, never "none". */
export async function listProviderConnections(signal?: AbortSignal): Promise<ConnectionsRead & { aborted?: true }> {
    const result = await request<{ connections: ProviderConnectionMeta[] }>(PROVIDER_CONNECTIONS_URL, {
        ...(signal ? { signal } : {}),
        verb: 'Could not load the provider connections',
        guard: (body): body is { connections: ProviderConnectionMeta[] } => {
            const rows = (body as { connections?: unknown } | null)?.connections;
            return Array.isArray(rows) && rows.every(isMeta);
        },
        malformed: 'Could not load the provider connections: unexpected response shape.',
    });
    if (result.ok) return { ok: true, connections: result.value.connections };
    return { ok: false, error: result.error, ...(result.aborted ? { aborted: true as const } : {}) };
}

export interface ProviderConnectionCreate {
    scope: ProviderConnectionScope;
    name: string;
    provider: ModelProvider;
    key: string;
    baseUrl?: string;
}

/** A metadata edit: an omitted field keeps the row's, and a present `key` is an explicit rotation. */
export interface ProviderConnectionEdit {
    name?: string;
    baseUrl?: string | null;
    key?: string;
}

export type ConnectionWrite = { ok: true; connection: ProviderConnectionMeta } | { ok: false; error: string };

export async function createProviderConnection(input: ProviderConnectionCreate): Promise<ConnectionWrite> {
    const result = await request<ProviderConnectionMeta>(PROVIDER_CONNECTIONS_URL, {
        method: 'POST',
        body: input,
        verb: 'Could not save the connection',
        guard: (body): body is ProviderConnectionMeta => isMeta(body),
    });
    return result.ok ? { ok: true, connection: result.value } : { ok: false, error: result.error };
}

export async function updateProviderConnection(id: string, edit: ProviderConnectionEdit): Promise<ConnectionWrite> {
    const result = await request<ProviderConnectionMeta>(`${PROVIDER_CONNECTIONS_URL}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: edit,
        verb: 'Could not save the connection',
        guard: (body): body is ProviderConnectionMeta => isMeta(body),
    });
    return result.ok ? { ok: true, connection: result.value } : { ok: false, error: result.error };
}

/** One executor that still selects a connection, as the removal refusal names it (only those the caller can see). */
export interface ReferencingExecutor {
    name: string;
    scope: ProviderConnectionScope;
}

export type ConnectionRemoval =
    | { ok: true }
    | { ok: false; error: string }
    | { ok: false; error: string; inUse: true; executors: ReferencingExecutor[]; otherReferences: boolean };

/** Removal is refused while an executor selects the connection, naming the visible ones — never a silent clear. */
export async function removeProviderConnection(id: string): Promise<ConnectionRemoval> {
    const result = await request(`${PROVIDER_CONNECTIONS_URL}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        verb: 'Could not remove the connection',
        empty: false,
    });
    if (result.ok) return { ok: true };
    const body = result.body as { executors?: unknown; otherReferences?: unknown } | undefined;
    if (result.status === HTTP_CONFLICT && Array.isArray(body?.executors)) {
        return {
            ok: false,
            error: result.error,
            inUse: true,
            executors: body.executors as ReferencingExecutor[],
            otherReferences: body.otherReferences === true,
        };
    }
    return { ok: false, error: result.error };
}

const HTTP_CONFLICT = 409;

/**
 * What a live model read came to: the catalog (possibly empty — a real answer), a provider with no catalog to list,
 * or a failure of the read itself (a provider outcome or a transport error — never an authoritative empty list).
 */
export type ConnectionModels =
    | { state: 'loading' }
    | { state: 'listed'; models: readonly string[] }
    | { state: 'unsupported' }
    | { state: 'failed'; message: string };

const isAnswer = (body: unknown): body is ProviderConnectionModels => {
    const answer = body as ProviderConnectionModels | null;
    if (typeof answer !== 'object' || answer === null) return false;
    if (answer.state === 'listed') return Array.isArray(answer.models);
    return answer.state === 'unsupported' || answer.state === 'failed';
};

/** `GET /api/provider-connections/:id/models`: the stored key's live catalog, read through the board (10 a minute). */
export async function fetchConnectionModels(id: string, signal: AbortSignal): Promise<ConnectionModels | null> {
    const result = await request<ProviderConnectionModels>(
        `${PROVIDER_CONNECTIONS_URL}/${encodeURIComponent(id)}/models`,
        {
            signal,
            verb: 'Could not list the models',
            guard: (body): body is ProviderConnectionModels => isAnswer(body),
            malformed: 'Could not list the models: unexpected response shape.',
        }
    );
    // The member left the selection: the answer is not wanted, and no state follows from it.
    if (result.aborted) return null;
    if (!result.ok) return { state: 'failed', message: result.error };
    const answer = result.value;
    if (answer.state === 'listed') return { state: 'listed', models: answer.models };
    if (answer.state === 'unsupported') return { state: 'unsupported' };
    return { state: 'failed', message: answer.message };
}
