import type { DiscoveredIdentity, ExchangeResult, OAuthProviderHooks } from '../src/integrations/oauth-provider.js';
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
    /** Authorization-code exchanges the fake accepted, and the identity lookups it answered. */
    exchangeCalls: number;
    discoverCalls: number;
    /** What the last accepted code exchange carried. */
    lastExchange: { code: string; codeVerifier: string | undefined; redirectUri: string } | null;
    /** Every authorize URL the board asked the fake to build. */
    authorizeCalls: { state: string; codeChallenge: string | undefined; redirectUri: string; scopes: string[] }[];
    /** Who the next identity lookup says the tokens belong to; null makes the lookup find nobody. */
    identity: DiscoveredIdentity | null;
    /** Parks the NEXT code exchange / identity lookup after the fake accepted it, until `release`. */
    parkExchange(): ParkedExchange;
    parkDiscover(): ParkedExchange;
    answerExchange(answer: Answer): void;
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
        exchangeCalls: 0,
        discoverCalls: 0,
        lastExchange: null,
        authorizeCalls: [],
        identity: {
            externalAccountId: 'acct-fake',
            resources: [{ id: 'acme', label: 'acme.fake.test' }],
            authority: { scopes: ['fake:read'] },
        },
        hooks: undefined as never,
        parkExchange: () => {
            throw new Error('replaced below');
        },
        parkDiscover: () => {
            throw new Error('replaced below');
        },
        answerExchange: () => {
            throw new Error('replaced below');
        },
        parkNext: () => {
            throw new Error('replaced below');
        },
        answerNext: () => {
            throw new Error('replaced below');
        },
    };
    const codeRefreshTokens = new Set<string>();
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
    const gates = () => {
        let parked: { accepted: () => void; gate: Promise<Answer> } | null = null;
        return {
            park: (): ParkedExchange => {
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
            },
            /** Waits at the parked gate (if any); resolves 'aborted' when the signal fires first. */
            wait: async (signal: AbortSignal): Promise<Answer | 'aborted'> => {
                const mine = parked;
                parked = null;
                if (!mine) return 'ok';
                mine.accepted();
                const aborted = new Promise<'aborted'>((resolve) =>
                    signal.addEventListener('abort', () => resolve('aborted'), { once: true })
                );
                return Promise.race([mine.gate, aborted]);
            },
        };
    };
    const exchangeGate = gates();
    const discoverGate = gates();
    let nextExchange: Answer = 'ok';
    fake.parkExchange = exchangeGate.park;
    fake.parkDiscover = discoverGate.park;
    fake.answerExchange = (answer) => {
        nextExchange = answer;
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
        if (
            answer === 'invalid_grant' ||
            (refreshToken !== fake.currentRefreshToken && !codeRefreshTokens.has(refreshToken))
        ) {
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
        authorizeUrl: ({ state, codeChallenge, redirectUri, scopes }) => {
            fake.authorizeCalls.push({ state, codeChallenge, redirectUri, scopes: [...scopes] });
            const challenge = codeChallenge ? `&code_challenge=${codeChallenge}&code_challenge_method=S256` : '';
            return `https://fake.test/authorize?state=${state}${challenge}`;
        },
        exchangeCode: async ({ code, codeVerifier, redirectUri, signal }) => {
            if (signal.aborted) return { ok: false, failure: 'not-sent' };
            fake.exchangeCalls += 1;
            fake.lastExchange = { code, codeVerifier, redirectUri };
            const waited = await exchangeGate.wait(signal);
            if (waited === 'aborted') return { ok: false, failure: 'ambiguous' };
            const answer = waited === 'ok' ? nextExchange : waited;
            nextExchange = 'ok';
            if (answer === 'hang') {
                await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
                return { ok: false, failure: 'ambiguous' };
            }
            if (answer === 'invalid_grant') return { ok: false, failure: 'definitive' };
            const n = fake.exchangeCalls;
            const refreshToken = `code-refresh-${n}`;
            codeRefreshTokens.add(refreshToken);
            return {
                ok: true,
                tokens: {
                    accessToken: `code-access-${n}`,
                    refreshToken,
                    expiresAt: Date.now() + 3_600_000,
                    authority: fake.identity ? { scopes: [...fake.identity.authority.scopes] } : { scopes: [] },
                },
            };
        },
        refresh,
        revoke: async ({ token }) => {
            fake.revoked.push(token);
            return 'revoked';
        },
        discoverIdentity: async ({ signal }) => {
            fake.discoverCalls += 1;
            const waited = await discoverGate.wait(signal);
            if (waited === 'aborted') return null;
            return fake.identity;
        },
    };
    return fake;
}
