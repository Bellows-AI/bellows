import { githubRepo, type RepoRef } from '@factory-ai/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore, EnvScopeRefusal, type EnvVarStore } from '../src/db/env-var-store.js';
import { EnvSecretError, envSecretIdentity } from '../src/db/env-secrets.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { Claim } from '../src/db/jobs/job-store-types.js';
import { createWorkflowStore } from '../src/db/workflows/workflow-store.js';
import { testSecretStore } from './env-secrets-harness.js';
import { mustCreate, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { MutableKeys } from './secrets-postgres-harness.js';

/**
 * The repo scope of env vars and workflows is the repository triple (forge, host, path), against a real database.
 * Each isolation case moves the forge and the host independently, so each predicate is proven on its own. No edge
 * creates a non-GitHub scope yet, so the other repositories here are made by calling the stores with a ref.
 */

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const LEASE_SECONDS = 300;

const db = useTestDb({ orgs: [ORG], users: [ALICE_USER] });

const GITHUB = githubRepo('o/n');
/** Same path, another forge on the same host; same path, another host on the same forge. */
const SAME_PATH: { name: string; repo: RepoRef }[] = [
    { name: 'another forge, same host', repo: { forge: 'gitlab', host: 'github.com', path: 'o/n' } },
    { name: 'another host, same forge', repo: { forge: 'github', host: 'gl.example', path: 'o/n' } },
];
/** A GitLab nested group: the repo scope's columns hold two segments, so it has no repo scope. */
const NESTED: RepoRef = { forge: 'gitlab', host: 'gl.example', path: 'g/sub/p' };

let sql: Sql;
let envs: EnvVarStore;
let workflows: ReturnType<typeof createWorkflowStore>;
let keys: MutableKeys;

const envStore = (): EnvVarStore =>
    createEnvVarStore({ sql, orgId: ORG, secrets: testSecretStore(sql, keys), secretLog: () => {} });

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    keys = new MutableKeys();
    envs = envStore();
    workflows = createWorkflowStore({ sql, orgId: ORG });
});

const var_ = (name: string, value = 'v', isSecret = false) => ({ name, value, isSecret });

const rowsOf = (table: 'env_var' | 'workflow') =>
    sql<{ forge: string; host: string; repo_owner: string; repo_name: string; name: string }[]>`
        select forge, host, repo_owner, repo_name, name from ${sql(table)}
        where org_id = ${ORG} and repo_owner is not null order by name
    `;

const rejection = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
        () => undefined,
        (e: unknown) => e
    );

describe.skipIf(!enabled)('the env var repo scope is the repository triple', () => {
    it.each(SAME_PATH)('does not resolve a GitHub repo var for $name', async ({ repo }) => {
        await envs.replaceRepo('admin', GITHUB, [var_('LEVEL')]);

        expect(await envs.resolveFor({ userId: null, repo })).toEqual({});
        expect(await envs.namesFor({ userId: null, repo })).toEqual([]);
        expect(await envs.resolveFor({ userId: null, repo: GITHUB })).toEqual({ LEVEL: 'v' });
        expect(await envs.namesFor({ userId: null, repo: GITHUB })).toEqual(['LEVEL']);
    });

    it.each(SAME_PATH)('writes $name with its forge and host and leaves the GitHub scope alone', async ({ repo }) => {
        await envs.replaceRepo('admin', GITHUB, [var_('ON_GITHUB')]);

        await envs.replaceRepo('admin', repo, [var_('ELSEWHERE')]);

        expect(await rowsOf('env_var')).toEqual([
            { forge: repo.forge, host: repo.host, repo_owner: 'o', repo_name: 'n', name: 'ELSEWHERE' },
            { forge: 'github', host: 'github.com', repo_owner: 'o', repo_name: 'n', name: 'ON_GITHUB' },
        ]);
        expect((await envs.listRepo(GITHUB)).map((row) => row.name)).toEqual(['ON_GITHUB']);
        expect((await envs.listRepo(repo)).map((row) => row.name)).toEqual(['ELSEWHERE']);
        expect(await envs.listRepos()).toEqual([
            { repo: GITHUB, vars: [expect.objectContaining({ name: 'ON_GITHUB' })] },
            { repo, vars: [expect.objectContaining({ name: 'ELSEWHERE' })] },
        ]);

        await envs.replaceRepo('admin', repo, []);

        expect((await envs.listRepo(GITHUB)).map((row) => row.name)).toEqual(['ON_GITHUB']);
    });

    it.each(SAME_PATH)('writes single names of $name without touching the GitHub scope', async ({ repo }) => {
        await envs.replaceRepo('admin', GITHUB, [var_('ON_GITHUB')]);

        await envs.writeScoped({ kind: 'repo', repo }, { upsert: [var_('ELSEWHERE')], remove: ['ON_GITHUB'] }, 'admin');

        expect((await envs.listRepo(GITHUB)).map((row) => row.name)).toEqual(['ON_GITHUB']);
        expect((await envs.listRepo(repo)).map((row) => row.name)).toEqual(['ELSEWHERE']);
    });

    it('has no repo level for a nested path: it resolves none and a write is refused', async () => {
        await envs.replaceOrg('admin', [var_('ORG_LEVEL')]);
        await envs.replaceRepo('admin', githubRepo('g/sub'), [var_('SUB_LEVEL')]);

        expect(await envs.resolveFor({ userId: null, repo: NESTED })).toEqual({ ORG_LEVEL: 'v' });
        expect(await envs.namesFor({ userId: null, repo: NESTED })).toEqual(['ORG_LEVEL']);
        expect(await rejection(envs.replaceRepo('admin', NESTED, [var_('X')]))).toBeInstanceOf(EnvScopeRefusal);
        expect(
            await rejection(
                envs.writeScoped({ kind: 'repo', repo: NESTED }, { upsert: [var_('X')], remove: [] }, 'admin')
            )
        ).toBeInstanceOf(EnvScopeRefusal);
        expect(await envs.listRepo(NESTED)).toEqual([]);
        expect((await rowsOf('env_var')).map((row) => row.name)).toEqual(['SUB_LEVEL']);
    });

    it('keeps a GitHub repo secret byte-identical in identity, readable after the change', async () => {
        await envs.replaceRepo('admin', GITHUB, [var_('SECRET', 'shh', true)]);

        expect(envSecretIdentity(ORG, { kind: 'repo', repo: GITHUB }, 'SECRET').scope).toEqual({
            type: 'repository',
            id: 'o/n',
        });
        expect(await envs.resolveFor({ userId: null, repo: GITHUB })).toEqual({ SECRET: 'shh' });
    });

    it.each(SAME_PATH)('refuses a secret reference copied to $name', async ({ repo }) => {
        await envs.replaceRepo('admin', GITHUB, [var_('SECRET', 'shh', true)]);
        await sql`update env_var set forge = ${repo.forge}, host = ${repo.host} where org_id = ${ORG} and name = 'SECRET'`;

        const error = await rejection(envs.resolveFor({ userId: null, repo }));

        expect(error).toBeInstanceOf(EnvSecretError);
        expect(error).toMatchObject({ envName: 'SECRET', code: 'identity-mismatch' });
        expect((error as Error).message).not.toContain('shh');
    });
});

