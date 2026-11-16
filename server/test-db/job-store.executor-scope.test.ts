import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { useTestDb } from './harness.js';
import { expireLease, mustCreate, testOrg, testUser } from './fixtures.js';
import { testSecretDeps } from './env-secrets-harness.js';

/**
 * Issue 391's board half: a task selection names a scope and a profile, and the claim resolves
 * type + configuration from the STAMPED scope's row — a personal and an organization row sharing
 * a name stay distinguishable, an org row resolves for any author, and an unavailable selection
 * stays null (the driver fails it) rather than falling back to the other scope. The copies —
 * follow-up, retry — inherit the scope beside the executor label they already inherit.
 */

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;
const SESSION = randomUUID();
const FOLLOW_UP_SESSION = randomUUID();
const LEASE_SECONDS = 300;

const db = useTestDb({
    orgs: [ORG],
    users: [ALICE_USER, BOB_USER],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({
        sql,
        orgId: ORG,
        executorConfig: createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) }),
    });
});

describe.skipIf(!enabled)('claim resolution across executor scopes (issue 391)', () => {
    /** Alice's personal "main" and the organization's own "main": same name, two rows. */
    const seedSameName = async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: { model: 'personal-model' } }]);
        await executors.createOrg({
            name: 'main',
            type: 'claude-code',
            config: { model: 'shared-model' },
            createdBy: ALICE,
        });
    };

    it('resolves an org-scoped selection from the org row, for any author', async () => {
        await seedSameName();
        const { id } = await mustCreate(
            store.create('echo hi', BOB, { repo: null, executor: 'main', executorScope: 'org' })
        );

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBe('claude-code');
        // The org row's configuration reaches the claim env under claude-code's merge name —
        // with the runner-managed keys already stripped, per the standing claim contract.
        const merged = claim?.env?.CLAUDE_CODE_CONFIG_CONTENT;
        expect(merged).toBeDefined();
        expect(JSON.parse(merged!)).toEqual({ model: 'shared-model' });
    });

    it('resolves the personal row when the selection stamps the personal scope', async () => {
        await seedSameName();
        await mustCreate(store.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        const claim = await store.claim('w2', LEASE_SECONDS);

        expect(claim?.executorType).toBe('opencode');
        expect(JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({ model: 'personal-model' });
    });

    it('a scope with no matching row stays null — no cross-scope fallback', async () => {
        await seedSameName();
        // Bob has no personal "main": his personal-scope selection names nothing.
        const { id } = await mustCreate(
            store.create('echo hi', BOB, { repo: null, executor: 'main', executorScope: 'user' })
        );

        const claim = await store.claim('w3', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBeNull();
        expect(claim?.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
        expect(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT).toBeUndefined();
    });

    it('a row removed after queueing resolves null, and the task fails clearly rather than guessing', async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        await executors.createOrg({ name: 'gone', type: 'claude-code', config: {}, createdBy: ALICE });
        const { id } = await mustCreate(
            store.create('echo hi', ALICE, { repo: null, executor: 'gone', executorScope: 'org' })
        );
        const orgRow = (await executors.listOrg()).find((row) => row.name === 'gone')!;
        await executors.deleteOrg(orgRow.id);

        const claim = await store.claim('w4', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBeNull();
    });
});

describe.skipIf(!enabled)('claim resolution against a suspended profile (issue 440)', () => {
    const suspend = async (scope: 'user' | 'org', name: string, suspended: boolean) => {
        const executors = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        if (scope === 'org') {
            const row = (await executors.listOrg()).find((r) => r.name === name)!;
            await executors.setOrgSuspended(row.id, suspended);
        } else {
            const row = (await executors.list(ALICE)).find((r) => r.name === name)!;
            await executors.setPersonalSuspended(ALICE, row.id, suspended);
        }
    };

    it('hands out no runner and no config for a suspended profile, and says why', async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { model: 'secret' } }]);
        const { id } = await mustCreate(
            store.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' })
        );
        await suspend('user', 'main', true);

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBeNull();
        expect(claim?.executorRefusal).toContain('"main"');
        expect(claim?.executorRefusal).toContain('suspended');
        expect(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT).toBeUndefined();
    });

    it('is scoped: a suspended personal profile does not refuse the same-named org selection', async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: {} }]);
        await executors.createOrg({ name: 'main', type: 'claude-code', config: {}, createdBy: ALICE });
        await suspend('user', 'main', true);
        await mustCreate(store.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'org' }));

        const claim = await store.claim('w2', LEASE_SECONDS);

        expect(claim?.executorType).toBe('claude-code');
        expect(claim?.executorRefusal).toBeNull();
    });

    it('applies to a follow-up and a retry the same way, and launches again once resumed', async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        await executors.createOrg({ name: 'team', type: 'claude-code', config: {}, createdBy: ALICE });
        const parent = await mustCreate(
            store.create('drive me', ALICE, { repo: null, executor: 'team', executorScope: 'org' })
        );
        const first = await store.claim('w3', LEASE_SECONDS);
        await store.session(parent.id, first!.leaseToken, FOLLOW_UP_SESSION);
        await store.complete(parent.id, first!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        await suspend('org', 'team', true);

        const followUp = await store.createFollowUp(parent.id, 'adjust', ALICE);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);
        const refused = await store.claim('w4', LEASE_SECONDS);
        expect(refused?.id).toBe(followUp.id);
        expect(refused?.executorType).toBeNull();
        expect(refused?.executorRefusal).toContain('suspended');
        // The driver fails a refused claim as config (driver/src/loop/loop-run.ts failOnClaimRefusal);
        // until it does the follow-up is the thread's moving head and a retry is not_finished.
        await store.complete(followUp.id, refused!.leaseToken, {
            status: 'failed',
            exitCode: null,
            output: refused!.executorRefusal!,
            failureKind: 'config',
        });

        await suspend('org', 'team', false);
        const retry = await store.createRetry(parent.id, ALICE);
        if (typeof retry === 'string') throw new Error(`createRetry refused: ${retry}`);
        const allowed = await store.claim('w5', LEASE_SECONDS);
        expect(allowed?.id).toBe(retry.id);
        expect(allowed?.executorType).toBe('claude-code');
        expect(allowed?.executorRefusal).toBeNull();
    });
});

