import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { EnvSecretError } from '../src/db/env-secrets.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import { seedEncryptedRow, testSecretStore } from './env-secrets-harness.js';
import { account, mustCreate, randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';
import { MutableKeys } from './secrets-postgres-harness.js';

/**
 * Where the secret store is called from: inside the claim's transaction, which holds a pooled connection
 * (docs/secrets.md). The pool test is the reason the store gets a pool of its own in main.ts.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const LEASE_SECONDS = 300;
const db = useTestDb({ orgs: [ORG] });

let sql: Sql;
let claimPool: Sql;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    claimPool = postgres(process.env.DATABASE_URL as string, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
    if (enabled) await claimPool.end({ timeout: 5 });
});

const org = { orgId: ORG, scope: { kind: 'org' } } as const;

describe.skipIf(!enabled)('environment secrets resolved inside a claim', () => {
    it('resolves with a claim pool of one connection when the store has a pool of its own', async () => {
        const keys = new MutableKeys();
        await seedEncryptedRow(sql, testSecretStore(sql, keys), { ...org, name: 'POOLED' }, 'pooled-value');
        const jobs = createJobStore({
            sql: claimPool,
            orgId: ORG,
            env: createEnvVarStore({
                sql: claimPool,
                orgId: ORG,
                secrets: testSecretStore(sql, keys),
                secretLog: () => {},
            }),
        });
        await mustCreate(jobs.create('echo hi', null, { repo: null, executor: null }));

        const claim = await Promise.race([
            jobs.claim('driver-1', LEASE_SECONDS),
            new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 2000)),
        ]);

        expect(claim).toMatchObject({ env: { POOLED: 'pooled-value' } });
    });

    it('guard: a store sharing the claim’s only connection cannot be read, and fails closed', async () => {
        const keys = new MutableKeys();
        await seedEncryptedRow(sql, testSecretStore(sql, keys), { ...org, name: 'SHARED' }, 'shared-value');
        const jobs = createJobStore({
            sql: claimPool,
            orgId: ORG,
            env: createEnvVarStore({
                sql: claimPool,
                orgId: ORG,
                secrets: testSecretStore(claimPool, keys),
                secretLog: () => {},
            }),
        });
        await mustCreate(jobs.create('echo hi', null, { repo: null, executor: null }));

        await expect(jobs.claim('driver-1', LEASE_SECONDS)).rejects.toBeInstanceOf(EnvSecretError);
    });

    it('an undecryptable secret rolls a review claim back: no review row is left', async () => {
        const secrets = testSecretStore(sql);
        const REVIEWER: ReviewerSpec = { name: 'security', instructions: 'Look.', timeoutMinutes: 7, connections: [] };
        const jobs = createJobStore({
            sql,
            orgId: ORG,
            plan: {
                readFor: async () => ({
                    config: null,
                    error: null,
                    services: [],
                    revision: null,
                    reviewers: [REVIEWER],
                }),
            },
            env: createEnvVarStore({ sql, orgId: ORG, secrets, secretLog: () => {} }),
            githubApp: true,
        });
        const author = await account(sql, randomGithubId(), 'review-env');
        await mustCreate(jobs.create('ship it', author, { repo: 'acme/web', executor: null }));
        const caller = (await jobs.claim('driver-1', LEASE_SECONDS)) as Claim;
        const { ref } = await seedEncryptedRow(sql, secrets, { ...org, name: 'LOCKED' }, 'v');
        await sql`update secret_version set envelope = set_byte(envelope, length(envelope) - 1,
                  get_byte(envelope, length(envelope) - 1) # 1) where ref = ${ref}`;

        await expect(
            jobs.requestReview(caller.id, caller.leaseToken, {
                key: 'sec-1',
                profile: 'security',
                revision: 'h:2',
                ref: reviewRefOf(caller.id, 'sec-1'),
            })
        ).rejects.toBeInstanceOf(EnvSecretError);

        const reviews = await sql`select id from job where org_id = ${ORG} and review_of = ${caller.id}`;
        expect(reviews).toHaveLength(0);
    });
});
