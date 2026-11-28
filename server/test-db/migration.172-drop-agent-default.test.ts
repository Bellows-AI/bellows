import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { assertTestDatabase } from './harness.js';
import { randomGithubId } from './fixtures.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim } from '../src/db/jobs/job-store-types.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretDeps } from './env-secrets-harness.js';

/**
 * 172 removes the agent default. Work that never started and was frozen with one (a queued job, a pending batch task,
 * a parked workflow round) moves onto its member's configured default executor, personal before org; what finds none
 * is ended with a named reason. The `agent_type` columns, `agent_default` and `user_executor_default` go.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '172_drop_agent_default.sql';
const REASON = 'its agent default was removed; pick an executor and start again';
const DIR = new URL('../migrations/', import.meta.url);
let admin: Sql;
let pool: Sql;
let schema: string;

const versioned = (filter: (name: string) => boolean): string[] =>
    readdirSync(DIR)
        .filter((name) => name.endsWith('.sql') && !name.endsWith('.repeatable.sql') && filter(name))
        .sort();

const newOrgId = (): string => `o${randomUUID().replaceAll('-', '').slice(0, 30)}`;
const org = newOrgId();
/** An organization with no configured default at all. */
const bareOrg = newOrgId();
const ids = { alice: '', bob: '', carol: '' };

interface Seeded {
    job: string;
    batch: string;
    round: string;
}
const seeded: Record<'alice' | 'bob' | 'carol', Seeded> = {} as never;
let runningJob = '';
let profileJob = '';
let finishedJob = '';
let stoppedJob = '';
let carolFinishedJob = '';
let carolRunningJob = '';
let launchedBatch = '';
let draftBatch = '';
let wokenRound = '';

const newUser = async (): Promise<string> => {
    const [row] = await pool<{ id: string }[]>`
        insert into app_user (github_user_id, github_login) values (${randomGithubId()}, ${`u-${randomUUID()}`})
        returning id
    `;
    return row!.id;
};

const newProfile = async (org: string, userId: string | null, name: string, suspended = false): Promise<string> => {
    const [row] = await pool<{ id: string }[]>`
        insert into executor_profile (org_id, user_id, name, type, config, position, suspended)
        values (${org}, ${userId}, ${name}, 'claude-code', '{}'::jsonb, 0, ${suspended}) returning id
    `;
    return row!.id;
};

const select = (org: string, owner: string | null, executorId: string) =>
    pool`insert into executor_default_selection (org_id, owner_id, executor_id) values (${org}, ${owner}, ${executorId})`;

/** A queued agent-default job, a started batch with one pending agent-default task, a parked agent-default round. */
const seedMember = async (org: string, userId: string): Promise<Seeded> => {
    const job = randomUUID();
    await pool`
        insert into job (org_id, id, command, root_job_id, created_by, execution_user_id, agent_type, agent_model)
        values (${org}, ${job}, 'work', ${job}, ${userId}, ${userId}, 'claude-code', 'm-1')
    `;

    const [batch] = await pool<{ id: string }[]>`
        insert into batch (org_id, plan_version, title, policy, concurrency, created_by, started_by)
        values (${org}, 1, 'b', 'human', 1, ${userId}, ${userId}) returning id
    `;
    await pool`insert into batch_target (org_id, batch_id, key, position, repo, branch)
               values (${org}, ${batch!.id}, 't', 0, 'acme/app', 'main')`;
    await pool`insert into batch_stage (org_id, batch_id, key, position, policy)
               values (${org}, ${batch!.id}, 's', 0, 'human')`;
    await pool`
        insert into batch_task (org_id, batch_id, key, stage_key, position, target_key, objective, acceptance,
                                verification, agent_type, agent_model)
        values (${org}, ${batch!.id}, 'k', 's', 0, 't', 'o', 'a', 'v', 'claude-code', 'm-2')
    `;
    await pool`update batch set status = 'started', started_at = now(), deadline_at = now() + interval '1 day' where org_id = ${org} and id = ${batch!.id}`;

    const root = randomUUID();
    await pool`insert into job (org_id, id, command, root_job_id, created_by, execution_user_id, status)
               values (${org}, ${root}, 'work', ${root}, ${userId}, ${userId}, 'succeeded')`;
    await pool`
        insert into workflow_wait (org_id, root_job_id, reason, repo, pr_number)
        values (${org}, ${root}, 'review', 'acme/app', 1)
    `;
    await pool`
        insert into workflow_round (org_id, root_job_id, workflow_node, round, repo, pr_number, command, parent_job_id,
                                    agent_type, agent_model)
        values (${org}, ${root}, 'review', 1, 'acme/app', 1, 'continue', ${root}, 'opencode', 'm-3')
    `;
    return { job, batch: batch!.id, round: root };
};

beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    schema = `mig_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`create schema ${schema}`);
    pool = postgres(url as string, { max: 2, onnotice: () => {}, connection: { search_path: schema } });
    await pool`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
    for (const name of versioned((n) => n < VERSION)) {
        await pool.unsafe(readFileSync(new URL(name, DIR), 'utf8'));
        await pool`insert into schema_migrations (version) values (${name})`;
    }
    await pool`insert into organization (id, name) values (${org}, ${org}), (${bareOrg}, ${bareOrg})`;
    ids.alice = await newUser();
    ids.bob = await newUser();
    ids.carol = await newUser();

    // Alice has a personal default and the org has one too: personal wins. Bob has only the org's.
    // Carol is in an organization with no configured default: an active personal profile and a stored preference
    // (the legacy name-keyed row) do not make one.
    await select(org, ids.alice, await newProfile(org, ids.alice, 'mine'));
    await select(org, null, await newProfile(org, null, 'shared'));
    await newProfile(bareOrg, ids.carol, 'unchosen');
    await pool`insert into user_executor_default (org_id, user_id, scope, name) values (${bareOrg}, ${ids.carol}, 'user', 'unchosen')`;
    await pool`insert into agent_default (org_id, user_id, agent_type, model) values (${bareOrg}, ${ids.carol}, 'claude-code', 'm')`;

    seeded.alice = await seedMember(org, ids.alice);
    seeded.bob = await seedMember(org, ids.bob);
    seeded.carol = await seedMember(bareOrg, ids.carol);

    // Started work is left alone: a running agent-default job, and a queued job that already names a profile.
    runningJob = randomUUID();
    await pool`insert into job (org_id, id, command, root_job_id, created_by, execution_user_id, status, agent_type,
                                agent_model)
               values (${org}, ${runningJob}, 'work', ${runningJob}, ${ids.alice}, ${ids.alice}, 'running',
                       'claude-code', 'm-4')`;
    finishedJob = randomUUID();
    await pool`insert into job (org_id, id, command, root_job_id, created_by, execution_user_id, status, finished_at,
                                session_id, agent_type, agent_model)
               values (${org}, ${finishedJob}, 'work', ${finishedJob}, ${ids.alice}, ${ids.alice}, 'succeeded', now(),
                       ${randomUUID()},
                       'claude-code', 'm-6')`;
    stoppedJob = randomUUID();
    await pool`insert into job (org_id, id, command, root_job_id, created_by, status, agent_type, agent_model)
               values (${org}, ${stoppedJob}, 'work', ${stoppedJob}, ${ids.alice}, 'stopped', 'claude-code', 'm-7')`;
    carolFinishedJob = randomUUID();
    await pool`insert into job (org_id, id, command, root_job_id, created_by, status, agent_type, agent_model)
               values (${bareOrg}, ${carolFinishedJob}, 'work', ${carolFinishedJob}, ${ids.carol}, 'succeeded', 'claude-code', 'm-8')`;

    carolRunningJob = randomUUID();
    await pool`insert into job (org_id, id, command, root_job_id, created_by, status, agent_type, agent_model)
               values (${bareOrg}, ${carolRunningJob}, 'work', ${carolRunningJob}, ${ids.carol}, 'running', 'claude-code', 'm-8')`;

    // A launched task of a started batch, and a pending task of a batch that has not started.
    const taskBatch = async (started: boolean, execution: string): Promise<string> => {
        const [batch] = await pool<{ id: string }[]>`
            insert into batch (org_id, plan_version, title, policy, concurrency, created_by, started_by)
            values (${org}, 1, 'b', 'human', 1, ${ids.alice}, ${started ? ids.alice : null}) returning id
        `;
        await pool`insert into batch_target (org_id, batch_id, key, position, repo, branch)
                   values (${org}, ${batch!.id}, 't', 0, 'acme/app', 'main')`;
        await pool`insert into batch_stage (org_id, batch_id, key, position, policy)
                   values (${org}, ${batch!.id}, 's', 0, 'human')`;
        await pool`
            insert into batch_task (org_id, batch_id, key, stage_key, position, target_key, objective, acceptance,
                                    verification, agent_type, agent_model)
            values (${org}, ${batch!.id}, 'k', 's', 0, 't', 'o', 'a', 'v', 'claude-code', 'm-9')
        `;
        if (started) {
            await pool`update batch set status = 'started', started_at = now(), deadline_at = now() + interval '1 day' where org_id = ${org} and id = ${batch!.id}`;
            await pool`alter table batch_task disable trigger batch_task_immutable`;
            await pool`update batch_task set execution = ${execution} where org_id = ${org} and batch_id = ${batch!.id}`;
            await pool`alter table batch_task enable trigger batch_task_immutable`;
        }
        return batch!.id;
    };
    launchedBatch = await taskBatch(true, 'running');
    draftBatch = await taskBatch(false, 'pending');

    // A workflow round that was already woken.
    wokenRound = randomUUID();
    await pool`insert into job (org_id, id, command, root_job_id, created_by, execution_user_id, status)
               values (${org}, ${wokenRound}, 'work', ${wokenRound}, ${ids.alice}, ${ids.alice}, 'succeeded')`;
    await pool`insert into workflow_wait (org_id, root_job_id, reason, repo, pr_number)
               values (${org}, ${wokenRound}, 'review', 'acme/app', 1)`;
    await pool`insert into workflow_round (org_id, root_job_id, workflow_node, round, repo, pr_number, command,
                                           parent_job_id, agent_type, agent_model, woken_at, job_id, delivery_count)
               values (${org}, ${wokenRound}, 'review', 1, 'acme/app', 1, 'continue', ${wokenRound}, 'opencode', 'm-10', now(), ${wokenRound}, 1)`;

    profileJob = randomUUID();
    await pool`insert into job (org_id, id, command, root_job_id, created_by, executor, executor_scope, agent_model)
               values (${org}, ${profileJob}, 'work', ${profileJob}, ${ids.bob}, 'other', 'user', 'm-5')`;

    await pool.unsafe(readFileSync(new URL(VERSION, DIR), 'utf8'));
});

