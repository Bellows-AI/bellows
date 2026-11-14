import { credentialRedirectMessage, type DeploymentMode, STORED_CREDENTIAL_PREFIX } from '@factory-ai/core';
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
