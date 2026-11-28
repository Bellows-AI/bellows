import {
    CLOUD_CREDENTIAL_MESSAGE,
    credentialRedirectMessage,
    type DeploymentMode,
    NO_MODEL_MESSAGE,
    STORED_CREDENTIAL_PREFIX,
} from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretDeps, testSecretStore } from './env-secrets-harness.js';
import { mustCreate, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The claim's half of the cloud OAuth-token refusal: the check runs on the EFFECTIVE env — the
 * stacked member env with the executor profile merged over it — so a token saved before cloud
 * mode, in a profile or in any env scope, and one granted to a reviewer, never reaches a runner.
 * The claim answers the refusal (the driver fails the task with it before anything spawns), carries
 * no env at all, and deletes nothing. Self-hosted claims carry the token as before.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const LEASE_SECONDS = 300;
const TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN';
const VALUE = 'sk-ant-oat01-stored-before-cloud';
const REVIEWER: ReviewerSpec = { name: 'sec', instructions: 'Look.', timeoutMinutes: 7, connections: [TOKEN] };

let sql: Sql;

function stores(
    orgId: string,
    deploymentMode: DeploymentMode,
    reviewer: ReviewerSpec = REVIEWER,
    { cloudSubscriptionOrgIds = new Set<string>() }: { cloudSubscriptionOrgIds?: ReadonlySet<string> } = {}
) {
    const executors = createUserExecutorStore({ sql, orgId, ...testSecretDeps(sql) });
    const env = createEnvVarStore({ sql, orgId, secrets: testSecretStore(sql), secretLog: () => {} });
    const jobs = createJobStore({
        sql,
        orgId,
        deploymentMode,
        cloudSubscriptionOrgIds,
        env,
        executorConfig: executors,
        githubApp: true,
        plan: {
            readFor: async () => ({ config: null, error: null, services: [], revision: null, reviewers: [reviewer] }),
        },
    });
    return { executors, env, jobs };
}

function expectRefused(claim: Claim | null | undefined) {
    expect(claim?.executorRefusal).toBe(CLOUD_CREDENTIAL_MESSAGE);
    expect(claim?.env).toBeUndefined();
    expect(JSON.stringify(claim)).not.toContain(VALUE);
}

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER] });

beforeAll(() => {
    if (enabled) sql = db.sql;
});

describe.skipIf(!enabled)('cloud mode: a stored OAuth token never reaches a claim', () => {
    it('(a) in an executor profile: refused, the profile kept', async () => {
        const { executors, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { env: { [TOKEN]: VALUE } } }]);
        await mustCreate(jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        expectRefused(await jobs.claim('w1', LEASE_SECONDS));
        // Leased to the driver that fails it, never handed out again; the saved profile is untouched.
        expect(await jobs.claim('w2', LEASE_SECONDS)).toBeNull();
        // Kept in the secret store: the profile holds its marker, the store the value.
        const stored = (await executors.configFor(ALICE, 'main', 'user', sql))?.config as {
            env: Record<string, string>;
        };
        expect(stored.env[TOKEN]).toMatch(new RegExp(`^${STORED_CREDENTIAL_PREFIX}`));
        expect((await executors.claimConfigFor(ALICE, 'main', 'user', sql))?.config).toEqual({
            env: { [TOKEN]: VALUE },
        });
    });

    it('(b) in a repo-scope env row: refused, the row kept', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceRepo('env-admin', 'acme', 'web', [{ name: TOKEN, value: VALUE, isSecret: false }]);
        await mustCreate(jobs.create('echo hi', ALICE, { repo: 'acme/web', executor: 'main', executorScope: 'user' }));

        expectRefused(await jobs.claim('w1', LEASE_SECONDS));
        expect(await env.listRepo('acme', 'web')).toEqual([expect.objectContaining({ name: TOKEN })]);
    });

    it('(c) granted to a reviewer: the review claim is refused', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        // A model key in the profile, so the author's claim and the reviewer's run on it and only the token refuses.
        const config = { env: { ANTHROPIC_API_KEY: 'sk-ant-profile' } };
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config }]);
        await mustCreate(jobs.create('ship it', ALICE, { repo: 'acme/api', executor: 'main', executorScope: 'user' }));
        const caller = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(caller.executorRefusal).toBeNull();
        // Stored after the author's claim, as a token saved before cloud mode would sit there.
        await env.replaceOrg('env-admin', [{ name: TOKEN, value: VALUE, isSecret: false }]);

        const review = await jobs.requestReview(caller.id, caller.leaseToken, {
            key: 'sec-1',
            profile: 'sec',
            revision: 'h:1',
            ref: reviewRefOf(caller.id, 'sec-1'),
        });
        expect(review.result).toBe('created');
        expectRefused('claim' in review ? review.claim : undefined);
    });
});

describe.skipIf(!enabled)('self-hosted mode: the stored OAuth token still travels', () => {
    it('reaches the claim through the profile', async () => {
        const { executors, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { env: { [TOKEN]: VALUE } } }]);
        await mustCreate(jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(JSON.parse(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? '{}')).toEqual({ env: { [TOKEN]: VALUE } });
    });
});