afterAll(async () => {
    if (!enabled) return;
    await pool.end();
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.end();
});

const tableExists = async (name: string): Promise<boolean> => {
    const [row] = await pool<{ found: boolean }[]>`
        select to_regclass(${`${schema}.${name}`}) is not null as found
    `;
    return row!.found;
};

const columns = async (table: string): Promise<string[]> =>
    (
        await pool<{ column_name: string }[]>`
            select column_name from information_schema.columns
            where table_schema = ${schema} and table_name = ${table} and column_name in ('agent_type', 'agent_model')
            order by column_name
        `
    ).map((row) => row.column_name);

type JobRow = { status: string; executor: string | null; executor_scope: string | null; output: string | null };
const jobOf = async (id: string, of = org): Promise<JobRow> => {
    const [row] = await pool<JobRow[]>`
        select status, executor, executor_scope, output from job where org_id = ${of} and id = ${id}
    `;
    return row!;
};

type TaskRow = {
    execution: string;
    attention: string | null;
    wait_reason: string | null;
    executor: string | null;
    executor_scope: string | null;
};
const taskOf = async (batch: string, of = org): Promise<TaskRow> => {
    const [row] = await pool<TaskRow[]>`
        select execution, attention, wait_reason, executor, executor_scope from batch_task
        where org_id = ${of} and batch_id = ${batch}
    `;
    return row!;
};

type RoundRow = { executor: string | null; executor_scope: string | null };
const roundOf = async (root: string): Promise<RoundRow> => {
    const [row] = await pool<RoundRow[]>`
        select executor, executor_scope from workflow_round where org_id = ${org} and root_job_id = ${root}
    `;
    return row!;
};

const waitOf = async (root: string, of = org) => {
    const [row] = await pool<{ cancelled_at: Date | null; terminal_reason: string | null }[]>`
        select cancelled_at, terminal_reason from workflow_wait where org_id = ${of} and root_job_id = ${root}
    `;
    return row!;
};