describe.skipIf(!enabled)('the scope rides the thread (issue 391)', () => {
    /** Takes a job the whole way to a finished run with a session, the follow-up's starting state. */
    const finishWithSession = async (target: { executor: string; executorScope: 'user' | 'org' }) => {
        const { id } = await mustCreate(store.create('drive me', ALICE, { repo: null, ...target }));
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, claim!.leaseToken, SESSION);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        return id;
    };

    it('a follow-up inherits the stamped scope beside the executor label', async () => {
        const parent = await finishWithSession({ executor: 'main', executorScope: 'org' });

        const followUp = await store.createFollowUp(parent, 'adjust', ALICE);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);

        expect(await store.get(followUp.id)).toMatchObject({
            executor: 'main',
            executorScope: 'org',
            followUpTo: parent,
        });
    });

    it('a retry inherits the stamped scope from the thread head', async () => {
        const head = await finishWithSession({ executor: 'team-runner', executorScope: 'org' });

        const retry = await store.createRetry(head, ALICE);
        if (typeof retry === 'string') throw new Error(`createRetry refused: ${retry}`);

        expect(await store.get(retry.id)).toMatchObject({
            executor: 'team-runner',
            executorScope: 'org',
            rootJobId: (await store.get(head))?.rootJobId,
        });
    });
});

/**
 * The agent default: a task naming no profile is frozen at create with the agent and model that won, and the
 * claim runs exactly that — never the agent default as it reads at claim time. Kubernetes is the primary executor and
 * docker the development one; both consume this same claim payload (`executorType` + the config env), so each agent
 * type is pinned once here and the driver needs nothing new.
 */