describe.skipIf(!enabled)('a reviewer granted only an OpenRouter key', () => {
    const OPENROUTER_KEY = 'sk-or-v1-member-owned';
    const OPENROUTER_REVIEWER: ReviewerSpec = { ...REVIEWER, connections: ['OPENROUTER_API_KEY'] };

    it('is wired from the env that travels, not from the author env it was granted out of', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud', OPENROUTER_REVIEWER);
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceOrg('env-admin', [
            { name: 'OPENROUTER_API_KEY', value: OPENROUTER_KEY, isSecret: true },
            { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-author-only', isSecret: true },
        ]);
        await mustCreate(jobs.create('ship it', ALICE, { repo: 'acme/api', executor: 'main', executorScope: 'user' }));
        const caller = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(caller.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');

        const review = await jobs.requestReview(caller.id, caller.leaseToken, {
            key: 'sec-1',
            profile: 'sec',
            revision: 'h:1',
            ref: reviewRefOf(caller.id, 'sec-1'),
        });
        const claim = 'claim' in review ? review.claim : undefined;
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env).toMatchObject({
            OPENROUTER_API_KEY: OPENROUTER_KEY,
            ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
            ANTHROPIC_AUTH_TOKEN: OPENROUTER_KEY,
            ANTHROPIC_API_KEY: '',
        });
        expect(JSON.stringify(claim)).not.toContain('sk-ant-author-only');
    });

    it('a granted bearer redirect without the granted Anthropic key claims the platform key blank', async () => {
        const bearerReviewer: ReviewerSpec = {
            ...REVIEWER,
            connections: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
        };
        const { executors, env, jobs } = stores(ORG, 'cloud', bearerReviewer);
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceOrg('env-admin', [
            { name: 'ANTHROPIC_BASE_URL', value: 'https://gateway.example.test', isSecret: false },
            { name: 'ANTHROPIC_AUTH_TOKEN', value: 'member-bearer', isSecret: true },
            { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-author-only', isSecret: true },
        ]);
        await mustCreate(jobs.create('ship it', ALICE, { repo: 'acme/api', executor: 'main', executorScope: 'user' }));
        const caller = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(caller.env?.ANTHROPIC_API_KEY).toBe('sk-ant-author-only');

        const review = await jobs.requestReview(caller.id, caller.leaseToken, {
            key: 'sec-1',
            profile: 'sec',
            revision: 'h:1',
            ref: reviewRefOf(caller.id, 'sec-1'),
        });
        const claim = 'claim' in review ? review.claim : undefined;
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'member-bearer', ANTHROPIC_API_KEY: '' });
    });
});

describe.skipIf(!enabled)('cloud mode, an org the operator lists: a stored OAuth token claims', () => {
    const exempt = () => stores(ORG, 'cloud', REVIEWER, { cloudSubscriptionOrgIds: new Set([ORG]) });

    it('in an executor profile: claims with the token, with no model key beside it', async () => {
        const { executors, jobs } = exempt();
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { env: { [TOKEN]: VALUE } } }]);
        await mustCreate(jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(JSON.stringify(claim)).toContain(VALUE);
    });

    it('in a repo-scope env row: claims with the token in the env', async () => {
        const { executors, env, jobs } = exempt();
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceRepo('env-admin', 'acme', 'web', [{ name: TOKEN, value: VALUE, isSecret: false }]);
        await mustCreate(jobs.create('echo hi', ALICE, { repo: 'acme/web', executor: 'main', executorScope: 'user' }));

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env?.[TOKEN]).toBe(VALUE);
    });

    it('granted to a reviewer: the review claim carries it', async () => {
        const { executors, env, jobs } = exempt();
        const config = { env: { ANTHROPIC_API_KEY: 'sk-ant-profile' } };
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config }]);
        await env.replaceOrg('env-admin', [{ name: TOKEN, value: VALUE, isSecret: false }]);
        await mustCreate(jobs.create('ship it', ALICE, { repo: 'acme/api', executor: 'main', executorScope: 'user' }));
        const caller = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(caller.executorRefusal).toBeNull();

        const review = await jobs.requestReview(caller.id, caller.leaseToken, {
            key: 'sec-1',
            profile: 'sec',
            revision: 'h:1',
            ref: reviewRefOf(caller.id, 'sec-1'),
        });
        const claim = 'claim' in review ? review.claim : undefined;
        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env?.[TOKEN]).toBe(VALUE);
    });

    it('only the listed org: a token is refused when another org is listed', async () => {
        const { executors, jobs } = stores(ORG, 'cloud', REVIEWER, {
            cloudSubscriptionOrgIds: new Set(['other-org']),
        });
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { env: { [TOKEN]: VALUE } } }]);
        await mustCreate(jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        expectRefused(await jobs.claim('w1', LEASE_SECONDS));
    });

    it('a redirect of the deployment credential is still refused', async () => {
        const { executors, jobs } = exempt();
        const config = { env: { [TOKEN]: VALUE, ANTHROPIC_BASE_URL: 'https://gateway.example.test' } };
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config }]);
        await mustCreate(jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBe(credentialRedirectMessage('ANTHROPIC_BASE_URL'));
        expect(claim?.env).toBeUndefined();
    });
});

