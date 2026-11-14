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
 * Offline: in cloud mode (`DEPLOYMENT_MODE=cloud`) a Claude subscription OAuth token is refused
 * at every settings entry point — the personal executor PUT, the organization executor CRUD and
 * the three env scopes — with one code and a body that never carries the value. Self-hosted keeps
 * accepting it; an API key passes in both modes. The claim's half is
 * server/test-db/job-store.cloud-credentials.test.ts.
 */

const track = trackApps();
const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const VALUE = 'sk-ant-oat01-do-not-echo-this-value';
const NESTED = { model: 'sonnet', env: { [TOKEN]: VALUE } };
const DEEP = { model: 'sonnet', provider: { extra: [{ env: { [TOKEN]: VALUE } }] } };
const API_KEY = { model: 'sonnet', env: { ANTHROPIC_API_KEY: VALUE } };

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

const personal = (config: Record<string, unknown>) => ({
    executors: [{ name: 'mine', type: 'claude-code', config }],
});
const org = (config: Record<string, unknown>) => ({ name: 'team', type: 'claude-code', config });
const vars = (name: string) => ({ vars: [{ name, value: VALUE, isSecret: true }] });

function expectRefused(response: { statusCode: number; body: string; json: () => { code: string } }) {
    expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
    expect(response.json().code).toBe(ERROR_CODES.CLOUD_CREDENTIAL_REFUSED);
    expect(response.body).not.toContain(VALUE);
    expect(response.body).toContain('ANTHROPIC_API_KEY');
}

describe('cloud mode: executor settings refuse the OAuth token', () => {
    it('the personal PUT refuses it nested in env and at depth, and stores nothing', async () => {
        const { send, executors } = await boot('cloud');
        expectRefused(await send('PUT', '/api/workspace/executors', personal(NESTED)));
        expectRefused(await send('PUT', '/api/workspace/executors', personal(DEEP)));
        expect(executors.rows()).toEqual([]);
    });

    it('the org create and update refuse it', async () => {
        const { send, executors } = await boot('cloud');
        expectRefused(await send('POST', '/api/org/executors', org(NESTED)));
        const created = await send('POST', '/api/org/executors', org(API_KEY));
        expect(created.statusCode).toBe(HTTP_CREATED);
        expectRefused(await send('PUT', `/api/org/executors/${created.json().id}`, org(DEEP)));
        expect(executors.rows()).toEqual([expect.objectContaining({ name: 'team', config: API_KEY })]);
    });

    it('an API key is accepted on the personal PUT', async () => {
        const { send } = await boot('cloud');
        expect((await send('PUT', '/api/workspace/executors', personal(API_KEY))).statusCode).toBe(HTTP_OK);
    });
});

describe('cloud mode: env scopes refuse the OAuth token name', () => {
    it('refuses it at org, workspace and repo scope', async () => {
        const { send, envVars } = await boot('cloud');
        expectRefused(await send('PUT', '/api/env/org', vars(TOKEN)));
        expectRefused(await send('PUT', '/api/env/workspace', vars(TOKEN)));
        expectRefused(await send('PUT', '/api/env/repo', { repo: { owner: 'acme', name: 'web' }, ...vars(TOKEN) }));
        expect(await envVars.listOrg()).toEqual([]);
    });

    it('accepts an API key', async () => {
        const { send } = await boot('cloud');
        expect((await send('PUT', '/api/env/org', vars('ANTHROPIC_API_KEY'))).statusCode).toBe(HTTP_OK);
    });
});

describe('self-hosted mode keeps accepting the OAuth token', () => {
    it('in executor settings and in every env scope', async () => {
        const { send } = await boot('self-hosted');
        expect((await send('PUT', '/api/workspace/executors', personal(NESTED))).statusCode).toBe(HTTP_OK);
        expect((await send('POST', '/api/org/executors', org(DEEP))).statusCode).toBe(HTTP_CREATED);
        expect((await send('PUT', '/api/env/org', vars(TOKEN))).statusCode).toBe(HTTP_OK);
        expect((await send('PUT', '/api/env/workspace', vars(TOKEN))).statusCode).toBe(HTTP_OK);
        const repo = { repo: { owner: 'acme', name: 'web' }, ...vars(TOKEN) };
        expect((await send('PUT', '/api/env/repo', repo)).statusCode).toBe(HTTP_OK);
    });
});
