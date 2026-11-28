import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { type AuthStore, createAuthStore } from '../src/auth/store.js';
import { createOrgRegistry, type OrgRegistry } from '../src/orgs.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { testSecretStore } from './env-secrets-harness.js';
import { randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The model setup through the real app, org registry and stores (docs/api.md): saving a setup creates the executor,
 * selects it as the default and answers its identity; the first task, a member's task and every later default launch
 * resolve through that executor, and no answer carries the key.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const CREATED = 201;
const FORBIDDEN = 403;
const CONFLICT = 409;
const LEASE_SECONDS = 300;
const REPO = 'setup-owner/web';
const KEY_A = 'sk-ant-routes-setup-A-0123456789abcdef';
const KEY_B = 'sk-openai-routes-setup-B-0123456789abcdef';

interface Person {
    userId: string;
    token: string;
}

let sql: Sql;
let auth: AuthStore;
let app: FastifyInstance;
let orgs: OrgRegistry;
let org: string;
let admin: Person;
let member: Person;

async function personIn(orgId: string): Promise<Person> {
    const login = `u-${randomUUID().slice(0, 8)}`;
    const caller = await auth.signIn(
        { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null },
        orgId,
        [{ id: orgId, name: `acct-${orgId}` }]
    );
    const token = `fat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'personal',
        orgId,
        userId: caller.user.id,
        createdBy: caller.user.id,
        label: 'model setup',
        tokenHash: hashToken(token),
    });
    return { userId: caller.user.id, token };
}

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    auth = createAuthStore({ sql });
    org = testOrg();
    admin = await personIn(org);
    member = await personIn(org);
    await sql`insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
              values (${org}, 'claude-code', ${`ms-${randomUUID()}`}, ${REPO}, 'main', now(), now())`;
    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth() });
    orgs = createOrgRegistry({
        sql,
        ready,
        config,
        withStores: true,
        secrets: testSecretStore(sql),
        secretLog: () => {},
    });
    app = await buildApp({ config, orgs, auth, ready, version: '0.0.0' });
});

afterEach(async () => {
    if (enabled) await app?.close();
});

const call = async (who: Person, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${who.token}` },
        ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, json: response.json(), body: response.body };
};

const orgBody = (over: Record<string, unknown> = {}) => ({
    scope: 'org',
    requestId: randomUUID(),
    agentType: 'claude-code',
    model: 'claude-sonnet-4-5',
    connection: { intent: 'create', provider: 'anthropic', key: KEY_A, name: 'Anthropic' },
    executor: { name: 'Claude' },
    ...over,
});
const save = (who: Person, body: object) => call(who, 'PUT', '/api/model-setup', body);
const launch = async (who: Person, extra: object = {}) => {
    const created = await call(who, 'POST', '/api/jobs', { repo: REPO, command: 'work', ...extra });
    expect(created.status).toBe(CREATED);
    return created;
};
const claim = async (worker: string) => (await orgs.for(org))!.jobs!.claim(worker, LEASE_SECONDS);

