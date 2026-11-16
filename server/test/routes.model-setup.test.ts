import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import {
    githubAuth,
    memoryAuthStore,
    memoryEnvVarStore,
    memoryUserExecutorStore,
    signedIn,
    staticRegistry,
    testConfig,
} from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_FORBIDDEN, HTTP_OK, HTTP_SERVICE_UNAVAILABLE, trackApps } from './helpers-http.js';
import { storeOutage } from './helpers-outage.js';

/**
 * Offline: the HTTP contract of `GET` / `PUT /api/model-setup` against the in-memory env and executor store doubles.
 * The transaction (a failed secret write leaves the agent default unwritten, and the reverse) is covered by
 * server/test-db/model-setup.store.test.ts.
 */
const track = trackApps();

const ANTHROPIC_KEY = 'sk-ant-test-value';
const OPENROUTER_KEY = 'sk-or-test-value';

async function boot(overrides: Partial<AppConfig> = {}) {
    const auth = memoryAuthStore();
    const admin = auth.seedMember('test-org', 'admin-cat', 'admin');
    const member = auth.seedMember('test-org', 'octocat');
    const envVars = memoryEnvVarStore();
    const executors = memoryUserExecutorStore();
    const config = testConfig({ auth: githubAuth(), ...overrides });
    const app = await buildApp({ config, orgs: staticRegistry({ config, envVars, userExecutors: executors }), auth });
    track(app);
    return {
        app,
        envVars,
        executors,
        member,
        adminCookie: await signedIn(auth, admin),
        memberCookie: await signedIn(auth, member),
    };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const get = (b: Booted, cookie: string) =>
    b.app.inject({ method: 'GET', url: '/api/model-setup', headers: { cookie } });
const put = (b: Booted, cookie: string, payload: object) =>
    b.app.inject({ method: 'PUT', url: '/api/model-setup', headers: { cookie }, payload });

const anthropicPersonal = {
    scope: 'personal',
    provider: 'anthropic',
    key: ANTHROPIC_KEY,
    agentType: 'claude-code',
    model: 'claude-sonnet-4-5',
};

describe('GET /api/model-setup', () => {
    it('answers nothing configured on a fresh board', async () => {
        const b = await boot();
        const response = await get(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(response.json()).toEqual({ platform: false, org: null, personal: null, effective: null });
    });

    it('shows a saved personal setup by names only, the personal scope effective', async () => {
        const b = await boot();
        expect((await put(b, b.memberCookie, anthropicPersonal)).statusCode).toBe(HTTP_OK);

        const response = await get(b, b.memberCookie);
        expect(response.json()).toEqual({
            platform: false,
            org: null,
            personal: {
                provider: 'anthropic',
                agentType: 'claude-code',
                model: 'claude-sonnet-4-5',
                keyNames: ['ANTHROPIC_API_KEY'],
            },
            effective: 'personal',
        });
        expect(response.body).not.toContain(ANTHROPIC_KEY);
    });

    it('infers the provider from the names of a scope saved outside the model setup', async () => {
        const b = await boot();
        await b.envVars.replaceOrg('env-admin', [
            { name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true },
        ]);
        expect((await get(b, b.memberCookie)).json()).toEqual({
            platform: false,
            org: { provider: 'openrouter', agentType: null, model: null, keyNames: ['OPENROUTER_API_KEY'] },
            personal: null,
            effective: 'org',
        });
    });

    it('reports the platform model, effective while no scope holds a key', async () => {
        const b = await boot({ platformModelProvided: true });
        expect((await get(b, b.memberCookie)).json()).toEqual({
            platform: true,
            org: null,
            personal: null,
            effective: 'platform',
        });
        await put(b, b.memberCookie, anthropicPersonal);
        expect((await get(b, b.memberCookie)).json()).toMatchObject({ platform: true, effective: 'personal' });
    });

    it('is a 503, never "nothing configured", when the env read fails', async () => {
        const b = await boot({ platformModelProvided: true });
        b.envVars.listWorkspace = async () => {
            throw storeOutage();
        };
        const response = await get(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json()).not.toHaveProperty('effective');
    });

    it('is a 503 when the agent default read fails', async () => {
        const b = await boot();
        b.executors.agentDefaults = async () => {
            throw storeOutage();
        };
        const response = await get(b, b.memberCookie);
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json()).not.toHaveProperty('effective');
    });
});

describe('PUT /api/model-setup with a key', () => {
    it('refuses a member writing the org scope with 403 and writes nothing', async () => {
        const b = await boot();
        const response = await put(b, b.memberCookie, { ...anthropicPersonal, scope: 'org' });
        expect(response.statusCode).toBe(HTTP_FORBIDDEN);
        expect(b.envVars.rows()).toEqual([]);
        expect(await b.executors.agentDefaults(b.member.user.id)).toEqual({ org: null, personal: null });
    });

    it('lets an admin write the org scope', async () => {
        const b = await boot();
        expect((await put(b, b.adminCookie, { ...anthropicPersonal, scope: 'org' })).statusCode).toBe(HTTP_OK);
        expect((await get(b, b.memberCookie)).json()).toMatchObject({
            org: { provider: 'anthropic', keyNames: ['ANTHROPIC_API_KEY'] },
            effective: 'org',
        });
    });

    it('stores the key as a secret and answers no value', async () => {
        const b = await boot();
        const response = await put(b, b.memberCookie, anthropicPersonal);
        expect(response.body).not.toContain(ANTHROPIC_KEY);
        expect(b.envVars.rows()).toEqual([
            {
                userId: b.member.user.id,
                owner: null,
                repoName: null,
                name: 'ANTHROPIC_API_KEY',
                value: ANTHROPIC_KEY,
                isSecret: true,
            },
        ]);
    });

    it('refuses an agent the provider does not run', async () => {
        const b = await boot();
        const response = await put(b, b.memberCookie, {
            scope: 'personal',
            provider: 'openai',
            key: 'sk-openai',
            agentType: 'claude-code',
            model: 'gpt-5',
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(b.envVars.rows()).toEqual([]);
    });

    it('runs Claude Code on an OpenRouter key, the model kept as given', async () => {
        const b = await boot();
        const response = await put(b, b.memberCookie, {
            scope: 'personal',
            provider: 'openrouter',
            key: OPENROUTER_KEY,
            agentType: 'claude-code',
            model: 'anthropic/claude-sonnet-4.5',
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect((await b.executors.agentDefaults(b.member.user.id)).personal).toEqual({
            agentType: 'claude-code',
            model: 'anthropic/claude-sonnet-4.5',
            provider: 'openrouter',
        });
    });

    it('prefixes an OpenCode model with its provider', async () => {
        const b = await boot();
        await put(b, b.memberCookie, {
            scope: 'personal',
            provider: 'openrouter',
            key: OPENROUTER_KEY,
            agentType: 'opencode',
            model: 'anthropic/claude-sonnet-4.5',
        });
        expect((await b.executors.agentDefaults(b.member.user.id)).personal?.model).toBe(
            'openrouter/anthropic/claude-sonnet-4.5'
        );
    });

    it('refuses a subscription token in cloud with CLOUD_CREDENTIAL_REFUSED', async () => {
        const b = await boot({ deploymentMode: 'cloud' });
        const response = await put(b, b.memberCookie, {
            scope: 'personal',
            provider: 'subscription',
            key: 'sk-ant-oat-test',
            agentType: 'claude-code',
            model: 'claude-sonnet-4-5',
        });
        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
        expect(response.json().code).toBe('CLOUD_CREDENTIAL_REFUSED');
        expect(b.envVars.rows()).toEqual([]);
    });

    it('refuses LiteLLM without a base URL, and stores the base URL as plain text with one', async () => {
        const b = await boot();
        const litellm = {
            scope: 'personal',
            provider: 'litellm',
            key: 'sk-litellm',
            agentType: 'claude-code',
            model: 'claude-sonnet-4-5',
        };
        expect((await put(b, b.memberCookie, litellm)).statusCode).toBe(HTTP_BAD_REQUEST);
        expect(b.envVars.rows()).toEqual([]);

        const saved = await put(b, b.memberCookie, { ...litellm, baseUrl: 'https://llm.example.test' });
        expect(saved.statusCode).toBe(HTTP_OK);
        expect(b.envVars.rows().map(({ name, value, isSecret }) => ({ name, value, isSecret }))).toEqual([
            { name: 'ANTHROPIC_API_KEY', value: 'sk-litellm', isSecret: true },
            { name: 'ANTHROPIC_BASE_URL', value: 'https://llm.example.test', isSecret: false },
        ]);
        expect((await get(b, b.memberCookie)).json().personal.provider).toBe('litellm');
    });

    it('a provider switch removes the old provider’s key and base URL in that scope only', async () => {
        const b = await boot();
        await b.envVars.replaceOrg('env-admin', [{ name: 'ANTHROPIC_API_KEY', value: 'org-key', isSecret: true }]);
        await put(b, b.memberCookie, { ...anthropicPersonal, baseUrl: 'https://proxy.example.test' });
        await b.envVars.writeScoped(
            { kind: 'workspace', userId: b.member.user.id },
            { upsert: [{ name: 'UNRELATED', value: 'kept', isSecret: false }], remove: [] },
            b.member.user.id
        );

        const switched = await put(b, b.memberCookie, {
            scope: 'personal',
            provider: 'openrouter',
            key: OPENROUTER_KEY,
            agentType: 'opencode',
            model: 'openai/gpt-5',
        });

        expect(switched.statusCode).toBe(HTTP_OK);
        const names = (userId: string | null) =>
            b.envVars
                .rows()
                .filter((row) => row.userId === userId)
                .map((row) => row.name)
                .sort();
        expect(names(b.member.user.id)).toEqual(['OPENROUTER_API_KEY', 'UNRELATED']);
        expect(names(null)).toEqual(['ANTHROPIC_API_KEY']);
        expect((await get(b, b.memberCookie)).json().personal).toEqual({
            provider: 'openrouter',
            agentType: 'opencode',
            model: 'openrouter/openai/gpt-5',
            keyNames: ['OPENROUTER_API_KEY'],
        });
    });

    it('a failing write answers 503 and leaves the agent default unwritten', async () => {
        const b = await boot();
        b.envVars.broken = true;
        const response = await put(b, b.memberCookie, anthropicPersonal);
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect((await b.executors.agentDefaults(b.member.user.id)).personal).toBeNull();
    });
});

describe('PUT /api/model-setup without a key', () => {
    const platform = { scope: 'personal', provider: 'platform', agentType: 'claude-code', model: 'claude-sonnet-4-5' };

    it('with the platform model on, writes only the agent default', async () => {
        const b = await boot({ platformModelProvided: true });
        const response = await put(b, b.memberCookie, platform);
        expect(response.statusCode).toBe(HTTP_OK);
        expect(b.envVars.rows()).toEqual([]);
        expect((await b.executors.agentDefaults(b.member.user.id)).personal).toEqual({
            agentType: 'claude-code',
            model: 'claude-sonnet-4-5',
            provider: 'platform',
        });
        expect((await get(b, b.memberCookie)).json()).toMatchObject({
            personal: { provider: 'platform', keyNames: [] },
            effective: 'platform',
        });
    });

    it('refuses the platform provider when the deployment supplies no model', async () => {
        const b = await boot();
        expect((await put(b, b.memberCookie, platform)).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await b.executors.agentDefaults(b.member.user.id)).personal).toBeNull();
    });

    it('refuses a key or a base URL beside the platform provider', async () => {
        const b = await boot({ platformModelProvided: true });
        expect((await put(b, b.memberCookie, { ...platform, key: 'sk-x' })).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await put(b, b.memberCookie, { ...platform, baseUrl: 'https://x.example.test' })).statusCode).toBe(
            HTTP_BAD_REQUEST
        );
        expect((await b.executors.agentDefaults(b.member.user.id)).personal).toBeNull();
    });

    it('saves only the agent default on the org’s existing key, with the platform model off', async () => {
        const b = await boot();
        await b.envVars.replaceOrg('env-admin', [
            { name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true },
        ]);
        const before = b.envVars.rows();
        const response = await put(b, b.memberCookie, {
            scope: 'personal',
            provider: 'existing',
            agentType: 'opencode',
            model: 'anthropic/claude-sonnet-4.5',
        });
        expect(response.statusCode).toBe(HTTP_OK);
        expect(b.envVars.rows()).toEqual(before);
        expect((await b.executors.agentDefaults(b.member.user.id)).personal).toEqual({
            agentType: 'opencode',
            model: 'openrouter/anthropic/claude-sonnet-4.5',
        });
    });

    it('refuses the existing-key save with no key in view, an agent the key cannot run, or the platform model on', async () => {
        const none = await boot();
        const existing = { scope: 'personal', provider: 'existing', agentType: 'opencode', model: 'gpt-5' };
        expect((await put(none, none.memberCookie, existing)).statusCode).toBe(HTTP_BAD_REQUEST);

        const b = await boot();
        await b.envVars.replaceOrg('env-admin', [{ name: 'OPENAI_API_KEY', value: 'sk-openai', isSecret: true }]);
        expect((await put(b, b.memberCookie, { ...existing, agentType: 'claude-code' })).statusCode).toBe(
            HTTP_BAD_REQUEST
        );
        // The org's key is not in the org scope's view of a personal key; only the member's own is.
        await b.envVars.replaceWorkspace(b.member.user.id, [{ name: 'OPENAI_API_KEY', value: 'mine', isSecret: true }]);
        const orgScope = { ...existing, scope: 'org' };
        await b.envVars.replaceOrg('env-admin', []);
        expect((await put(b, b.adminCookie, orgScope)).statusCode).toBe(HTTP_BAD_REQUEST);

        const flagged = await boot({ platformModelProvided: true });
        await flagged.envVars.replaceOrg('env-admin', [{ name: 'OPENAI_API_KEY', value: 'k', isSecret: true }]);
        expect((await put(flagged, flagged.memberCookie, existing)).statusCode).toBe(HTTP_BAD_REQUEST);
        expect((await flagged.executors.agentDefaults(flagged.member.user.id)).personal).toBeNull();
    });

    it('refuses the existing-key save with 503 when the names cannot be read', async () => {
        const b = await boot();
        b.envVars.listOrg = async () => {
            throw storeOutage();
        };
        const response = await put(b, b.memberCookie, {
            scope: 'personal',
            provider: 'existing',
            agentType: 'opencode',
            model: 'gpt-5',
        });
        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect((await b.executors.agentDefaults(b.member.user.id)).personal).toBeNull();
    });
});

describe('/api/auth/me platformModel', () => {
    it('reports whether the deployment supplies the model', async () => {
        for (const platformModelProvided of [false, true]) {
            const b = await boot({ platformModelProvided });
            const me = await b.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: b.memberCookie } });
            expect(me.json()).toMatchObject({ platformModel: platformModelProvided });
        }
    });
});
