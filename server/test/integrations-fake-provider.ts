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
