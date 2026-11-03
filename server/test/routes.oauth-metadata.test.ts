import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { OAuthStore } from '../src/auth/oauth-store.js';
import type { AppConfig } from '../src/config.js';
import {
    githubAuth,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { HTTP_NOT_FOUND, HTTP_OK, HTTP_UNAUTHORIZED, trackApps } from './helpers-http.js';

const track = trackApps();
const PUBLIC_URL = 'https://board.example.test';
const RESOURCE = `${PUBLIC_URL}/api/mcp`;
const NEVER_CALLED = {} as OAuthStore;

const board = async (overrides: Partial<AppConfig> = {}) => {
    const config = testConfig({
        auth: githubAuth({ publicUrl: PUBLIC_URL }),
        mcp: { enabled: true, resource: RESOURCE, trustedOrigins: [] },
        ...overrides,
    });
    return track(
        await buildApp({
            config,
            orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
            store: telemetryStoreStub(),
            auth: memoryAuthStore(),
            oauth: NEVER_CALLED,
        })
    );
};
const get = async (app: Awaited<ReturnType<typeof board>>, url: string) => app.inject({ method: 'GET', url });

describe('OAuth discovery metadata', () => {
    it.each(['/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-protected-resource'])(
        'publishes the protected resource at %s with no credential',
        async (path) => {
            const response = await get(await board(), path);
            expect(response.statusCode).toBe(HTTP_OK);
            expect(response.json()).toEqual({
                resource: RESOURCE,
                authorization_servers: [PUBLIC_URL],
                scopes_supported: ['factory:read', 'factory:write'],
                bearer_methods_supported: ['header'],
            });
        }
    );

    it('publishes the authorization server: S256 only, public clients, iss, the endpoints under the public origin', async () => {
        const response = await get(await board(), '/.well-known/oauth-authorization-server');
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({
            issuer: PUBLIC_URL,
            authorization_endpoint: `${PUBLIC_URL}/api/oauth/authorize`,
            token_endpoint: `${PUBLIC_URL}/api/oauth/token`,
            revocation_endpoint: `${PUBLIC_URL}/api/oauth/revoke`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            revocation_endpoint_auth_methods_supported: ['none'],
            scopes_supported: ['factory:read', 'factory:write'],
            authorization_response_iss_parameter_supported: true,
        });
    });

    it('is where the 401 challenge of /api/mcp points', async () => {
        const app = await board();
        const challenge = await app.inject({
            method: 'POST',
            url: '/api/mcp',
            payload: {},
            headers: { host: new URL(PUBLIC_URL).host },
        });
        expect(challenge.statusCode).toBe(HTTP_UNAUTHORIZED);
        const metadata = /resource_metadata="([^"]+)"/.exec(String(challenge.headers['www-authenticate']))?.[1] ?? '';
        expect((await get(app, new URL(metadata).pathname)).statusCode).toBe(HTTP_OK);
    });

    it.each([
        ['MCP is off', { mcp: { enabled: false } } as Partial<AppConfig>],
        ['AUTH_MODE=none', { auth: { mode: 'none' } } as Partial<AppConfig>],
    ])('publishes nothing when %s, and no OAuth route answers', async (_name, overrides) => {
        const app = await board(overrides);
        for (const url of [
            '/.well-known/oauth-protected-resource',
            '/.well-known/oauth-protected-resource/api/mcp',
            '/.well-known/oauth-authorization-server',
            '/api/oauth/authorize?client_id=x',
        ]) {
            expect((await get(app, url)).statusCode, url).toBe(HTTP_NOT_FOUND);
        }
        for (const url of ['/api/oauth/token', '/api/oauth/revoke']) {
            expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode, url).toBe(HTTP_NOT_FOUND);
        }
    });

    it('is not answered by the SPA fallback when the board serves a web root', async () => {
        const root = mkdtempSync(join(tmpdir(), 'webroot-'));
        writeFileSync(join(root, 'index.html'), '<!doctype html><title>spa</title>');
        const app = await board({ mcp: { enabled: false }, webRoot: root });
        const response = await get(app, '/.well-known/oauth-authorization-server');
        expect(response.statusCode).toBe(HTTP_NOT_FOUND);
        expect(response.headers['content-type']).toContain('application/json');
    });
});
