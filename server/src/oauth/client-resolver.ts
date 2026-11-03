import type { OAuthClient, OAuthStore } from '../auth/oauth-store.js';
import { CimdFetchError, type CimdFetcher } from './cimd-fetch.js';
import { parseClientMetadata } from './client-metadata.js';

/** How long a fetched client metadata document is trusted before the next use refetches it. */
const MINUTES = 60;
const MS_PER_MINUTE = 60_000;
export const CIMD_TTL_MS = MINUTES * MS_PER_MINUTE;

interface Log {
    warn(object: Record<string, unknown>, message: string): void;
}

const isClientIdUrl = (clientId: string): boolean => /^https?:\/\//i.test(clientId);

/** Fetches and vets the document of a URL client id; a CimdFetchError says why it could not be confirmed. */
const fetchClient = async (
    clientId: string,
    fetcher: CimdFetcher,
    signal: AbortSignal | undefined,
    fetchedAt: Date
): Promise<OAuthClient> => {
    const document = (await fetcher(clientId, signal)) as Record<string, unknown>;
    const parsed = parseClientMetadata(document);
    if (document.client_id !== clientId)
        throw new CimdFetchError('malformed', 'The document client_id is not its URL.');
    if (!parsed.ok) throw new CimdFetchError('malformed', parsed.description);
    return {
        clientId,
        kind: 'cimd',
        name: parsed.name,
        redirectUris: parsed.redirectUris,
        metadata: parsed.metadata,
        fetchedAt,
    };
};

/**
 * Resolves a client id to a client for the authorize endpoint. A URL client id is a Client ID Metadata Document:
 * served from `oauth_client` while fresh, fetched otherwise. A fetch that fails, times out or returns a bad document
 * never deletes or replaces a cached client (it stays, stale, and is tried again on the next use); with no cached
 * client the id is simply unknown. A store failure throws: the answer could not be confirmed.
 */
export const createClientResolver =
    ({
        oauth,
        fetcher,
        ttlMs = CIMD_TTL_MS,
        now = Date.now,
        log,
    }: {
        oauth: OAuthStore;
        fetcher: CimdFetcher;
        ttlMs?: number;
        now?: () => number;
        log?: Log;
    }) =>
    async (clientId: string, signal?: AbortSignal): Promise<OAuthClient | null> => {
        const stored = await oauth.findClient(clientId);
        if (!isClientIdUrl(clientId) || (stored && stored.kind !== 'cimd')) return stored;
        if (stored?.fetchedAt && now() - stored.fetchedAt.getTime() < ttlMs) return stored;
        try {
            const client = await fetchClient(clientId, fetcher, signal, new Date(now()));
            const { name, redirectUris, metadata, fetchedAt } = client;
            await oauth.upsertClient({
                clientId,
                kind: 'cimd',
                name,
                redirectUris,
                metadata: metadata ?? {},
                ...(fetchedAt ? { fetchedAt } : {}),
            });
            return client;
        } catch (e) {
            if (!(e instanceof CimdFetchError)) throw e;
            log?.warn({ clientId, reason: e.code }, 'client metadata could not be confirmed');
            return stored;
        }
    };
