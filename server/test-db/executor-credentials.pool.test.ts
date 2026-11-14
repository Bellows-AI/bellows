import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretStore } from './env-secrets-harness.js';
import { mustCreate, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * A profile saved before keys moved to the secret store is converted before a claim opens its
 * transaction: with a one-connection pool (`DB_POOL_MAX=1`), a conversion inside the claim or review
 * transaction would wait for the connection the transaction holds, forever.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const LEASE_SECONDS = 300;
const KEY = 'sk-ant-api03-saved-before-the-store';
const PLAINTEXT = { env: { ANTHROPIC_API_KEY: KEY } };
const REVIEWER: ReviewerSpec = { name: 'sec', instructions: 'Look.', timeoutMinutes: 7, connections: [] };
const DEADLINE_MS = 5000;

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER] });

let one: Sql;

beforeAll(() => {
    if (enabled) one = postgres(db.url as string, { max: 1 });
});
afterAll(async () => {
    if (enabled) await one.end();
});

/** A fresh process's stores over the one-connection pool; the secret store keeps its own pool, as in main.ts. */
function boot() {
    const executors = createUserExecutorStore({
        sql: one,
        orgId: ORG,
        secrets: testSecretStore(db.sql),
        secretLog: () => {},
    });
    const jobs = createJobStore({
        sql: one,
        orgId: ORG,
        executorConfig: executors,
        githubApp: true,
        plan: {
            readFor: async () => ({ config: null, error: null, services: [], revision: null, reviewers: [REVIEWER] }),
        },
    });
    return { executors, jobs };
}

async function seedPlaintext() {
    await db.sql`delete from executor_profile where org_id = ${ORG} and user_id = ${ALICE}`;
    await db.sql`
        insert into executor_profile (org_id, user_id, name, type, config, position)
        values (${ORG}, ${ALICE}, 'main', 'claude-code', ${db.sql.json(PLAINTEXT)}, 0)
    `;
}

function withinDeadline<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
        work,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('claim hung on the pool')), DEADLINE_MS).unref()
        ),
    ]);
}

describe.skipIf(!enabled)('an unconverted profile on a one-connection pool', () => {
    it('a task claim converts it first and carries the key', async () => {
        await seedPlaintext();
        const { jobs } = boot();
        await mustCreate(jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        const claim = await withinDeadline(jobs.claim('w1', LEASE_SECONDS));
        expect(JSON.parse(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? '{}')).toEqual(PLAINTEXT);
    });

    it('a review claim converts it first and carries the key', async () => {
        await seedPlaintext();
        const first = boot();
        await mustCreate(
            first.jobs.create('ship it', ALICE, { repo: 'acme/api', executor: 'main', executorScope: 'user' })
        );
        const caller = (await withinDeadline(first.jobs.claim('w1', LEASE_SECONDS))) as Claim;
        // Saved again in the old form, then a restart: the review is the new process's first claim.
        await seedPlaintext();
        const { jobs } = boot();

        const review = await withinDeadline(
            jobs.requestReview(caller.id, caller.leaseToken, {
                key: 'sec-1',
                profile: 'sec',
                revision: 'h:1',
                ref: reviewRefOf(caller.id, 'sec-1'),
            })
        );
        expect(review.result).toBe('created');
        const claim = 'claim' in review ? review.claim : undefined;
        expect(JSON.parse(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? '{}')).toEqual(PLAINTEXT);
    });
});
