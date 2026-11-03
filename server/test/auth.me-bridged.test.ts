import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { bridgedRequestClass } from '../src/auth/bridge-binding.js';
import {
    githubAuth,
    memoryAuthStore,
    staticRegistry,
    stubTelemetryClient,
    telemetryStoreStub,
    testConfig,
} from './helpers.js';
import { HTTP_OK, trackApps } from './helpers-http.js';

const track = trackApps();

async function boot() {
    const store = memoryAuthStore();
    const config = testConfig({ auth: githubAuth() });
    const app = track(
        await buildApp({
            config,
            orgs: staticRegistry({ config, telemetry: stubTelemetryClient() }),
            store: telemetryStoreStub(),
            auth: store,
        })
    );
    return { app, store };
}

describe('GET /api/auth/me for a bridged caller', () => {
    it('answers the bound account, org and scopes, not {authenticated:false}', async () => {
        const { app, store } = await boot();
        const caller = { ...store.seedMember('test-org', 'octocat', 'admin'), scopes: ['factory:read' as const] };
        const response = await app.inject({
            method: 'GET',
            url: '/api/auth/me',
            Request: bridgedRequestClass(caller),
        });
        expect(response.statusCode).toBe(HTTP_OK);
        const body = response.json();
        expect(body.authenticated).toBe(true);
        expect(body.user.login).toBe('octocat');
        expect(body.organization.id).toBe('test-org');
        expect(body.scopes).toEqual(['factory:read']);
    });

    it('a network request still gets {authenticated:false} and carries no scopes', async () => {
        const { app } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/auth/me' });
        expect(response.json()).toEqual({ authenticated: false });
    });
});
