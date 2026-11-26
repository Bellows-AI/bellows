import {
    credentialRedirectMessage,
    type DeploymentMode,
    missingProviderSecretMessage,
    STORED_CREDENTIAL_PREFIX,
} from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { faultySecrets, testSecretStore } from './env-secrets-harness.js';
import { lapseDeferral, mustCreate, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The claim's half of the redirect refusal: in cloud mode the check runs once on the EFFECTIVE
 * env — every member env scope, a reviewer's grant and the profile merged — so a base URL saved anywhere
 * without the member's own key never reaches a runner. The claim answers the refusal, carries no env and
 * deletes nothing. With a member key anywhere in the merged env the claim proceeds and the runner's config
 * carries the key resolved from the secret store; an unconfirmed read leaves the task queued.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const LEASE_SECONDS = 300;
const BASE_URL = 'ANTHROPIC_BASE_URL';
const URL = 'https://collector.example.test';
const KEY = 'sk-ant-api03-member-owned-key';
const REVIEWER: ReviewerSpec = { name: 'sec', instructions: 'Look.', timeoutMinutes: 7, connections: [BASE_URL] };

let sql: Sql;

function stores(orgId: string, deploymentMode: DeploymentMode, secrets: SecretStore = testSecretStore(sql)) {
    const executors = createUserExecutorStore({ sql, orgId, secrets, secretLog: () => {} });
    const env = createEnvVarStore({ sql, orgId, secrets, secretLog: () => {} });
    const jobs = createJobStore({
        sql,
        orgId,
        deploymentMode,
        env,
        executorConfig: executors,
        githubApp: true,
        plan: {
            readFor: async () => ({ config: null, error: null, services: [], revision: null, reviewers: [REVIEWER] }),
        },
    });
    return { executors, env, jobs };
}

function expectRefused(claim: Claim | null | undefined, key: string) {
    expect(claim?.executorRefusal).toBe(credentialRedirectMessage(key));
    expect(claim?.env).toBeUndefined();
    expect(JSON.stringify(claim)).not.toContain(URL);
}

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER] });

beforeAll(() => {
    if (enabled) sql = db.sql;
});

const task = (jobs: ReturnType<typeof stores>['jobs'], repo: string | null = null) =>
    mustCreate(jobs.create('echo hi', ALICE, { repo, executor: 'main', executorScope: 'user' }));

describe.skipIf(!enabled)('cloud mode: a redirect with no member key never reaches a claim', () => {
    it('(a) in the profile, for both executor types: refused, the profile kept', async () => {
        const { executors, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { env: { [BASE_URL]: URL } } }]);
        await task(jobs);
        expectRefused(await jobs.claim('w1', LEASE_SECONDS), BASE_URL);
        expect(await jobs.claim('w2', LEASE_SECONDS)).toBeNull();

        const provider = { provider: { anthropic: { options: { baseURL: URL } } } };
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: provider }]);
        await task(jobs);
        expectRefused(await jobs.claim('w3', LEASE_SECONDS), 'baseURL');
        expect((await executors.configFor(ALICE, 'main', 'user', sql))?.config).toEqual(provider);
    });

    it('(b) in a repo-scope env row: refused, the row kept', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceRepo('env-admin', 'acme', 'web', [{ name: BASE_URL, value: URL, isSecret: false }]);
        await task(jobs, 'acme/web');
        expectRefused(await jobs.claim('w1', LEASE_SECONDS), BASE_URL);
        expect(await env.listRepo('acme', 'web')).toEqual([expect.objectContaining({ name: BASE_URL })]);
    });

    it('(c) in a user env row: refused', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: {} }]);
        await env.replaceWorkspace(ALICE, [{ name: BASE_URL, value: URL, isSecret: true }]);
        await task(jobs);
        expectRefused(await jobs.claim('w1', LEASE_SECONDS), BASE_URL);
    });

    it('(d) granted to a reviewer: the review claim is refused', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        // The author claims on a model key; the org scope is then rewritten to the bare redirect, key gone.
        await env.replaceOrg('env-admin', [{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-author', isSecret: true }]);
        await task(jobs, 'acme/api');
        const caller = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(caller.executorRefusal).toBeNull();
        await env.replaceOrg('env-admin', [{ name: BASE_URL, value: URL, isSecret: false }]);

        const review = await jobs.requestReview(caller.id, caller.leaseToken, {
            key: 'sec-1',
            profile: 'sec',
            revision: 'h:1',
            ref: reviewRefOf(caller.id, 'sec-1'),
        });
        expect(review.result).toBe('created');
        expectRefused('claim' in review ? review.claim : undefined, BASE_URL);
    });
});