describe.skipIf(!enabled)('cloud mode: a claim with no model credential is refused (NO_MODEL)', () => {
    it('a key deleted between create and claim fails the task with the fix, sending no env', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceWorkspace(ALICE, [{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-member', isSecret: true }]);
        await mustCreate(jobs.create('echo hi', ALICE, { repo: 'acme/web', executor: 'main', executorScope: 'user' }));
        await env.replaceWorkspace(ALICE, [{ name: 'DEPLOY_REGION', value: 'eu', isSecret: false }]);

        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.executorRefusal).toBe(NO_MODEL_MESSAGE);
        expect(claim?.env).toBeUndefined();
        // Leased to the driver that fails it, never handed out again.
        expect(await jobs.claim('w2', LEASE_SECONDS)).toBeNull();
    });

    it('a key in the executor profile, or an OpenRouter key for Claude Code, claims', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [
            { name: 'keyed', type: 'opencode', config: { provider: { openai: { options: { apiKey: 'sk-oai' } } } } },
            { name: 'plain', type: 'claude-code', config: {} },
        ]);
        await mustCreate(jobs.create('one', ALICE, { repo: 'acme/web', executor: 'keyed', executorScope: 'user' }));
        expect((await jobs.claim('w1', LEASE_SECONDS))?.executorRefusal).toBeNull();

        await env.replaceWorkspace(ALICE, [{ name: 'OPENROUTER_API_KEY', value: 'sk-or', isSecret: true }]);
        await mustCreate(jobs.create('two', ALICE, { repo: 'acme/web', executor: 'plain', executorScope: 'user' }));
        expect((await jobs.claim('w2', LEASE_SECONDS))?.executorRefusal).toBeNull();
    });

    it('a key the run will not have is not counted: a profile env clearing it, a non-key option, a missing `{env:}`', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await env.replaceWorkspace(ALICE, [{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-member', isSecret: true }]);
        const opencode = (options: Record<string, unknown>) => ({ provider: { custom: { options } } });
        await executors.replace(ALICE, [
            { name: 'cleared', type: 'claude-code', config: { env: { ANTHROPIC_API_KEY: '' } } },
            { name: 'password', type: 'opencode', config: { model: 'm', ...opencode({ password: 'p' }) } },
            { name: 'missing', type: 'opencode', config: opencode({ apiKey: '{env:MISSING_KEY}' }) },
        ]);
        for (const executor of ['cleared', 'password', 'missing']) {
            // OpenCode reads no Anthropic key off a profile: the member's key only travels for Claude Code here.
            if (executor !== 'cleared') await env.replaceWorkspace(ALICE, []);
            await mustCreate(jobs.create(executor, ALICE, { repo: 'acme/web', executor, executorScope: 'user' }));
            const claim = await jobs.claim(`w-${executor}`, LEASE_SECONDS);
            expect(claim?.executorRefusal, executor).toBe(NO_MODEL_MESSAGE);
        }
    });

    it('an OpenCode `{env:NAME}` apiKey claims when NAME travels', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await env.replaceWorkspace(ALICE, [{ name: 'GATEWAY_KEY', value: 'gw', isSecret: true }]);
        const config = { provider: { custom: { options: { apiKey: '{env:GATEWAY_KEY}' } } } };
        await executors.replace(ALICE, [{ name: 'gw', type: 'opencode', config }]);
        await mustCreate(jobs.create('gw', ALICE, { repo: 'acme/web', executor: 'gw', executorScope: 'user' }));
        expect((await jobs.claim('w1', LEASE_SECONDS))?.executorRefusal).toBeNull();
    });

    it('a reviewer is judged on the env it is granted, not on the author env', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud', { ...REVIEWER, connections: ['DEPLOY_REGION'] });
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceOrg('env-admin', [
            { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-author-only', isSecret: true },
            { name: 'DEPLOY_REGION', value: 'eu', isSecret: false },
        ]);
        await mustCreate(jobs.create('ship it', ALICE, { repo: 'acme/api', executor: 'main', executorScope: 'user' }));
        const caller = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(caller.executorRefusal).toBeNull();

        const review = await jobs.requestReview(caller.id, caller.leaseToken, {
            key: 'sec-1',
            profile: 'sec',
            revision: 'h:1',
            ref: reviewRefOf(caller.id, 'sec-1'),
        });
        const claim = 'claim' in review ? review.claim : undefined;
        expect(claim?.executorRefusal).toBe(NO_MODEL_MESSAGE);
        expect(claim?.env).toBeUndefined();
    });

    it('a self-hosted board claims with no key', async () => {
        const { executors, jobs } = stores(ORG, 'self-hosted');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await mustCreate(jobs.create('echo', ALICE, { repo: 'acme/web', executor: 'main', executorScope: 'user' }));
        expect((await jobs.claim('w1', LEASE_SECONDS))?.executorRefusal).toBeNull();
    });
});