describe.skipIf(!enabled)('the model setup routes', () => {
    it('onboarding save first task and claim use the returned executor', async () => {
        const saved = await save(admin, orgBody());
        expect(saved.status).toBe(OK);
        expect(saved.json).toMatchObject({ saved: true, scope: 'org', replayed: false });
        expect(saved.json.executorId).toEqual(expect.any(String));
        expect(saved.json.connectionId).toEqual(expect.any(String));
        expect(saved.body).not.toContain(KEY_A);

        // The setup survives a reload: the executor, the default and the effective view all read it back.
        const workspace = await call(admin, 'GET', '/api/workspace');
        expect(workspace.json.orgExecutors.map((e: { id: string }) => e.id)).toEqual([saved.json.executorId]);
        expect(workspace.json.defaultExecutor).toEqual({ scope: 'org', name: 'Claude' });
        const view = await call(admin, 'GET', '/api/model-setup');
        expect(view.json.effective).toBe('executor');
        expect(view.json.selected).toMatchObject({
            scope: 'org',
            executorId: saved.json.executorId,
            agentType: 'claude-code',
            model: 'claude-sonnet-4-5',
            connection: { id: saved.json.connectionId, provider: 'anthropic', scope: 'org' },
        });
        expect(view.body).not.toContain(KEY_A);

        await launch(admin);
        const claimed = await claim('w1');
        expect(claimed?.executorType).toBe('claude-code');
        expect(claimed?.env?.ANTHROPIC_API_KEY).toBe(KEY_A);
        expect((await sql`select 1 from env_var where org_id = ${org}`).length).toBe(0);
    });

    it('another member discovers and runs organization setup without receiving its key', async () => {
        const saved = await save(admin, orgBody());
        const workspace = await call(member, 'GET', '/api/workspace');
        expect(workspace.json.orgExecutors.map((e: { id: string }) => e.id)).toEqual([saved.json.executorId]);
        expect(workspace.body).not.toContain(KEY_A);
        const view = await call(member, 'GET', '/api/model-setup');
        expect(view.json.effective).toBe('executor');
        expect(view.body).not.toContain(KEY_A);

        await launch(member);
        const claimed = await claim('w1');
        expect(claimed?.env?.ANTHROPIC_API_KEY).toBe(KEY_A);
    });

    it('a member cannot create or change an organization setup or use another members personal connection', async () => {
        const refused = await save(member, orgBody());
        expect(refused.status).toBe(FORBIDDEN);

        const mine = await save(
            admin,
            orgBody({
                scope: 'personal',
                connection: { intent: 'create', provider: 'anthropic', key: KEY_A, name: 'Mine' },
            })
        );
        expect(mine.status).toBe(OK);
        const theirs = await save(
            member,
            orgBody({
                scope: 'personal',
                connection: { intent: 'reuse', id: mine.json.connectionId },
                executor: { name: 'Stolen' },
            })
        );
        expect([404, CONFLICT]).toContain(theirs.status);
        const rotate = await save(
            member,
            orgBody({
                scope: 'org',
                connection: { intent: 'rotate', id: mine.json.connectionId, key: KEY_B },
            })
        );
        expect(rotate.status).toBe(FORBIDDEN);
        expect((await call(member, 'GET', '/api/workspace')).json.executors).toEqual([]);
    });

    it('an older tab cannot overwrite a newer save: the read carries the revision and an edit or a rotation sends it', async () => {
        const first = await save(admin, orgBody());
        const stale = (await call(admin, 'GET', '/api/model-setup')).json.selected.updatedAt;
        expect(typeof stale).toBe('string');
        const edit = (model: string, expectedUpdatedAt: string) =>
            save(
                admin,
                orgBody({
                    model,
                    connection: { intent: 'reuse', id: first.json.connectionId },
                    executor: { id: first.json.executorId, expectedUpdatedAt },
                })
            );
        // Another tab saves a new model; the older tab's edit and rotation both read `stale` and are refused.
        expect((await edit('claude-opus-4-5', stale)).status).toBe(OK);
        const lateEdit = await edit('claude-sonnet-4-5', stale);
        expect(lateEdit.status).toBe(CONFLICT);
        expect(lateEdit.json.code).toBe('MODEL_SETUP_CONFLICT');
        const lateRotation = await save(
            admin,
            orgBody({
                connection: { intent: 'rotate', id: first.json.connectionId, key: KEY_B },
                executor: { id: first.json.executorId, expectedUpdatedAt: stale },
            })
        );
        expect(lateRotation.status).toBe(CONFLICT);
        const view = (await call(admin, 'GET', '/api/model-setup')).json;
        expect(view.selected.model).toBe('claude-opus-4-5');
        // The fresh revision the read now carries is accepted.
        expect((await edit('claude-sonnet-4-5', view.selected.updatedAt)).status).toBe(OK);
    });

    describe('the executor cap', () => {
        const CAP = 10;
        const TOO_MANY = 400;
        /** Executors on the first save's connection, so only executors count toward the cap. */
        async function fill(count: number) {
            const first = await save(admin, orgBody());
            expect(first.status).toBe(OK);
            const reuse = { intent: 'reuse', id: first.json.connectionId };
            const bodies = Array.from({ length: count - 1 }, (_, i) =>
                orgBody({ connection: reuse, executor: { name: `Executor ${i + 2}` } })
            );
            for (const body of bodies) expect((await save(admin, body)).status).toBe(OK);
            return { reuse, last: bodies.at(-1) ?? orgBody() };
        }
        const executors = async () =>
            Number((await sql`select count(*) as n from executor_profile where org_id = ${org}`)[0]!.n);

        it('a create that took the last slot replays its saved result when its response is lost', async () => {
            const { last } = await fill(CAP);
            const retried = await save(admin, last);
            expect(retried.status).toBe(OK);
            expect(retried.json.replayed).toBe(true);
            expect(await executors()).toBe(CAP);
            // A different create is still refused at the cap.
            const refused = await save(admin, orgBody({ executor: { name: 'One too many' } }));
            expect(refused.status).toBe(TOO_MANY);
            expect(refused.json.code).toBe('TOO_MANY_EXECUTORS');
        });

        it('two creates racing for the last slot leave exactly one executor more', async () => {
            const { reuse } = await fill(CAP - 1);
            const results = await Promise.all(
                ['Racer one', 'Racer two'].map((name) =>
                    save(admin, orgBody({ connection: reuse, executor: { name } }))
                )
            );
            expect(results.map((r) => r.status).sort()).toEqual([OK, TOO_MANY]);
            expect(await executors()).toBe(CAP);
        });
    });

    it('a saved model is the one that runs, even where the profile pins its model through env', async () => {
        const first = await save(admin, orgBody());
        await sql`
            update executor_profile set config = config || '{"env": {"ANTHROPIC_MODEL": "claude-sonnet-4-5", "KEEP_ME": "1"}}'::jsonb
            where org_id = ${org} and id = ${first.json.executorId}
        `;
        const edited = await save(
            admin,
            orgBody({
                model: 'claude-opus-4-5',
                connection: { intent: 'reuse', id: first.json.connectionId },
                executor: { id: first.json.executorId },
            })
        );
        expect(edited.status).toBe(OK);
        expect((await call(admin, 'GET', '/api/model-setup')).json.selected.model).toBe('claude-opus-4-5');

        await launch(admin);
        const claimed = await claim('w-model');
        expect(claimed?.env?.ANTHROPIC_MODEL).toBe('claude-opus-4-5');
        const [row] =
            await sql`select config from executor_profile where org_id = ${org} and id = ${first.json.executorId}`;
        expect(row!.config.env).toEqual({ ANTHROPIC_MODEL: 'claude-opus-4-5', KEEP_ME: '1' });
    });

    it('personal onboarding yields a personal connection executor and default', async () => {
        const saved = await save(
            member,
            orgBody({
                scope: 'personal',
                connection: { intent: 'create', provider: 'anthropic', key: KEY_A, name: 'Mine' },
            })
        );
        expect(saved.status).toBe(OK);
        const workspace = await call(member, 'GET', '/api/workspace');
        expect(workspace.json.executors.map((e: { id: string }) => e.id)).toEqual([saved.json.executorId]);
        expect(workspace.json.defaultExecutor).toEqual({ scope: 'user', name: 'Claude' });
        await launch(member);
        expect((await claim('w1'))?.env?.ANTHROPIC_API_KEY).toBe(KEY_A);
        // The administrator sees none of it.
        expect((await call(admin, 'GET', '/api/workspace')).json.executors).toEqual([]);
        expect((await call(admin, 'GET', '/api/model-setup')).json.effective).toBeNull();
    });

    it('a retried request replays its receipt', async () => {
        const body = orgBody();
        const [one, two] = await Promise.all([save(admin, body), save(admin, body)]);
        expect([one.status, two.status]).toEqual([OK, OK]);
        expect(one.json.executorId).toBe(two.json.executorId);
        expect(one.json.connectionId).toBe(two.json.connectionId);
        expect((await sql`select 1 from provider_connection where org_id = ${org}`).length).toBe(1);
    });

    it('a name collision is a clear refusal and the first credential survives', async () => {
        const first = await save(admin, orgBody());
        const second = await save(
            admin,
            orgBody({
                connection: { intent: 'create', provider: 'anthropic', key: KEY_B, name: 'Anthropic' },
                executor: { name: 'Other' },
            })
        );
        expect(second.status).toBe(CONFLICT);
        expect(second.json.code).toBe('NAME_TAKEN');
        expect(second.body).not.toContain(KEY_B);
        await launch(admin);
        expect((await claim('w1'))?.env?.ANTHROPIC_API_KEY).toBe(KEY_A);
        expect(first.json.connectionId).toEqual(expect.any(String));
    });

    it('API default launches, preflight and the workspace agree, and an explicit executor still wins', async () => {
        const first = await save(admin, orgBody());
        const second = await save(
            admin,
            orgBody({
                agentType: 'opencode',
                model: 'gpt-5',
                connection: { intent: 'create', provider: 'openai', key: KEY_B, name: 'OpenAI' },
                executor: { name: 'GPT' },
            })
        );
        expect(second.status).toBe(OK);

        const preflight = await call(admin, 'POST', '/api/jobs/preflight', { repo: REPO });
        expect(preflight.status).toBe(OK);
        expect(preflight.json.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ subject: 'executor', name: 'GPT', status: 'ok' }),
                expect.objectContaining({ subject: 'model', status: 'ok' }),
            ])
        );
        expect((await call(admin, 'GET', '/api/workspace')).json.defaultExecutor).toEqual({
            scope: 'org',
            name: 'GPT',
        });

        // A task queued under the first default stays on it; later defaults and explicit names go their own way.
        await launch(admin);
        await launch(admin, { executor: 'Claude', executorScope: 'org' });
        const claims = [await claim('w1'), await claim('w2')];
        const byType = (type: string) => claims.find((c) => c?.executorType === type);
        expect(byType('opencode')?.env?.OPENAI_API_KEY).toBe(KEY_B);
        expect(byType('claude-code')?.env?.ANTHROPIC_API_KEY).toBe(KEY_A);
        expect(first.json.executorId).not.toBe(second.json.executorId);

        // Switching the default back changes future launches only: the queued task keeps the executor it was stamped with.
        await launch(admin);
        const [queued] = await sql<{ executor: string }[]>`
            select executor from job where org_id = ${org} order by created_at desc limit 1
        `;
        expect(queued!.executor).toBe('GPT');
        const back = await save(
            admin,
            orgBody({
                connection: { intent: 'reuse', id: first.json.connectionId },
                executor: { id: first.json.executorId, name: 'Claude' },
            })
        );
        expect(back.json.executorId).toBe(first.json.executorId);
        const [stillQueued] = await sql<{ executor: string }[]>`
            select executor from job where org_id = ${org} order by created_at desc limit 1
        `;
        expect(stillQueued!.executor).toBe('GPT');
        expect((await call(admin, 'GET', '/api/workspace')).json.defaultExecutor).toEqual({
            scope: 'org',
            name: 'Claude',
        });
    });

    it('a key in the org env without a configured executor shows as the org setup', async () => {
        const runtime = (await orgs.for(org))!;
        await runtime.envVars!.writeScoped(
            { kind: 'org' },
            { upsert: [{ name: 'ANTHROPIC_API_KEY', value: KEY_A, isSecret: true }], remove: [] },
            admin.userId
        );

        const view = await call(member, 'GET', '/api/model-setup');
        expect(view.json.effective).toBe('org');
        expect(view.json.selected ?? null).toBeNull();
        expect(view.json.org).toMatchObject({ provider: 'anthropic', keyNames: ['ANTHROPIC_API_KEY'] });
        expect((await sql`select 1 from executor_default_selection where org_id = ${org}`).length).toBe(0);
    });

    it('a none intent is refused and writes nothing', async () => {
        const refused = await save(admin, orgBody({ connection: { intent: 'none' } }));
        expect(refused.status).toBe(400);
        expect((await sql`select 1 from executor_profile where org_id = ${org}`).length).toBe(0);
    });

    it('an invalid provider and runtime combination is refused and leaves the prior setup', async () => {
        const first = await save(admin, orgBody());
        const bad = await save(
            admin,
            orgBody({
                agentType: 'claude-code',
                connection: { intent: 'create', provider: 'openai', key: KEY_B, name: 'OpenAI' },
                executor: { name: 'Bad' },
            })
        );
        expect(bad.status).toBe(400);
        expect((await call(admin, 'GET', '/api/model-setup')).json.selected.executorId).toBe(first.json.executorId);
        expect((await sql`select 1 from provider_connection where org_id = ${org}`).length).toBe(1);
    });
});