describe.skipIf(!enabled)('cloud mode: a member key anywhere in the merged env lets the redirect travel', () => {
    it('claude-code: the key stored in the profile, the base URL in a repo row', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [
            { name: 'main', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: KEY } } },
        ]);
        await env.replaceRepo('env-admin', 'acme', 'web', [{ name: BASE_URL, value: URL, isSecret: false }]);
        await task(jobs, 'acme/web');

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env?.[BASE_URL]).toBe(URL);
        expect(JSON.parse(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? '{}')).toEqual({ env: { ANTHROPIC_API_KEY: KEY } });
    });

    it('opencode: a provider baseURL beside its own apiKey travels with the key resolved', async () => {
        const { executors, jobs } = stores(ORG, 'cloud');
        const config = { provider: { anthropic: { options: { baseURL: URL, apiKey: KEY } } } };
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual(config);
        expect(JSON.stringify(claim)).not.toContain(STORED_CREDENTIAL_PREFIX);
    });
});

describe.skipIf(!enabled)('cloud mode: an OpenRouter key wired for Claude Code', () => {
    const OPENROUTER_KEY = 'sk-or-v1-member-owned';

    it('travels: the wiring carries the member key, so the redirect check accepts it', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceWorkspace(ALICE, [{ name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env).toMatchObject({
            [BASE_URL]: 'https://openrouter.ai/api',
            ANTHROPIC_AUTH_TOKEN: OPENROUTER_KEY,
            ANTHROPIC_API_KEY: '',
        });
    });

    it('a member ANTHROPIC_AUTH_TOKEN answers a member base URL; a base URL with neither key is still refused', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceWorkspace(ALICE, [
            { name: BASE_URL, value: URL, isSecret: false },
            { name: 'ANTHROPIC_AUTH_TOKEN', value: KEY, isSecret: true },
        ]);
        await task(jobs);
        const bearer = await jobs.claim('w1', LEASE_SECONDS);
        expect(bearer?.executorRefusal).toBeNull();
        expect(bearer?.env).toMatchObject({ [BASE_URL]: URL, ANTHROPIC_AUTH_TOKEN: KEY });

        await env.replaceWorkspace(ALICE, [
            { name: BASE_URL, value: URL, isSecret: false },
            { name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true },
        ]);
        await task(jobs);
        expectRefused(await jobs.claim('w2', LEASE_SECONDS), BASE_URL);
    });
});

/**
 * The driver forwards its own ANTHROPIC_API_KEY (RUNNER_ENV) unless the claim names it, and the claim's
 * name wins even when empty. In cloud mode, beside a member's base URL with no member ANTHROPIC_API_KEY,
 * the claim carries it blank: the deployment's key never follows a member's redirect. A self-hosted board
 * keeps it, so an operator's proxy URL in org env can still use the key in RUNNER_ENV.
 */