describe.skipIf(!enabled)('a task frozen with an agent default', () => {
    const CONFIG_ENV = { 'claude-code': 'CLAUDE_CODE_CONFIG_CONTENT', opencode: 'OPENCODE_CONFIG_CONTENT' } as const;
    const executors = () => createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });

    /** What create stamps: the agent default that wins for Alice right now, read through the chain. */
    const frozenTask = async (agentType: 'claude-code' | 'opencode', model: string, repo: string | null = null) => {
        await executors().setAgentDefault(ALICE, { agentType, model });
        const won = await executors().resolvedDefault(ALICE);
        if (won?.kind !== 'agent') throw new Error('the agent default did not win');
        return mustCreate(
            store.create('drive me', ALICE, {
                repo,
                executor: null,
                agentType: won.agentType,
                agentModel: won.model,
            })
        );
    };
    /** The agent default moves on after create; nothing frozen may follow it. */
    const changeDefault = () => executors().setAgentDefault(ALICE, { agentType: 'opencode', model: 'moved-on' });
    const expectFrozen = (claim: Claim | null, type: 'claude-code' | 'opencode', model: string) => {
        expect(claim?.executorType).toBe(type);
        expect(claim?.executorRefusal).toBeNull();
        expect(JSON.parse(claim?.env?.[CONFIG_ENV[type]] ?? 'null')).toEqual({ model });
    };

    for (const agentType of ['claude-code', 'opencode'] as const) {
        it(`claims a null-executor task as its frozen ${agentType}, the model in that CLI's config env`, async () => {
            const { id } = await mustCreate(
                store.create('echo hi', ALICE, { repo: null, executor: null, agentType, agentModel: 'm-1' })
            );

            const claim = await store.claim('w1', LEASE_SECONDS);

            expect(claim?.id).toBe(id);
            expectFrozen(claim, agentType, 'm-1');
            expect(await store.get(id)).toMatchObject({ executor: null, agentType, agentModel: 'm-1' });
        });
    }

    it('the queued task keeps its values after the agent default changes', async () => {
        const { id } = await frozenTask('claude-code', 'frozen');
        await changeDefault();

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expectFrozen(claim, 'claude-code', 'frozen');
    });

    it('a takeover re-claim after a lost lease keeps them', async () => {
        const { id } = await frozenTask('claude-code', 'frozen');
        await store.claim('w1', LEASE_SECONDS);
        await changeDefault();
        await expireLease(sql, id);

        const takeover = await store.claim('w2', LEASE_SECONDS);

        expect(takeover?.id).toBe(id);
        expectFrozen(takeover, 'claude-code', 'frozen');
    });

    it('a retry copies them from the thread head', async () => {
        const { id } = await frozenTask('claude-code', 'frozen');
        const first = await store.claim('w1', LEASE_SECONDS);
        await store.complete(id, first!.leaseToken, { status: 'failed', exitCode: 1, output: 'no' });
        await changeDefault();

        const retry = await store.createRetry(id, ALICE);
        if (typeof retry === 'string') throw new Error(`createRetry refused: ${retry}`);

        expect(await store.get(retry.id)).toMatchObject({ agentType: 'claude-code', agentModel: 'frozen' });
        expectFrozen(await store.claim('w2', LEASE_SECONDS), 'claude-code', 'frozen');
    });

    it('a follow-up copies them from its parent', async () => {
        const { id } = await frozenTask('claude-code', 'frozen');
        const first = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, first!.leaseToken, FOLLOW_UP_SESSION);
        await store.complete(id, first!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        await changeDefault();

        const followUp = await store.createFollowUp(id, 'adjust', ALICE);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);

        expect(await store.get(followUp.id)).toMatchObject({ agentType: 'claude-code', agentModel: 'frozen' });
        expectFrozen(await store.claim('w2', LEASE_SECONDS), 'claude-code', 'frozen');
    });

    it('a reviewer inserted for the task runs them too', async () => {
        const reviewer: ReviewerSpec = { name: 'sec', instructions: 'Look.', timeoutMinutes: 7, connections: [] };
        const reviewing = createJobStore({
            sql,
            orgId: ORG,
            executorConfig: executors(),
            githubApp: true,
            plan: {
                readFor: async () => ({
                    config: null,
                    error: null,
                    services: [],
                    revision: null,
                    reviewers: [reviewer],
                }),
            },
        });
        // A review is asked for a task on a repo: its profile list is that repo's plan.
        await frozenTask('claude-code', 'frozen', 'acme/api');
        const caller = await reviewing.claim('w1', LEASE_SECONDS);
        await changeDefault();

        const review = await reviewing.requestReview(caller!.id, caller!.leaseToken, {
            key: 'sec-1',
            profile: 'sec',
            revision: 'h:1',
            ref: reviewRefOf(caller!.id, 'sec-1'),
        });

        expect(review.result).toBe('created');
        expectFrozen('claim' in review ? review.claim : null, 'claude-code', 'frozen');
    });
});

