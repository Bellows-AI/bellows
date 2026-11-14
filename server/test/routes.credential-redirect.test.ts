import { ERROR_CODES, type DeploymentMode } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import {
    githubAuth,
    harness,
    memoryAuthStore,
    memoryEnvVarStore,
    memoryUserExecutorStore,
    signedIn,
} from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_CREATED, HTTP_OK, trackApps } from './helpers-http.js';

/**
 * Offline: in cloud mode a setting that redirects where the deployment's model credential is sent —
 * `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, or an opencode provider `baseURL` — is refused at save
 * unless the same list carries the member's own key, on the personal executor PUT, the organization
 * executor CRUD and every env scope. The claim's half, on the merged env, is
 * server/test-db/job-store.credential-redirect.test.ts.
 */

const track = trackApps();
const URL = 'https://collector.example.test';
const KEY = 'sk-ant-api03-member-owned-key';

async function boot(deploymentMode: DeploymentMode) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const executors = memoryUserExecutorStore();
    const envVars = memoryEnvVarStore();
    const h = await harness({
        auth,
        userExecutors: executors,
        envVars,
        repos: [{ owner: 'acme', name: 'web' }],
        config: { auth: githubAuth(), deploymentMode },
    });
    track(h.app);
    const cookie = await signedIn(auth, admin);
    const send = (method: 'POST' | 'PUT', url: string, payload: unknown) =>
        h.app.inject({ method, url, headers: { cookie }, payload: payload as Record<string, unknown> });
    return { send, executors, envVars };
}

const CLAUDE_REDIRECT = { env: { ANTHROPIC_BASE_URL: URL } };
const CLAUDE_OWN_KEY = { env: { ANTHROPIC_BASE_URL: URL, ANTHROPIC_API_KEY: KEY } };
const OPENCODE_REDIRECT = { provider: { anthropic: { options: { baseURL: URL } } } };
const personal = (config: Record<string, unknown>, type = 'claude-code') => ({
    executors: [{ name: 'mine', type, config }],
});
const org = (config: Record<string, unknown>, type = 'claude-code') => ({ name: 'team', type, config });
const vars = (...entries: [string, string][]) => ({
    vars: entries.map(([name, value]) => ({ name, value, isSecret: true })),
});
const repoVars = (...entries: [string, string][]) => ({ repo: { owner: 'acme', name: 'web' }, ...vars(...entries) });

function expectRefused(response: { statusCode: number; body: string; json: () => { code: string } }, key: string) {
    expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(response.json().code).toBe(ERROR_CODES.CREDENTIAL_REDIRECT_REFUSED);
    expect(response.body).toContain(key);
    expect(response.body).not.toContain(URL);
}

describe('cloud mode: executor settings refuse a redirect of the platform credential', () => {
    it('the personal PUT refuses a claude-code base URL and an opencode provider baseURL, storing nothing', async () => {
        const { send, executors } = await boot('cloud');
        expectRefused(await send('PUT', '/api/workspace/executors', personal(CLAUDE_REDIRECT)), 'ANTHROPIC_BASE_URL');
        expectRefused(
            await send('PUT', '/api/workspace/executors', personal(OPENCODE_REDIRECT, 'opencode')),
            'baseURL'
        );
        expect(executors.rows()).toEqual([]);
    });

    it('the org create and update refuse it', async () => {
        const { send } = await boot('cloud');
        expectRefused(await send('POST', '/api/org/executors', org(OPENCODE_REDIRECT, 'opencode')), 'baseURL');
        const created = await send('POST', '/api/org/executors', org({ model: 'sonnet' }));
        expect(created.statusCode).toBe(HTTP_CREATED);
        expectRefused(
            await send('PUT', `/api/org/executors/${created.json().id}`, org(CLAUDE_REDIRECT)),
            'ANTHROPIC_BASE_URL'
        );
    });

    it('accepts a redirect that carries the member key', async () => {
        const { send } = await boot('cloud');
        expect((await send('PUT', '/api/workspace/executors', personal(CLAUDE_OWN_KEY))).statusCode).toBe(HTTP_OK);
    });
});

describe('cloud mode: env scopes refuse a redirect with no member key', () => {
    it('refuses it at org, workspace and repo scope', async () => {
        const { send, envVars } = await boot('cloud');
        expectRefused(await send('PUT', '/api/env/org', vars(['ANTHROPIC_BASE_URL', URL])), 'ANTHROPIC_BASE_URL');
        expectRefused(await send('PUT', '/api/env/workspace', vars(['OPENAI_BASE_URL', URL])), 'OPENAI_BASE_URL');
        expectRefused(await send('PUT', '/api/env/repo', repoVars(['ANTHROPIC_BASE_URL', URL])), 'ANTHROPIC_BASE_URL');
        expect(await envVars.listOrg()).toEqual([]);
    });

    it('accepts the redirect beside the member key, a kept secret key included', async () => {
        const { send } = await boot('cloud');
        const both = vars(['ANTHROPIC_BASE_URL', URL], ['ANTHROPIC_API_KEY', KEY]);
        expect((await send('PUT', '/api/env/org', both)).statusCode).toBe(HTTP_OK);
        const kept = {
            vars: [
                { name: 'ANTHROPIC_BASE_URL', value: URL, isSecret: false },
                { name: 'ANTHROPIC_API_KEY', value: null, isSecret: true },
            ],
        };
        expect((await send('PUT', '/api/env/org', kept)).statusCode).toBe(HTTP_OK);
    });
});

describe('self-hosted mode keeps accepting a redirect', () => {
    it('in executor settings and in every env scope', async () => {
        const { send } = await boot('self-hosted');
        expect((await send('PUT', '/api/workspace/executors', personal(CLAUDE_REDIRECT))).statusCode).toBe(HTTP_OK);
        expect((await send('POST', '/api/org/executors', org(OPENCODE_REDIRECT, 'opencode'))).statusCode).toBe(
            HTTP_CREATED
        );
        expect((await send('PUT', '/api/env/org', vars(['ANTHROPIC_BASE_URL', URL]))).statusCode).toBe(HTTP_OK);
        expect((await send('PUT', '/api/env/workspace', vars(['ANTHROPIC_BASE_URL', URL]))).statusCode).toBe(HTTP_OK);
        expect((await send('PUT', '/api/env/repo', repoVars(['ANTHROPIC_BASE_URL', URL]))).statusCode).toBe(HTTP_OK);
    });
});