describe.skipIf(!enabled)('a member redirect never carries the platform Anthropic key in cloud mode', () => {
    it('cloud: a bearer redirect in member env claims ANTHROPIC_API_KEY blank', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceWorkspace(ALICE, [
            { name: BASE_URL, value: URL, isSecret: false },
            { name: 'ANTHROPIC_AUTH_TOKEN', value: KEY, isSecret: true },
        ]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env).toMatchObject({ [BASE_URL]: URL, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_API_KEY: '' });
    });

    it("cloud: a bearer redirect in a claude-code profile's env claims ANTHROPIC_API_KEY blank", async () => {
        const { executors, jobs } = stores(ORG, 'cloud');
        const config = { env: { [BASE_URL]: URL, ANTHROPIC_AUTH_TOKEN: KEY } };
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env?.ANTHROPIC_API_KEY).toBe('');
        expect(JSON.parse(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? '{}')).toEqual(config);
    });

    it('self-hosted: a member redirect, in env or a profile, leaves the platform key alone', async () => {
        const { executors, env, jobs } = stores(ORG, 'self-hosted');
        const config = { env: { ANTHROPIC_AUTH_TOKEN: KEY } };
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config }]);
        await env.replaceOrg('env-admin', [{ name: BASE_URL, value: URL, isSecret: false }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env?.[BASE_URL]).toBe(URL);
        expect(claim?.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    });

    it('a member ANTHROPIC_API_KEY beside the redirect travels as is', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceWorkspace(ALICE, [
            { name: BASE_URL, value: URL, isSecret: false },
            { name: 'ANTHROPIC_API_KEY', value: KEY, isSecret: true },
        ]);
        await task(jobs);

        expect((await jobs.claim('w1', LEASE_SECONDS))?.env?.ANTHROPIC_API_KEY).toBe(KEY);
    });
});

describe.skipIf(!enabled)('a stored credential the claim cannot confirm', () => {
    it('rolls the claim back and leaves the task queued, never sending the profile without its key', async () => {
        const store = testSecretStore(sql);
        const { executors } = stores(ORG, 'self-hosted', store);
        await executors.replace(ALICE, [
            { name: 'main', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: KEY } } },
        ]);
        const down = faultySecrets(store, {
            readActive: async () => {
                throw new Error('store down');
            },
        });
        const { jobs } = stores(ORG, 'self-hosted', down);
        const { id } = await task(jobs);

        await expect(jobs.claim('w1', LEASE_SECONDS)).rejects.toThrow();
        expect(await jobs.get(id)).toMatchObject({ status: 'queued', attempts: 0 });
        await lapseDeferral(sql, id);
        const claim = await stores(ORG, 'self-hosted', store).jobs.claim('w2', LEASE_SECONDS);
        expect(JSON.parse(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? '{}')).toEqual({ env: { ANTHROPIC_API_KEY: KEY } });
    });
});

describe.skipIf(!enabled)('self-hosted mode: a redirect still travels', () => {
    it('reaches the claim through the profile', async () => {
        const { executors, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { env: { [BASE_URL]: URL } } }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(JSON.parse(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? '{}')).toEqual({ env: { [BASE_URL]: URL } });
    });
});

