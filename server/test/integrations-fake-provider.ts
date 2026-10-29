import type { ExchangeResult, OAuthProviderHooks } from '../src/integrations/oauth-provider.js';
import {
    type ConnectionHandle,
    type CredentialSource,
    defineIntegration,
    type FetchLike,
    type IntegrationOperation,
} from '@factory-ai/core';

/** The portable part of the fake provider: a definition, one read and one write operation. */
export const FAKE_TOKEN = 'fake-access-token';

export const fakeDefinition = defineIntegration({
    id: 'fake',
    kind: 'connection',
    capabilities: { read: ['fake:read'], write: ['fake:write'] },
    api: { origin: (resource) => `https://${resource.id}.fake.test`, pathPrefix: '/rest' },
    skills: ['fake'],
});

export const fakeReadItem: IntegrationOperation<string> = {
    name: 'readItem',
    effect: 'read',
    requiredScopes: ['fake:read'],
    request: (id) => ({ method: 'GET', path: `/rest/items/${id}` }),
};

export const fakeHandle = (scopes: readonly string[] = ['fake:read']): ConnectionHandle => ({
    connectionId: 'conn-1',
    provider: 'fake',
    resource: { id: 'acme', label: 'Acme' },
    authority: { scopes },
});

export const fakeCredentials = (scopes: readonly string[] = ['fake:read']): CredentialSource => ({
    acquire: async () => ({
        ok: true,
        credential: { accessToken: FAKE_TOKEN, expiresAt: null, authority: { scopes } },
    }),
});

export const fakeFetch = (
    json: unknown
): FetchLike & { calls: { url: string; authorization: string | undefined }[] } => {
    const calls: { url: string; authorization: string | undefined }[] = [];
    const fn: FetchLike = async (url, init) => {
        calls.push({ url, authorization: init.headers.authorization });
        const chunks = [new TextEncoder().encode(JSON.stringify(json))];
        return {
            status: 200,
            headers: { get: () => null },
            body: {
                getReader: () => ({
                    read: async () => {
                        const value = chunks.shift();
                        return value ? { done: false, value } : { done: true };
                    },
                    cancel: async () => {},
                }),
            },
        };
    };
    return Object.assign(fn, { calls });
};

type Answer = 'ok' | 'invalid_grant' | 'hang';

export interface ParkedExchange {
    /** Resolves once the fake has consumed the request: the point after which the provider has accepted it. */
    accepted: Promise<void>;
    release(answer?: Answer): void;
}

export interface FakeOAuth {
    hooks: OAuthProviderHooks;
    /** Refresh requests the fake accepted, i.e. exchanges the provider saw. */
    refreshCalls: number;
    rotates: boolean;
    revoked: string[];
    /** The refresh token the provider will honour next. A rotating provider spends it on every exchange. */
    currentRefreshToken: string;
    /** The authority the next refresh grants. */
    nextAuthority: { scopes: string[] };
    /** Parks the NEXT refresh after the provider accepted it, until `release`. */
    parkNext(): ParkedExchange;
    answerNext(answer: Answer): void;
    /** The tokens the Nth accepted refresh issued. */
    issued: { accessToken: string; refreshToken: string | null }[];
}

/** The OAuth half of the fake provider: deferred gates, counters, a rotation toggle and a revoke list. */
export function createFakeOAuth(
    options: { rotates?: boolean; revokeScope?: 'token' | 'grant' | 'none'; initialRefreshToken?: string } = {}
): FakeOAuth {
    const rotates = options.rotates ?? false;
    const fake: FakeOAuth = {
        rotates,
        refreshCalls: 0,
        revoked: [],
        currentRefreshToken: options.initialRefreshToken ?? 'refresh-0',
        nextAuthority: { scopes: ['fake:read'] },
        issued: [],
        hooks: undefined as never,
        parkNext: () => {
            throw new Error('replaced below');
        },
        answerNext: () => {
            throw new Error('replaced below');
        },
    };
    let parked: { accepted: () => void; gate: Promise<Answer> } | null = null;
    let next: Answer = 'ok';
    fake.parkNext = () => {
        let accept!: () => void;
        let release!: (answer: Answer) => void;
        const accepted = new Promise<void>((resolve) => {
            accept = resolve;
        });
        const gate = new Promise<Answer>((resolve) => {
            release = resolve;
        });
        parked = { accepted: accept, gate };
        return { accepted, release: (answer = 'ok') => release(answer) };
    };
    fake.answerNext = (answer) => {
        next = answer;
    };
    const refresh: OAuthProviderHooks['refresh'] = async ({ refreshToken, signal }) => {
        if (signal.aborted) return { ok: false, failure: 'not-sent' };
        fake.refreshCalls += 1;
        const mine = parked;
        parked = null;
        let answer: Answer = next;
        next = 'ok';
        if (mine) {
            mine.accepted();
            const aborted = new Promise<'aborted'>((resolve) =>
                signal.addEventListener('abort', () => resolve('aborted'), { once: true })
            );
            const outcome = await Promise.race([mine.gate, aborted]);
            if (outcome === 'aborted') return { ok: false, failure: 'ambiguous' };
            answer = outcome;
        }
        if (answer === 'hang') {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
            return { ok: false, failure: 'ambiguous' };
        }
        if (answer === 'invalid_grant' || refreshToken !== fake.currentRefreshToken) {
            return { ok: false, failure: 'definitive' };
        }
        const n = fake.refreshCalls;
        const issuedRefresh = rotates ? `refresh-${n}` : fake.currentRefreshToken;
        fake.currentRefreshToken = issuedRefresh;
        const tokens = { accessToken: `access-${n}`, refreshToken: issuedRefresh };
        fake.issued.push(tokens);
        const result: ExchangeResult = {
            ok: true,
            tokens: {
                ...tokens,
                expiresAt: Date.now() + 3_600_000,
                authority: { scopes: [...fake.nextAuthority.scopes] },
            },
        };
        return result;
    };
    fake.hooks = {
        id: 'fake',
        supportsPkce: true,
        rotatesRefreshToken: rotates,
        revokeScope: options.revokeScope ?? 'none',
        authorizeUrl: ({ state }) => `https://fake.test/authorize?state=${state}`,
        exchangeCode: async () => ({ ok: false, failure: 'not-sent' }),
        refresh,
        revoke: async ({ token }) => {
            fake.revoked.push(token);
            return 'revoked';
        },
        discoverIdentity: async () => null,
    };
    return fake;
}
