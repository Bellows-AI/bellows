import { randomUUID } from 'node:crypto';
import { noExecutorMessage } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim, JobStore } from '../src/db/jobs/job-store-types.js';
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

    it("the claim carries the profile's runnerClass; null when unset", async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        await executors.createOrg({
            name: 'sandboxed',
            type: 'claude-code',
            config: {},
            runnerClass: 'kata',
            createdBy: ALICE,
        });
        await executors.createOrg({ name: 'plain', type: 'claude-code', config: {}, createdBy: ALICE });
        const classed = await mustCreate(
            store.create('echo hi', BOB, { repo: null, executor: 'sandboxed', executorScope: 'org' })
        );

        const first = await store.claim('w5', LEASE_SECONDS);
        expect(first?.id).toBe(classed.id);
        expect(first?.runnerClass).toBe('kata');

        const plain = await mustCreate(
            store.create('echo hi', BOB, { repo: null, executor: 'plain', executorScope: 'org' })
        );
        const second = await store.claim('w6', LEASE_SECONDS);
        expect(second?.id).toBe(plain.id);
        expect(second?.runnerClass).toBeNull();
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
 * A queued job naming no executor has nothing to run on: its claim carries no executor type and says why, so the driver
 * fails it before a runner starts. Nothing is frozen on the row any more; the default is resolved at create, to a profile.
 */
describe.skipIf(!enabled)('a queued job naming no executor', () => {
    it('claims with executorType null and an explicit no-executor refusal', async () => {
        const { id } = await mustCreate(store.create('echo hi', ALICE, { repo: null, executor: null }));

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBeNull();
        expect(claim?.executorRefusal).toBe(noExecutorMessage);
    });
});

/**
 * A model chosen at task start or on a follow-up: `agent_model` on the row overrides the profile's `config.model`
 * (after the runner fence), and every claim records what the runner got as
 * `run_model`, read back as `resolvedModel` beside the requested `agentModel`.
 */
describe.skipIf(!enabled)('a model chosen for the task', () => {
    const CONFIG_ENV = { 'claude-code': 'CLAUDE_CODE_CONFIG_CONTENT', opencode: 'OPENCODE_CONFIG_CONTENT' } as const;
    const executors = () => createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
    const saveProfile = (type: 'claude-code' | 'opencode', config: Record<string, unknown>) =>
        executors().replace(ALICE, [{ name: 'main', type, config }]);
    const profileTask = (agentModel?: string) =>
        mustCreate(
            store.create('echo hi', ALICE, {
                repo: null,
                executor: 'main',
                executorScope: 'user',
                ...(agentModel ? { agentModel } : {}),
            })
        );
    const configOf = (claim: Claim | null, type: 'claude-code' | 'opencode') =>
        JSON.parse(claim?.env?.[CONFIG_ENV[type]] ?? 'null');
    /** A finished turn with a session, so a follow-up may continue it. */
    const finish = async (id: string, worker: string) => {
        const claim = await store.claim(worker, LEASE_SECONDS);
        expect(claim?.id).toBe(id);
        await store.session(id, claim!.leaseToken, FOLLOW_UP_SESSION);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        return claim;
    };
    const followUp = async (parentId: string, model?: string) => {
        const ref = await store.createFollowUp(
            parentId,
            'adjust',
            ALICE,
            undefined,
            undefined,
            undefined,
            undefined,
            model
        );
        if (typeof ref === 'string') throw new Error(`createFollowUp refused: ${ref}`);
        return ref.id;
    };

    for (const type of ['claude-code', 'opencode'] as const) {
        it(`overrides the ${type} profile's model and keeps the rest of its config`, async () => {
            await saveProfile(type, { model: 'A', provider: { p: 1 } });
            const { id } = await profileTask('B');

            const claim = await store.claim('w1', LEASE_SECONDS);

            expect(claim?.executorType).toBe(type);
            expect(configOf(claim, type)).toEqual({ model: 'B', provider: { p: 1 } });
            expect(await store.get(id)).toMatchObject({ agentModel: 'B', resolvedModel: 'B' });
        });
    }

    it('a follow-up with a model runs it, and the next follow-up without one keeps it', async () => {
        await saveProfile('opencode', { model: 'A' });
        const { id } = await profileTask('B');
        await finish(id, 'w1');

        const second = await followUp(id, 'C');
        expect(configOf(await finish(second, 'w2'), 'opencode')).toEqual({ model: 'C' });
        const third = await followUp(second);

        expect(configOf(await store.claim('w3', LEASE_SECONDS), 'opencode')).toEqual({ model: 'C' });
        expect(await store.get(third)).toMatchObject({ agentModel: 'C', resolvedModel: 'C' });
    });

    it('a takeover and a retry keep the chosen model', async () => {
        await saveProfile('opencode', { model: 'A' });
        const { id } = await profileTask('B');
        await store.claim('w1', LEASE_SECONDS);
        await expireLease(sql, id);
        const takeover = await store.claim('w2', LEASE_SECONDS);
        expect(configOf(takeover, 'opencode')).toEqual({ model: 'B' });
        await store.complete(id, takeover!.leaseToken, { status: 'failed', exitCode: 1, output: 'no' });

        const retry = await store.createRetry(id, ALICE);
        if (typeof retry === 'string') throw new Error(`createRetry refused: ${retry}`);

        expect(configOf(await store.claim('w3', LEASE_SECONDS), 'opencode')).toEqual({ model: 'B' });
        expect(await store.get(retry.id)).toMatchObject({ agentModel: 'B', resolvedModel: 'B' });
    });

    it('records the model each claim handed out: the task override, else the profile config.model, else null', async () => {
        await saveProfile('claude-code', { model: 'A' });
        const profileOnly = (await profileTask()).id;
        expect(await store.get(profileOnly)).toMatchObject({ agentModel: null, resolvedModel: null });
        await store.claim('w1', LEASE_SECONDS);
        expect(await store.get(profileOnly)).toMatchObject({ agentModel: null, resolvedModel: 'A' });

        const overridden = (await profileTask('m-1')).id;
        await store.claim('w2', LEASE_SECONDS);
        expect(await store.get(overridden)).toMatchObject({ agentModel: 'm-1', resolvedModel: 'm-1' });

        await saveProfile('claude-code', { permissions: { allow: [] } });
        const none = (await profileTask()).id;
        await store.claim('w3', LEASE_SECONDS);
        expect(await store.get(none)).toMatchObject({ agentModel: null, resolvedModel: null });
    });

    it('a retry re-records from its own claim, after the profile changed', async () => {
        await saveProfile('opencode', { model: 'A' });
        const { id } = await profileTask();
        const first = await store.claim('w1', LEASE_SECONDS);
        await store.complete(id, first!.leaseToken, { status: 'failed', exitCode: 1, output: 'no' });
        await saveProfile('opencode', { model: 'A2' });

        const retry = await store.createRetry(id, ALICE);
        if (typeof retry === 'string') throw new Error(`createRetry refused: ${retry}`);
        await store.claim('w2', LEASE_SECONDS);

        expect(await store.get(id)).toMatchObject({ resolvedModel: 'A' });
        expect(await store.get(retry.id)).toMatchObject({ agentModel: null, resolvedModel: 'A2' });
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

    it('a Claude Code task with a chosen model claims the key wired as an Anthropic bearer to OpenRouter', async () => {
        const { executors, env, jobs } = withEnv();
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await saveEnv(env, { OPENROUTER_API_KEY: OPENROUTER_KEY });
        await mustCreate(
            jobs.create('echo hi', ALICE, {
                repo: null,
                executor: 'main',
                executorScope: 'user',
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
        const { executors, env, jobs } = withEnv();
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: {} }]);
        await saveEnv(env, { OPENROUTER_API_KEY: OPENROUTER_KEY });
        await mustCreate(
            jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user', agentModel: 'm' })
        );
        const opencode = await jobs.claim('w1', LEASE_SECONDS);
        expect(opencode?.env?.OPENROUTER_API_KEY).toBe(OPENROUTER_KEY);
        for (const name of Object.keys(WIRED)) expect(opencode?.env).not.toHaveProperty(name);

        await saveEnv(env, { OPENROUTER_API_KEY: OPENROUTER_KEY, ANTHROPIC_API_KEY: 'sk-ant-member' });
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        await mustCreate(
            jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user', agentModel: 'm' })
        );
        const keyed = await jobs.claim('w2', LEASE_SECONDS);
        expect(keyed?.env?.ANTHROPIC_API_KEY).toBe('sk-ant-member');
        expect(keyed?.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
        expect(keyed?.env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    });
});

/**
 * Claude Code takes `$ANTHROPIC_MODEL` over its settings' `model`, so a task's chosen model rides the claim env under
 * that name (the claim env wins over the driver's RUNNER_ENV) and the recorded `run_model` is the one the CLI runs:
 * without a chosen model, an `ANTHROPIC_MODEL` the member env or the profile's `env` sets. OpenCode reads no model
 * env var: its config's `model` is the only source.
 */
describe.skipIf(!enabled)('the recorded model is the one the runner uses', () => {
    const withEnv = () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        const env = createEnvVarStore({ sql, orgId: ORG, ...testSecretDeps(sql) });
        return { executors, env, jobs: createJobStore({ sql, orgId: ORG, env, executorConfig: executors }) };
    };
    const setUp = async (type: 'claude-code' | 'opencode', config: Record<string, unknown>, model?: string) => {
        const { executors, env, jobs } = withEnv();
        await executors.replace(ALICE, [{ name: 'main', type, config }]);
        await env.replaceWorkspace(ALICE, [{ name: 'ANTHROPIC_MODEL', value: 'A', isSecret: false }]);
        const { id } = await mustCreate(
            jobs.create('echo hi', ALICE, {
                repo: null,
                executor: 'main',
                executorScope: 'user',
                ...(model ? { agentModel: model } : {}),
            })
        );
        return { id, jobs, claim: await jobs.claim('w1', LEASE_SECONDS) };
    };

    it('a Claude Code task with a chosen model carries it as ANTHROPIC_MODEL over the member env', async () => {
        const { id, jobs, claim } = await setUp('claude-code', { model: 'P', env: { ANTHROPIC_MODEL: 'P-env' } }, 'B');
        expect(claim?.env?.ANTHROPIC_MODEL).toBe('B');
        expect(JSON.parse(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT ?? 'null')).toMatchObject({
            model: 'B',
            env: { ANTHROPIC_MODEL: 'B' },
        });
        expect(await jobs.get(id)).toMatchObject({ agentModel: 'B', resolvedModel: 'B' });
    });

    it("a Claude Code task without one records the env's ANTHROPIC_MODEL, the profile's env over the member's", async () => {
        const member = await setUp('claude-code', { model: 'P' });
        expect(member.claim?.env?.ANTHROPIC_MODEL).toBe('A');
        expect(await member.jobs.get(member.id)).toMatchObject({ agentModel: null, resolvedModel: 'A' });

        const profile = await setUp('claude-code', { model: 'P', env: { ANTHROPIC_MODEL: 'P-env' } });
        expect(await profile.jobs.get(profile.id)).toMatchObject({ resolvedModel: 'P-env' });
    });

    it('a Claude Code task with neither pins the config model, so a driver-forwarded ANTHROPIC_MODEL cannot win', async () => {
        const { executors, jobs } = withEnv();
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { model: 'P' } }]);
        const { id } = await mustCreate(
            jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' })
        );
        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.env?.ANTHROPIC_MODEL).toBe('P');
        expect(await jobs.get(id)).toMatchObject({ resolvedModel: 'P' });
    });

    it('a Claude Code task where nothing names a model sends none and records none', async () => {
        const { executors, jobs } = withEnv();
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: {} }]);
        const { id } = await mustCreate(
            jobs.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' })
        );
        const claim = await jobs.claim('w1', LEASE_SECONDS);
        expect(claim?.env ?? {}).not.toHaveProperty('ANTHROPIC_MODEL');
        expect(await jobs.get(id)).toMatchObject({ resolvedModel: null });
    });

    it('an OpenCode task reads no model env: its config model is recorded, and the env is left as it is', async () => {
        const chosen = await setUp('opencode', { model: 'P' }, 'B');
        expect(chosen.claim?.env?.ANTHROPIC_MODEL).toBe('A');
        expect(await chosen.jobs.get(chosen.id)).toMatchObject({ resolvedModel: 'B' });

        const profile = await setUp('opencode', { model: 'P' });
        expect(await profile.jobs.get(profile.id)).toMatchObject({ resolvedModel: 'P' });
    });
});