describe.skipIf(!enabled)('Claude Code takes its model credentials from one scope', () => {
    const TEAM_KEY = 'sk-ant-org-owned';
    const OPENROUTER_KEY = 'sk-or-v1-member-owned';

    it('a personal OpenRouter key over an org Anthropic key: the wiring runs, the org key stays behind', async () => {
        const { executors, env, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceOrg('env-admin', [{ name: 'ANTHROPIC_API_KEY', value: TEAM_KEY, isSecret: true }]);
        await env.replaceWorkspace(ALICE, [{ name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env).toMatchObject({
            [BASE_URL]: 'https://openrouter.ai/api',
            ANTHROPIC_AUTH_TOKEN: OPENROUTER_KEY,
            ANTHROPIC_API_KEY: '',
        });
        expect(JSON.stringify(claim)).not.toContain(TEAM_KEY);
    });

    it('an org Anthropic key with nothing personal travels unchanged', async () => {
        const { executors, env, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceOrg('env-admin', [{ name: 'ANTHROPIC_API_KEY', value: TEAM_KEY, isSecret: true }]);
        await env.replaceWorkspace(ALICE, [{ name: 'OTHER', value: 'x', isSecret: false }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.env).toMatchObject({ ANTHROPIC_API_KEY: TEAM_KEY, OTHER: 'x' });
        expect(claim?.env).not.toHaveProperty(BASE_URL);
    });

    it('another provider’s key in a repo neither owns nor drops the org Anthropic key', async () => {
        const { executors, env, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceOrg('env-admin', [{ name: 'ANTHROPIC_API_KEY', value: TEAM_KEY, isSecret: true }]);
        await env.replaceRepo('env-admin', 'acme', 'web', [{ name: 'OPENAI_API_KEY', value: 'repo', isSecret: true }]);
        await task(jobs, 'acme/web');

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.env).toMatchObject({ ANTHROPIC_API_KEY: TEAM_KEY, OPENAI_API_KEY: 'repo' });
    });

    it('an OpenCode run stacks plainly: the org and the personal keys both travel', async () => {
        const { executors, env, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: {} }]);
        await env.replaceOrg('env-admin', [{ name: 'ANTHROPIC_API_KEY', value: TEAM_KEY, isSecret: true }]);
        await env.replaceWorkspace(ALICE, [{ name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.env).toMatchObject({ ANTHROPIC_API_KEY: TEAM_KEY, OPENROUTER_API_KEY: OPENROUTER_KEY });
    });

    it('a repo-scope key overrides the workspace provider', async () => {
        const { executors, env, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceWorkspace(ALICE, [{ name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true }]);
        await env.replaceRepo('env-admin', 'acme', 'web', [
            { name: 'ANTHROPIC_API_KEY', value: 'repo', isSecret: true },
        ]);
        await task(jobs, 'acme/web');

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.env).toMatchObject({ ANTHROPIC_API_KEY: 'repo' });
        expect(claim?.env).not.toHaveProperty('OPENROUTER_API_KEY');
        expect(claim?.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    });
});

/**
 * A custom provider key that names a secret instead of carrying one : exactly `{env:NAME}`
 * beside a `baseURL`. The claim resolves it from the scopes it already merged — the env that travels,
 * a reviewer's grant applied — and writes the value into the rendered provider config, so a raw
 * `{env:…}` never reaches the runner (opencode would substitute it from an environment that also
 * holds the deployment's credential). A name no scope holds fails the task before the agent starts,
 * naming the secret; the deployment key is never a source, in either mode.
 */
describe.skipIf(!enabled)('a custom provider key that names a secret resolves at claim', () => {
    const gateway = (apiKey: string) => ({
        provider: {
            'vllm-internal': {
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL: 'https://vllm.internal/v1', apiKey },
                models: { 'llama-3': {} },
            },
        },
        model: 'vllm-internal/llama-3',
    });
    const GATEWAY_KEY = 'GATEWAY_KEY';
    const endpoint = (claim: Claim | null | undefined) =>
        JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? 'null') as {
            provider: { 'vllm-internal': { options: { apiKey: string } } };
        } | null;
    /** The resolved key the rendered provider block carries, asserted so a null config names itself. */
    const gatewayKey = (claim: Claim | null | undefined, want: string) => {
        const options = endpoint(claim)?.provider['vllm-internal']?.options;
        expect(options?.apiKey).toBe(want);
    };

    it('an org secret value is written into the rendered provider config, never the raw reference', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: gateway(`{env:${GATEWAY_KEY}}`) }]);
        await env.replaceOrg('env-admin', [{ name: GATEWAY_KEY, value: 'sk-org-gateway', isSecret: true }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        const options = endpoint(claim)?.provider['vllm-internal']?.options;
        expect(options).toEqual({ baseURL: 'https://vllm.internal/v1', apiKey: 'sk-org-gateway' });
        expect(JSON.stringify(claim)).not.toContain('{env:');
    });

    it('the higher scope wins the name: workspace over organization, repository over workspace', async () => {
        const { executors, env, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: gateway(`{env:${GATEWAY_KEY}}`) }]);
        await env.replaceOrg('env-admin', [{ name: GATEWAY_KEY, value: 'org-value', isSecret: false }]);
        await task(jobs);
        gatewayKey(await jobs.claim('w1', LEASE_SECONDS), 'org-value');

        await env.replaceWorkspace(ALICE, [{ name: GATEWAY_KEY, value: 'member-value', isSecret: false }]);
        await task(jobs);
        gatewayKey(await jobs.claim('w2', LEASE_SECONDS), 'member-value');

        await env.replaceRepo('env-admin', 'acme', 'web', [
            { name: GATEWAY_KEY, value: 'repo-value', isSecret: false },
        ]);
        await task(jobs, 'acme/web');
        gatewayKey(await jobs.claim('w3', LEASE_SECONDS), 'repo-value');
    });

    it('rotating the org secret applies to the next claim with no profile edit', async () => {
        const { executors, env, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: gateway(`{env:${GATEWAY_KEY}}`) }]);
        await env.replaceOrg('env-admin', [{ name: GATEWAY_KEY, value: 'first-value', isSecret: true }]);
        await task(jobs);
        gatewayKey(await jobs.claim('w1', LEASE_SECONDS), 'first-value');

        await env.replaceOrg('env-admin', [{ name: GATEWAY_KEY, value: 'rotated-value', isSecret: true }]);
        await task(jobs);
        gatewayKey(await jobs.claim('w2', LEASE_SECONDS), 'rotated-value');
    });

    it('a name no scope holds fails the task before the agent starts, naming the secret — the deployment key included', async () => {
        const { executors, jobs } = stores(ORG, 'cloud');
        // ANTHROPIC_API_KEY is the deployment's own key name: it resolves only from a member scope,
        // and none is set, so the runner env must never answer for it.
        await executors.replace(ALICE, [
            { name: 'main', type: 'opencode', config: gateway('{env:ANTHROPIC_API_KEY}') },
        ]);
        await task(jobs);
        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBe(missingProviderSecretMessage(['ANTHROPIC_API_KEY']));
        expect(claim?.env).toBeUndefined();
        expect(await jobs.claim('w2', LEASE_SECONDS)).toBeNull();

        // An empty value is just as unresolved.
        const { executors: executors2, env, jobs: jobs2 } = stores(ORG, 'self-hosted');
        await executors2.replace(ALICE, [{ name: 'main', type: 'opencode', config: gateway(`{env:${GATEWAY_KEY}}`) }]);
        await env.replaceWorkspace(ALICE, [{ name: GATEWAY_KEY, value: '', isSecret: false }]);
        await task(jobs2);
        const refused = await jobs2.claim('w1', LEASE_SECONDS);
        expect(refused?.executorRefusal).toBe(missingProviderSecretMessage([GATEWAY_KEY]));
    });

    it('a reviewer claim resolves only past its grant: an ungranted name is refused, a granted one travels', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: gateway(`{env:${GATEWAY_KEY}}`) }]);
        await env.replaceOrg('env-admin', [{ name: GATEWAY_KEY, value: 'sk-org-gateway', isSecret: true }]);
        await env.replaceWorkspace(ALICE, [{ name: 'ANTHROPIC_API_KEY', value: KEY, isSecret: true }]);
        await task(jobs, 'acme/api');
        const caller = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(caller.executorRefusal).toBeNull();

        const review = await jobs.requestReview(caller.id, caller.leaseToken, {
            key: 'sec-1',
            profile: 'sec',
            revision: 'h:1',
            ref: reviewRefOf(caller.id, 'sec-1'),
        });
        expect(review.result).toBe('created');
        // The grant names the redirect key only: the reference cannot resolve past it, so the
        // review claim fails before the agent starts rather than carrying the value anyway.
        const reviewer = 'claim' in review ? review.claim : undefined;
        expect(reviewer?.executorRefusal).toBe(missingProviderSecretMessage([GATEWAY_KEY]));
        expect(reviewer?.env).toBeUndefined();
    });

    it("a reference on a provider without a baseURL is opencode's own substitution and travels untouched", async () => {
        const { executors, env, jobs } = stores(ORG, 'self-hosted');
        const builtin = { provider: { anthropic: { options: { apiKey: '{env:MY_KEY}' } } }, model: 'anthropic/sonnet' };
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: builtin }]);
        await env.replaceWorkspace(ALICE, [{ name: 'MY_KEY', value: 'sk-member', isSecret: false }]);
        await task(jobs);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual(builtin);
    });
});
