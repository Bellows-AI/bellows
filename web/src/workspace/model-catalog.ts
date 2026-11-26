import { type ExecutorType, type ModelProvider, normalizeModelId, type ProviderConnectionMeta } from '@factory-ai/core';
import type { ConnectionModels } from '../api/providerConnections.js';
import { modelOptions } from '../model-setup/providers.js';

/**
 * What a selected connection's model read means for the Model control and the model chips (docs/workspace.md): the five
 * states are kept apart on purpose. A successful empty list ("the provider has none") and a failed read ("we could not
 * ask") must never read alike, and neither of them may take away the member's way to type a model by name.
 */
export type ModelCatalog =
    /** No connection selected: today's behavior — nothing listed beyond the member's own text. */
    | { kind: 'none' }
    | { kind: 'loading'; connection: string }
    | { kind: 'listed'; connection: string; models: readonly string[] }
    /** A successful answer that lists nothing. */
    | { kind: 'empty'; connection: string }
    /** The provider has no catalog to read; the curated suggestions stand in. */
    | { kind: 'unsupported'; connection: string; fallback: readonly string[] }
    /** The read failed; the curated suggestions stand in and the sentence says why. */
    | { kind: 'failed'; connection: string; message: string; fallback: readonly string[] };

/**
 * The one rule for a model id taken from a connection: the model setup's `normalizeModelId` (OpenCode names a model
 * `<provider>/<model>`, Claude Code's id is kept), so what is offered, picked and saved is what the server accepts.
 * '' is Default and stays empty; an unknown agent cannot be judged, so the id is kept as given.
 */
export function normalizedChoices(provider: ModelProvider, agent: ExecutorType | null, model: string): string {
    return model === '' || agent === null ? model : normalizeModelId(provider, agent, model);
}

export function modelCatalogOf(
    connection: Pick<ProviderConnectionMeta, 'name' | 'provider'> | undefined,
    agent: ExecutorType | null,
    read: ConnectionModels | null
): ModelCatalog {
    if (connection === undefined || read === null) return { kind: 'none' };
    const name = connection.name;
    const norm = (id: string) => normalizedChoices(connection.provider, agent, id);
    const curated = agent === null ? [] : modelOptions(connection.provider, agent, undefined).map(norm);
    switch (read.state) {
        case 'loading':
            return { kind: 'loading', connection: name };
        case 'listed':
            return read.models.length === 0
                ? { kind: 'empty', connection: name }
                : { kind: 'listed', connection: name, models: read.models.map(norm) };
        case 'unsupported':
            return { kind: 'unsupported', connection: name, fallback: curated };
        case 'failed':
            return { kind: 'failed', connection: name, message: read.message, fallback: curated };
    }
}

/** The names a catalog offers to pick from: the live list, or the curated fallback while it cannot be read. */
export function catalogModels(catalog: ModelCatalog): readonly string[] {
    if (catalog.kind === 'listed') return catalog.models;
    if (catalog.kind === 'unsupported' || catalog.kind === 'failed') return catalog.fallback;
    return [];
}

/** The sentence under the model control for a catalog; null when there is nothing to say. */
export function catalogNote(catalog: ModelCatalog): string | null {
    switch (catalog.kind) {
        case 'none':
            return null;
        case 'loading':
            return `Loading the models ${catalog.connection} offers…`;
        case 'listed':
            return `${catalog.models.length} ${catalog.models.length === 1 ? 'model' : 'models'} from ${catalog.connection}. You can also type any model name it serves.`;
        case 'empty':
            return `${catalog.connection} lists no models. Type the name of the model to use.`;
        case 'unsupported':
            return `${catalog.connection} does not list its models, so these are suggestions. Type any model name it serves.`;
        case 'failed':
            return `Could not list the models ${catalog.connection} offers: ${catalog.message} These are suggestions; you can still type a model name.`;
    }
}

/** The connection an executor row selects, as far as the caller may see it: its id, name and provider. */
export interface ChipConnection {
    id: string;
    name: string;
    provider: ModelProvider;
}

/** A row's selected connection, or null when it selects none or the caller may not see which it is. */
export function chipConnectionOf(row: {
    providerConnectionId?: string | null;
    providerConnectionName?: string | null;
    providerConnectionProvider?: ModelProvider | null;
}): ChipConnection | null {
    const { providerConnectionId: id, providerConnectionName: name, providerConnectionProvider: provider } = row;
    return id && name && provider ? { id, name, provider } : null;
}
