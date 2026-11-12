import { CLOUD_CREDENTIAL_MESSAGE, type DeploymentMode } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretStore } from './env-secrets-harness.js';
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

function stores(orgId: string, deploymentMode: DeploymentMode) {
    const executors = createUserExecutorStore({ sql, orgId });
    const env = createEnvVarStore({ sql, orgId, secrets: testSecretStore(sql), secretLog: () => {} });
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
        expect((await executors.configFor(ALICE, 'main', 'user', sql))?.config).toEqual({ env: { [TOKEN]: VALUE } });
    });

    it('(b) in a repo-scope env row: refused, the row kept', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await env.replaceRepo('acme', 'web', [{ name: TOKEN, value: VALUE, isSecret: false }]);
        await mustCreate(jobs.create('echo hi', ALICE, { repo: 'acme/web', executor: 'main', executorScope: 'user' }));

        expectRefused(await jobs.claim('w1', LEASE_SECONDS));
        expect(await env.listRepo('acme', 'web')).toEqual([expect.objectContaining({ name: TOKEN })]);
    });

    it('(c) granted to a reviewer: the review claim is refused', async () => {
        const { executors, env, jobs } = stores(ORG, 'cloud');
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await mustCreate(jobs.create('ship it', ALICE, { repo: 'acme/api', executor: 'main', executorScope: 'user' }));
        const caller = (await jobs.claim('w1', LEASE_SECONDS)) as Claim;
        expect(caller.executorRefusal).toBeNull();
        // Stored after the author's claim, as a token saved before cloud mode would sit there.
        await env.replaceOrg([{ name: TOKEN, value: VALUE, isSecret: false }]);

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