describe.skipIf(!enabled)('a claim resolves the repo level by the job repository triple', () => {
    const claimOf = async (repo: RepoRef | null): Promise<Claim> => {
        const jobs = createJobStore({ sql, orgId: ORG, env: envs });
        await mustCreate(jobs.create('echo hi', null, { repo, executor: null }));
        return (await jobs.claim('driver-1', LEASE_SECONDS)) as Claim;
    };

    it('carries a GitHub repo var to a GitHub job, and an org var to a repo-less one', async () => {
        await envs.replaceOrg('admin', [var_('ORG_LEVEL')]);
        await envs.replaceRepo('admin', GITHUB, [var_('LEVEL')]);

        expect((await claimOf(GITHUB)).env).toEqual({ ORG_LEVEL: 'v', LEVEL: 'v' });
        expect((await claimOf(null)).env).toEqual({ ORG_LEVEL: 'v' });
    });

    it.each(SAME_PATH)('does not carry a GitHub repo var to a job on $name', async ({ repo }) => {
        await envs.replaceOrg('admin', [var_('ORG_LEVEL')]);
        await envs.replaceRepo('admin', GITHUB, [var_('LEVEL')]);

        expect((await claimOf(repo)).env).toEqual({ ORG_LEVEL: 'v' });
    });
});

const definition = {
    entry: 'first',
    params: [],
    nodes: [
        { name: 'first', kind: 'agent', session: 'resume', prompt: 'do {{second.output}}' },
        { name: 'second', kind: 'agent', session: 'fresh', prompt: 'check', publish: true },
    ],
    edges: [
        { from: 'first', to: 'second', when: 'succeeded' },
        { from: 'second', to: 'first', when: { marker: 'DONE' }, max: 2 },
    ],
};

const createWorkflow = (name: string, repo: RepoRef) =>
    workflows.create({ name, scope: { kind: 'repo', repo }, definition, createdBy: ALICE });

describe.skipIf(!enabled)('the workflow repo scope is the repository triple', () => {
    it.each(SAME_PATH)('does not resolve a GitHub repo workflow for $name', async ({ repo }) => {
        expect(await createWorkflow('wf', GITHUB)).toHaveProperty('id');

        expect(await workflows.listVisible({ userId: ALICE, repo })).toEqual([]);
        expect(await workflows.findByName('wf', { userId: ALICE, repo })).toBeNull();
        expect((await workflows.listVisible({ userId: ALICE, repo: GITHUB })).map((row) => row.name)).toEqual(['wf']);
        expect((await workflows.findByName('wf', { userId: ALICE, repo: GITHUB }))?.repo).toEqual(GITHUB);
    });

    it.each(SAME_PATH)(
        'stores $name with its forge and host and resolves it for that repository only',
        async ({ repo }) => {
            expect(await createWorkflow('on-github', GITHUB)).toHaveProperty('id');
            expect(await createWorkflow('elsewhere', repo)).toHaveProperty('id');

            expect(await rowsOf('workflow')).toEqual([
                { forge: repo.forge, host: repo.host, repo_owner: 'o', repo_name: 'n', name: 'elsewhere' },
                { forge: 'github', host: 'github.com', repo_owner: 'o', repo_name: 'n', name: 'on-github' },
            ]);
            expect((await workflows.listVisible({ userId: ALICE, repo })).map((row) => row.name)).toEqual([
                'elsewhere',
            ]);
            expect(await workflows.findByName('on-github', { userId: ALICE, repo })).toBeNull();
        }
    );

    it('has no repo level for a nested path: it resolves none and a create is refused BAD_SCOPE', async () => {
        expect(
            await workflows.create({ name: 'org-wf', scope: { kind: 'org' }, definition, createdBy: ALICE })
        ).toHaveProperty('id');

        expect(await createWorkflow('nested', NESTED)).toMatchObject({ refused: true, code: 'BAD_SCOPE' });
        expect((await workflows.listVisible({ userId: ALICE, repo: NESTED })).map((row) => row.name)).toEqual([
            'org-wf',
        ]);
    });
});