describe.runIf(enabled)('172: the agent default is dropped', () => {
    it('drops agent_default and user_executor_default', async () => {
        expect(await tableExists('agent_default')).toBe(false);
        expect(await tableExists('user_executor_default')).toBe(false);
        expect(await tableExists('executor_default_selection')).toBe(true);
    });

    it.each(['job', 'batch_task', 'workflow_round'])(
        'drops agent_type from %s and keeps agent_model',
        async (table) => {
            expect(await columns(table)).toEqual(['agent_model']);
            const checks = await pool<{ name: string }[]>`
            select c.conname as name from pg_constraint c
            join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
            where n.nspname = ${schema} and t.relname = ${table} and c.conname like '%agent_type%'
        `;
            expect(checks).toEqual([]);
        }
    );

    it('moves a queued agent-default job onto the member configured default, personal before org', async () => {
        expect(await jobOf(seeded.alice.job)).toMatchObject({
            status: 'queued',
            executor: 'mine',
            executor_scope: 'user',
        });
        expect(await jobOf(seeded.bob.job)).toMatchObject({
            status: 'queued',
            executor: 'shared',
            executor_scope: 'org',
        });
    });

    it('moves a pending agent-default batch task onto the member configured default', async () => {
        expect(await taskOf(seeded.alice.batch)).toMatchObject({
            execution: 'pending',
            executor: 'mine',
            executor_scope: 'user',
        });
        expect(await taskOf(seeded.bob.batch)).toMatchObject({
            execution: 'pending',
            executor: 'shared',
            executor_scope: 'org',
        });
    });

    it('moves a parked agent-default workflow round onto the member configured default', async () => {
        expect(await roundOf(seeded.alice.round)).toEqual({ executor: 'mine', executor_scope: 'user' });
        expect(await roundOf(seeded.bob.round)).toEqual({ executor: 'shared', executor_scope: 'org' });
        expect((await waitOf(seeded.alice.round)).cancelled_at).toBeNull();
    });

    it('ends a queued job with no configured default, failed, with the named reason', async () => {
        const job = await jobOf(seeded.carol.job, bareOrg);
        expect(job).toMatchObject({ status: 'failed', executor: null });
        expect(job.output).toContain(REASON);
    });

    it('ends a pending batch task with no configured default, refused, with the named reason', async () => {
        expect(await taskOf(seeded.carol.batch, bareOrg)).toMatchObject({
            execution: 'failed',
            attention: 'refused',
            wait_reason: REASON,
            executor: null,
        });
    });

    it('cancels a parked round with no configured default, with the named reason', async () => {
        const wait = await waitOf(seeded.carol.round, bareOrg);
        expect(wait.cancelled_at).toBeInstanceOf(Date);
        expect(wait.terminal_reason).toBe(REASON);
    });

    it('stamps started, finished and parked agent-default jobs too: a follow-up or takeover copies the executor', async () => {
        for (const id of [runningJob, finishedJob, stoppedJob]) {
            expect(await jobOf(id)).toMatchObject({ executor: 'mine', executor_scope: 'user' });
        }
        expect((await jobOf(runningJob)).status).toBe('running');
        expect((await jobOf(finishedJob)).status).toBe('succeeded');
        expect(await jobOf(carolFinishedJob, bareOrg)).toMatchObject({ status: 'succeeded', executor: null });
        expect(await jobOf(carolRunningJob, bareOrg)).toMatchObject({ status: 'running', executor: null });
    });

    it('stamps a launched batch task and a woken workflow round, and leaves a draft batch alone', async () => {
        expect(await taskOf(launchedBatch)).toMatchObject({ execution: 'running', executor: 'mine' });
        expect(await taskOf(draftBatch)).toMatchObject({ execution: 'pending', attention: null, executor: null });
        expect(await roundOf(wokenRound)).toEqual({ executor: 'mine', executor_scope: 'user' });
    });

    it('leaves work that names a profile alone', async () => {
        expect(await jobOf(profileJob)).toMatchObject({ status: 'queued', executor: 'other', executor_scope: 'user' });
    });

    // The claim is the consumer of the stamp: a row left without an executor is refused (noExecutorMessage). These pin
    // that the work minted from a pre-172 agent-default row claims on the stamped executor.
    const claimOf = async (id: string): Promise<Claim> => {
        const store = createJobStore({
            sql: pool,
            orgId: org,
            executorConfig: createUserExecutorStore({ sql: pool, orgId: org, ...testSecretDeps(pool) }),
        });
        for (let i = 0; i < 20; i++) {
            const claim = await store.claim('w-172', 300);
            if (claim === null) break;
            if (claim.id === id) return claim;
        }
        throw new Error(`job ${id} was never claimed`);
    };

    it('a follow-up on a finished pre-172 agent-default thread claims with the stamped executor', async () => {
        const store = createJobStore({
            sql: pool,
            orgId: org,
            executorConfig: createUserExecutorStore({ sql: pool, orgId: org, ...testSecretDeps(pool) }),
        });
        const followUp = await store.createFollowUp(finishedJob, 'adjust', ids.alice);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);
        expect(await jobOf(followUp.id)).toMatchObject({ executor: 'mine', executor_scope: 'user' });
        const claim = await claimOf(followUp.id);
        expect(claim.executorType).toBe('claude-code');
        expect(claim.noExecutor).toBeUndefined();
    });

    it('a takeover of a running pre-172 agent-default job claims with the stamped executor', async () => {
        // The runner is lost: the running row's lease has expired, so the claim is a takeover.
        await pool`update job set lease_expires_at = now() - interval '1 minute' where org_id = ${org} and id = ${runningJob}`;
        const first = await claimOf(runningJob);
        expect(first.executorType).toBe('claude-code');
        await pool`update job set lease_expires_at = now() - interval '1 minute' where org_id = ${org} and id = ${runningJob}`;
        const takeover = await claimOf(runningJob);
        expect(takeover.executorType).toBe('claude-code');
        expect(takeover.leaseToken).not.toBe(first.leaseToken);
    });
});