describe.skipIf(!enabled)('Claude Code on an OpenRouter key alone', () => {
    const OPENROUTER_KEY = 'sk-or-v1-member-owned';
    const WIRED = {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: OPENROUTER_KEY,
        ANTHROPIC_API_KEY: '',
    };
    const withEnv = () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        const env = createEnvVarStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        return { executors, env, jobs: createJobStore({ sql, orgId: ORG, env, executorConfig: executors }) };
    };
    const saveEnv = (env: ReturnType<typeof withEnv>['env'], vars: Record<string, string>) =>
        env.replaceWorkspace(
            ALICE,
            Object.entries(vars).map(([name, value]) => ({ name, value, isSecret: true }))
        );

    it('a task frozen with Claude Code claims the key wired as an Anthropic bearer to OpenRouter', async () => {
        const { env, jobs } = withEnv();
        await saveEnv(env, { OPENROUTER_API_KEY: OPENROUTER_KEY });
        await mustCreate(
            jobs.create('echo hi', ALICE, {
                repo: null,
                executor: null,
                agentType: 'claude-code',
                agentModel: 'anthropic/claude-sonnet-4',
            })
        );

        const claim = await jobs.claim('w1', LEASE_SECONDS);

        expect(claim?.executorRefusal).toBeNull();
        expect(claim?.env).toMatchObject({ ...WIRED, OPENROUTER_API_KEY: OPENROUTER_KEY });
    });

    it('a Claude Code profile task is wired the same way', async () => {
        const { executors, env, jobs } = withEnv();
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await saveEnv(env, { OPENROUTER_API_KEY: OPENROUTER_KEY });
        await mustCreate(jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        expect((await jobs.claim('w1', LEASE_SECONDS))?.env).toMatchObject(WIRED);
    });

    it('an opencode task, or a member Anthropic key beside it, claims the env unchanged', async () => {
        const { env, jobs } = withEnv();
        await saveEnv(env, { OPENROUTER_API_KEY: OPENROUTER_KEY });
        await mustCreate(
            jobs.create('echo hi', ALICE, { repo: null, executor: null, agentType: 'opencode', agentModel: 'm' })
        );
        const opencode = await jobs.claim('w1', LEASE_SECONDS);
        expect(opencode?.env?.OPENROUTER_API_KEY).toBe(OPENROUTER_KEY);
        for (const name of Object.keys(WIRED)) expect(opencode?.env).not.toHaveProperty(name);

        await saveEnv(env, { OPENROUTER_API_KEY: OPENROUTER_KEY, ANTHROPIC_API_KEY: 'sk-ant-member' });
        await mustCreate(
            jobs.create('echo hi', ALICE, { repo: null, executor: null, agentType: 'claude-code', agentModel: 'm' })
        );
        const keyed = await jobs.claim('w2', LEASE_SECONDS);
        expect(keyed?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-member');
        expect(keyed?.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
        expect(keyed?.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    });
});
