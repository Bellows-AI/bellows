import { describe, expect, it } from 'vitest';
import type { OAuthClient, OAuthStore } from '../src/auth/oauth-store.js';
import { CimdFetchError, type CimdFetcher } from '../src/oauth/cimd-fetch.js';
import { CIMD_TTL_MS, createClientResolver } from '../src/oauth/client-resolver.js';

const ID = 'https://client.example.test/oauth/client.json';
const DOC = {
    client_id: ID,
    client_name: 'Doc client',
    redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
};

const rig = (stored: OAuthClient | null, fetcher: CimdFetcher, now = () => 1_000_000_000) => {
    const rows = new Map<string, OAuthClient>(stored ? [[stored.clientId, stored]] : []);
    const oauth = {
        findClient: async (id: string) => rows.get(id) ?? null,
        upsertClient: async (input: {
            clientId: string;
            kind: 'cimd';
            name: string | null;
            redirectUris: string[];
            fetchedAt: Date;
            metadata: Record<string, unknown>;
        }) => {
            rows.set(input.clientId, { ...input, metadata: input.metadata ?? null, fetchedAt: input.fetchedAt });
        },
    } as unknown as OAuthStore;
    const warnings: unknown[] = [];
    return {
        rows,
        warnings,
        resolve: createClientResolver({ oauth, fetcher, now, log: { warn: (o) => void warnings.push(o) } }),
    };
};
const cached = (ageMs: number, now = 1_000_000_000): OAuthClient => ({
    clientId: ID,
    kind: 'cimd',
    name: 'Old name',
    redirectUris: ['http://localhost/old'],
    metadata: null,
    fetchedAt: new Date(now - ageMs),
});
const failing =
    (code: ConstructorParameters<typeof CimdFetchError>[0]): CimdFetcher =>
    async () => {
        throw new CimdFetchError(code, 'boom');
    };

describe('the client resolver', () => {
    it('fetches an unknown URL client id once, stores it as cimd, and serves it from the store while fresh', async () => {
        let fetches = 0;
        const { resolve, rows } = rig(null, async () => {
            fetches += 1;
            return DOC;
        });
        const client = await resolve(ID);
        expect(client).toMatchObject({
            clientId: ID,
            kind: 'cimd',
            name: 'Doc client',
            redirectUris: DOC.redirect_uris,
        });
        expect(rows.get(ID)?.fetchedAt).toBeInstanceOf(Date);
        await resolve(ID);
        expect(fetches).toBe(1);
    });

    it('refetches after the TTL and takes the new document', async () => {
        const { resolve } = rig(cached(CIMD_TTL_MS + 1), async () => DOC);
        expect((await resolve(ID))?.redirectUris).toEqual(DOC.redirect_uris);
    });

    it.each(['timeout', 'network', 'address', 'busy', 'rate_limited', 'status', 'aborted'] as const)(
        'keeps a cached client, stale, when the refetch fails with %s',
        async (code) => {
            const old = cached(CIMD_TTL_MS + 1);
            const { resolve, rows, warnings } = rig(old, failing(code));
            expect(await resolve(ID)).toEqual(old);
            expect(rows.get(ID)).toEqual(old);
            expect(warnings).toHaveLength(1);
        }
    );

    it('leaves an unknown client unknown when the first fetch fails', async () => {
        const { resolve, rows } = rig(null, failing('timeout'));
        expect(await resolve(ID)).toBeNull();
        expect(rows.size).toBe(0);
    });

    it.each([
        ['a client_id that is not the URL', { ...DOC, client_id: 'https://other.example.test/c.json' }],
        ['a missing client_id', { client_name: 'x', redirect_uris: DOC.redirect_uris }],
        ['a secret method', { ...DOC, token_endpoint_auth_method: 'client_secret_post' }],
        ['a bad redirect', { ...DOC, redirect_uris: ['http://client.example.test/cb'] }],
        ['no redirects', { client_id: ID }],
    ])('does not cache a document with %s, and keeps a cached client', async (_name, document) => {
        const fresh = rig(null, async () => document);
        expect(await fresh.resolve(ID)).toBeNull();
        expect(fresh.rows.size).toBe(0);
        const old = cached(CIMD_TTL_MS + 1);
        const kept = rig(old, async () => document);
        expect(await kept.resolve(ID)).toEqual(old);
    });

    it('never fetches for a client id that is not a URL, and never refetches a DCR row', async () => {
        const fetcher: CimdFetcher = async () => {
            throw new Error('must not fetch');
        };
        const dcr: OAuthClient = {
            clientId: 'dcr_abc',
            kind: 'dcr',
            name: null,
            redirectUris: [],
            metadata: null,
            fetchedAt: null,
        };
        const { resolve } = rig(dcr, fetcher);
        expect(await resolve('dcr_abc')).toEqual(dcr);
        expect(await resolve('unknown')).toBeNull();
    });

    it('passes the caller signal to the fetch, and lets a store failure through as unconfirmed', async () => {
        const signal = new AbortController().signal;
        let seen: AbortSignal | undefined;
        const { resolve } = rig(null, async (_url, s) => {
            seen = s;
            return DOC;
        });
        await resolve(ID, signal);
        expect(seen).toBe(signal);
        const broken = createClientResolver({
            oauth: {
                findClient: async () => {
                    throw new Error('db down');
                },
            } as unknown as OAuthStore,
            fetcher: async () => DOC,
        });
        await expect(broken(ID)).rejects.toThrow('db down');
    });
});
