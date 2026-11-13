import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { type AuthStore, createAuthStore } from '../src/auth/store.js';
import { createOrgRegistry } from '../src/orgs.js';
import { githubAuth, testConfig } from '../test/helpers-config.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretDeps, testSecretStore } from './env-secrets-harness.js';
import { randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * The operator surface (docs/organizations.md): `OPERATOR_GITHUB_IDS` names who may list every organization and
 * suspend, refuse or reactivate one; anyone else, an org admin included, is refused 403 before the handler runs.
 * Each change writes one `operator` audit row in the target org, and a suspended or refused org's member is refused a
 * create with 403 `ORG_INACTIVE`.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb({ max: 12 });

const OK = 200;
const FORBIDDEN = 403;
const NOT_FOUND = 404;
const CONFLICT = 409;
const CREATED = 201;
const REPO = 'operator-owner/web';
const TASK = { repo: REPO, command: 'work' };

interface Person {
    userId: string;
    githubUserId: number;
    token: string;
}

let sql: Sql;
let auth: AuthStore;
let app: FastifyInstance;
let org: string;
let operatorOrg: string;
let operator: Person;
let admin: Person;

async function personIn(orgId: string): Promise<Person> {
    const githubUserId = randomGithubId();
    const login = `u-${randomUUID().slice(0, 8)}`;
    const caller = await auth.signIn({ githubUserId, login, displayName: login, avatarUrl: null }, orgId, [
        { id: orgId, name: `acct-${orgId}` },
    ]);
    const token = `fat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'personal',
        orgId,
        userId: caller.user.id,
        createdBy: caller.user.id,
        label: 'operator',
        tokenHash: hashToken(token),
    });
    return { userId: caller.user.id, githubUserId, token };
}

async function boot(operatorGithubIds: readonly number[]): Promise<void> {
    const ready = Promise.resolve();
    const config = testConfig({
        auth: githubAuth(),
        deploymentMode: 'cloud',
        planDefaults: { running: 1, queued: 5, wallSeconds: 3600 },
        operatorGithubIds,
    });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({
            sql,
            ready,
            config,
            withStores: true,
            secrets: testSecretStore(sql),
            secretLog: () => {},
        }),
        auth,
        ready,
        version: '0.0.0',
    });
}

beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    auth = createAuthStore({ sql });
    [org, operatorOrg] = [testOrg(), testOrg()];
    // The org's first account is its admin; the operator belongs to an org of its own.
    admin = await personIn(org);
    operator = await personIn(operatorOrg);
    // A task naming no executor runs on the org's one profile.
    await createUserExecutorStore({ sql, orgId: org, ...testSecretDeps(sql) }).createOrg({
        name: 'main',
        type: 'claude-code',
        config: {},
        createdBy: admin.userId,
    });
    // The board refuses a create whose repo it does not track; offline the tracked list is the stored sessions' repos.
    await sql`insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
              values (${org}, 'claude-code', ${`op-${randomUUID()}`}, ${REPO}, 'main', now(), now())`;
    await boot([operator.githubUserId]);
});

afterEach(async () => {
    if (enabled) await app?.close();
});

const call = (who: Person, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${who.token}` },
        ...(payload === undefined ? {} : { payload }),
    });

const operatorRows = (orgId: string) =>
    sql<{ actor_kind: string; actor_id: string; action: string; target: string; detail: Record<string, unknown> }[]>`
        select actor_kind, actor_id, action, target, detail from audit_event
        where org_id = ${orgId} and actor_kind = 'operator' order by at, id
    `;

describe.skipIf(!enabled)('the operator routes', () => {
    it('lists every organization with its status', async () => {
        const res = await call(operator, 'GET', '/api/operator/orgs');
        expect(res.statusCode).toBe(OK);
        expect(res.json().orgs).toEqual(
            expect.arrayContaining([
                { id: org, name: `acct-${org}`, status: 'active' },
                { id: operatorOrg, name: `acct-${operatorOrg}`, status: 'active' },
            ])
        );
    });

    it('suspends: the member’s create is refused 403 ORG_INACTIVE, and one operator audit row is written', async () => {
        const res = await call(operator, 'POST', `/api/operator/orgs/${org}/suspend`);
        expect(res.statusCode).toBe(OK);
        expect(res.json()).toEqual({ changed: true, org: { id: org, name: `acct-${org}`, status: 'suspended' } });

        const create = await call(admin, 'POST', '/api/jobs', TASK);
        expect(create.statusCode).toBe(FORBIDDEN);
        expect(create.json()).toMatchObject({ code: 'ORG_INACTIVE', status: 'suspended' });

        expect(await operatorRows(org)).toEqual([
            {
                actor_kind: 'operator',
                actor_id: operator.userId,
                action: 'org.suspend',
                target: org,
                detail: { from: 'active', to: 'suspended' },
            },
        ]);
    });

    it('refuses until reactivated: a suspend answers 409, an activate admits creates again', async () => {
        expect((await call(operator, 'POST', `/api/operator/orgs/${org}/refuse`)).json()).toMatchObject({
            changed: true,
            org: { status: 'refused' },
        });
        const create = await call(admin, 'POST', '/api/jobs', TASK);
        expect(create.json()).toMatchObject({ code: 'ORG_INACTIVE', status: 'refused' });

        const suspend = await call(operator, 'POST', `/api/operator/orgs/${org}/suspend`);
        expect(suspend.statusCode).toBe(CONFLICT);
        expect(suspend.json()).toMatchObject({ code: 'ORG_INACTIVE', status: 'refused' });

        const activate = await call(operator, 'POST', `/api/operator/orgs/${org}/activate`);
        expect(activate.json()).toMatchObject({ changed: true, org: { status: 'active' } });
        expect((await call(admin, 'POST', '/api/jobs', TASK)).statusCode).toBe(CREATED);
        expect((await operatorRows(org)).map((row) => row.action)).toEqual(['org.refuse', 'org.activate']);
    });

    it('answers a status that already holds unchanged, with no audit row, and 404 for an unknown org', async () => {
        const res = await call(operator, 'POST', `/api/operator/orgs/${org}/activate`);
        expect(res.statusCode).toBe(OK);
        expect(res.json()).toMatchObject({ changed: false, org: { status: 'active' } });
        expect(await operatorRows(org)).toEqual([]);

        const unknown = await call(operator, 'POST', `/api/operator/orgs/${testOrg()}/suspend`);
        expect(unknown.statusCode).toBe(NOT_FOUND);
        expect(unknown.json()).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('refuses 403 to anyone not named, an org admin included, and changes nothing', async () => {
        const routes = [
            ['GET', '/api/operator/orgs'],
            ['POST', `/api/operator/orgs/${org}/suspend`],
            ['POST', `/api/operator/orgs/${org}/refuse`],
            ['POST', `/api/operator/orgs/${org}/activate`],
        ] as const;
        for (const [method, url] of routes) {
            const res = await call(admin, method, url);
            expect(res.statusCode, url).toBe(FORBIDDEN);
            expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
        }
        expect((await sql<{ status: string }[]>`select status from organization where id = ${org}`)[0]?.status).toBe(
            'active'
        );
        expect(await operatorRows(org)).toEqual([]);
    });

    it('has no operator when none is configured', async () => {
        await app.close();
        await boot([]);
        expect((await call(operator, 'GET', '/api/operator/orgs')).statusCode).toBe(FORBIDDEN);
    });
});
