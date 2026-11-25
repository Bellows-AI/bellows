import { githubRepo, type RepoRef } from '@factory-ai/core';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replaceTrackedRepos, trackedRepos } from '../src/db/tracked-repos.js';
import { createRepoSource } from '../src/github/repo-source.js';
import {
    type Board,
    bearer,
    HOST,
    type Harness,
    type Org,
    resetHarness,
    startHarness,
} from './gitlab-board-harness.js';
import { useTestDb } from './harness.js';
import { testOrg } from './fixtures.js';

/**
 * Tracking a GitLab project (docs/gitlab.md): the admin lists the projects under the connection's allowed root
 * groups with their own grant and picks the ones the org tracks. Replacement is scoped to its forge and host, and a
 * mixed repo source lists both forges' tracked repos. The fake GitLab is the only boundary faked.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();
const OK = 200;
const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const CONFLICT = 409;
const UNAVAILABLE = 503;
const PAGE_SIZE = 2;

const gitlab = (path: string, host = HOST): RepoRef => ({ forge: 'gitlab', host, path });
const keys = (repos: readonly RepoRef[]) => repos.map((r) => `${r.forge}:${r.host}/${r.path}`).sort();

let sql: Sql;
let h: Harness & { stop(): Promise<void> };
let board: Board;
let org: Org;
/** A root group of its own per test: the fake keeps every project it was ever given. */
let grp: string;

beforeAll(async () => {
    if (!enabled) return;
    h = await startHarness(() => db.sql);
});
beforeEach(async () => {
    if (!enabled) return;
    sql = db.sql;
    await resetHarness(h, sql);
    org = await h.newOrg();
    grp = `g${randomUUID().slice(0, 8)}`;
    board = await h.board({ api: h.gitlabApi(undefined, { pageSize: PAGE_SIZE }) });
});
afterEach(async () => {
    if (enabled) await board?.close();
});
afterAll(async () => {
    await h?.stop();
});

const project = (path: string) => h.fake.control('gitlab/projects', { path });
const projectsPath = (id: string) => `/api/org/gitlab-connections/${id}/projects`;
const trackedPath = (id: string) => `/api/org/gitlab-connections/${id}/tracked-repos`;
const listProjects = (id: string, token = org.admin) =>
    board.app.inject({ method: 'GET', url: projectsPath(id), headers: bearer(token) });
const track = (id: string, paths: string[], token = org.admin) =>
    board.app.inject({ method: 'PUT', url: trackedPath(id), headers: bearer(token), payload: { paths } });

describe.skipIf(!enabled)('scoped replacement of the tracked repos', () => {
    it('replacing one forge’s selection leaves the other forge’s rows alone, in both directions', async () => {
        const orgId = testOrg();
        await sql`insert into organization (id, name) values (${orgId}, ${orgId})`;
        const github = { forge: 'github', host: 'github.com' } as const;
        const lab = { forge: 'gitlab', host: HOST } as const;
        await replaceTrackedRepos({ sql, orgId, scope: github, repos: [githubRepo('acme/web')] });
        await replaceTrackedRepos({ sql, orgId, scope: lab, repos: [gitlab(`${grp}/api`)] });
        expect(keys(await trackedRepos({ sql, orgId }))).toEqual([
            'github:github.com/acme/web',
            `gitlab:${HOST}/${grp}/api`,
        ]);
        await replaceTrackedRepos({ sql, orgId, scope: github, repos: [githubRepo('acme/other')] });
        expect(keys(await trackedRepos({ sql, orgId }))).toEqual([
            'github:github.com/acme/other',
            `gitlab:${HOST}/${grp}/api`,
        ]);
        await replaceTrackedRepos({ sql, orgId, scope: lab, repos: [] });
        expect(keys(await trackedRepos({ sql, orgId }))).toEqual(['github:github.com/acme/other']);
        expect(keys(await trackedRepos({ sql, orgId, scope: lab }))).toEqual([]);
        expect(keys(await trackedRepos({ sql, orgId, scope: github }))).toEqual(['github:github.com/acme/other']);
    });

    it('refuses a ref outside the scope and writes nothing', async () => {
        const orgId = testOrg();
        await sql`insert into organization (id, name) values (${orgId}, ${orgId})`;
        await replaceTrackedRepos({
            sql,
            orgId,
            scope: { forge: 'gitlab', host: HOST },
            repos: [gitlab(`${grp}/api`)],
        });
        await expect(
            replaceTrackedRepos({
                sql,
                orgId,
                scope: { forge: 'gitlab', host: HOST },
                repos: [gitlab(`${grp}/web`), gitlab(`${grp}/x`, 'other.gitlab.test')],
            })
        ).rejects.toThrow();
        expect(keys(await trackedRepos({ sql, orgId }))).toEqual([`gitlab:${HOST}/${grp}/api`]);
    });
});

describe.skipIf(!enabled)('a mixed repo source', () => {
    const listed = async (tracked: RepoRef[]) => {
        const source = createRepoSource({
            stored: async () => ['acme/web', 'acme/other'],
            allowlist: async () => tracked,
        });
        return { source, repos: await source.list() };
    };
    const names = (repos: readonly { owner: string; name: string; ref?: RepoRef | undefined }[]) =>
        repos.map((r) => (r.ref ? `${r.ref.forge}:${r.ref.host}/${r.ref.path}` : `${r.owner}/${r.name}`));

    it('lists GitLab tracked repos beside GitHub’s, and an unrestricted GitHub installation stays unrestricted', async () => {
        const { repos, source } = await listed([gitlab(`${grp}/api`), gitlab(`${grp}/team/web`)]);
        expect(names(repos)).toEqual([
            'acme/web',
            'acme/other',
            `gitlab:${HOST}/${grp}/api`,
            `gitlab:${HOST}/${grp}/team/web`,
        ]);
        // The stats scope stays GitHub's own names.
        expect(source.snapshotNames()).toEqual(['acme/web', 'acme/other']);
        expect(repos.find((r) => r.ref)?.owner).toBe(grp);
    });

    it('narrows GitHub by its own rows only, and GitLab rows never narrow it', async () => {
        const { repos } = await listed([githubRepo('acme/web'), gitlab(`${grp}/api`)]);
        expect(names(repos)).toEqual(['acme/web', `gitlab:${HOST}/${grp}/api`]);
    });
});

describe.skipIf(!enabled)('picking the projects to track', () => {
    it('lists every project under the allowed groups with the admin’s own grant, across pages, with its tracked flag', async () => {
        for (const path of [`${grp}/a`, `${grp}/b`, `${grp}/team/c`, `${grp}/team/d`, `${grp}/e`]) {
            await project(path);
        }
        await project(`${grp}x/z`);
        const id = await h.linked(org, 'dev-one', { groups: [grp] });
        const listed = await listProjects(id);
        expect(listed.statusCode).toBe(OK);
        const { projects } = listed.json<{ projects: { path: string; tracked: boolean }[] }>();
        expect(projects.map((p) => p.path).sort()).toEqual([
            `${grp}/a`,
            `${grp}/b`,
            `${grp}/e`,
            `${grp}/team/c`,
            `${grp}/team/d`,
        ]);
        expect(projects.every((p) => !p.tracked)).toBe(true);
        // The listing was the admin's: their token, never an App credential.
        const asked = h.fake.forge.calls().filter((c) => c.path.includes('/groups/'));
        expect(asked.length).toBeGreaterThan(1);
    });

    it('tracks the picked projects, replaces only GitLab’s rows, and flags them in the next listing', async () => {
        await project(`${grp}/a`);
        await project(`${grp}/b`);
        const id = await h.linked(org, 'dev-one', { groups: [grp] });
        await replaceTrackedRepos({
            sql,
            orgId: org.id,
            scope: { forge: 'github', host: 'github.com' },
            repos: [githubRepo('acme/web')],
        });
        const saved = await track(id, [`${grp}/a`]);
        expect(saved.statusCode).toBe(OK);
        expect(keys(await trackedRepos({ sql, orgId: org.id }))).toEqual([
            'github:github.com/acme/web',
            `gitlab:${HOST}/${grp}/a`,
        ]);
        const { projects } = (await listProjects(id)).json<{ projects: { path: string; tracked: boolean }[] }>();
        expect(Object.fromEntries(projects.map((p) => [p.path, p.tracked]))).toEqual({
            [`${grp}/a`]: true,
            [`${grp}/b`]: false,
        });
        const cleared = await track(id, []);
        expect(cleared.statusCode).toBe(OK);
        expect(keys(await trackedRepos({ sql, orgId: org.id }))).toEqual(['github:github.com/acme/web']);
    });

    it('refuses a path outside the allowed groups, or one the admin cannot see, and changes nothing', async () => {
        await project(`${grp}/a`);
        await project(`${grp}x/z`);
        const id = await h.linked(org, 'dev-one', { groups: [grp] });
        await track(id, [`${grp}/a`]);
        const outside = await track(id, [`${grp}/a`, `${grp}x/z`]);
        expect(outside.statusCode).toBe(BAD_REQUEST);
        const unseen = await track(id, [`${grp}/ghost`]);
        expect(unseen.statusCode).toBe(BAD_REQUEST);
        const malformed = await board.app.inject({
            method: 'PUT',
            url: trackedPath(id),
            headers: bearer(org.admin),
            payload: { paths: `${grp}/a` },
        });
        expect(malformed.statusCode).toBe(BAD_REQUEST);
        expect(keys(await trackedRepos({ sql, orgId: org.id }))).toEqual([`gitlab:${HOST}/${grp}/a`]);
    });

    it('asks the admin to link first, and shows a member neither route', async () => {
        await project(`${grp}/a`);
        const id = await h.connect(org, { groups: [grp] });
        await board.activate(org, id);
        // The activation kept the admin's grant: unlink it by revoking the connection's grants is not needed;
        // a member with no grant is refused before the listing.
        expect((await listProjects(id, org.member)).statusCode).toBe(FORBIDDEN);
        expect((await track(id, [], org.member)).statusCode).toBe(FORBIDDEN);
    });

    it('answers 409 FORGE_GRANT_REQUIRED when the admin holds no live grant', async () => {
        await project(`${grp}/a`);
        const id = await h.linked(org, 'dev-one', { groups: [grp] });
        await sql`update integration_grant set status = 'reconnect_required' where org_id = ${org.id}`;
        const listed = await listProjects(id);
        expect(listed.statusCode).toBe(CONFLICT);
        expect(listed.json()).toMatchObject({ code: 'FORGE_GRANT_REQUIRED', standing: 'broken' });
    });

    it.each([
        { name: 'a 5xx', fault: { mode: 'status', status: 502 } },
        { name: 'a malformed body', fault: { mode: 'malformed' } },
    ])(
        'answers 503, never a partial listing or a save, when GitLab answers $name on the second page',
        async ({ fault }) => {
            for (const path of [`${grp}/a`, `${grp}/b`, `${grp}/c`, `${grp}/d`]) await project(path);
            const id = await h.linked(org, 'dev-one', { groups: [grp] });
            await track(id, [`${grp}/a`]);
            // The first page is served; the second is the faulty one.
            await h.fake.control('gitlab/faults', { ...fault, pathIncludes: '/groups/', count: 1, after: 1 });
            const listed = await listProjects(id);
            expect(listed.statusCode).toBe(UNAVAILABLE);
            await h.fake.control('gitlab/faults', { ...fault, pathIncludes: '/groups/', count: 1, after: 1 });
            expect((await track(id, [`${grp}/b`])).statusCode).toBe(UNAVAILABLE);
            expect(keys(await trackedRepos({ sql, orgId: org.id }))).toEqual([`gitlab:${HOST}/${grp}/a`]);
        }
    );

    it('lists the tracked GitLab repos in GET /api/repos, and drops them with the connection', async () => {
        await project(`${grp}/a`);
        const id = await h.linked(org, 'dev-one', { groups: [grp] });
        await track(id, [`${grp}/a`]);
        const listed = await board.app.inject({ method: 'GET', url: '/api/repos', headers: bearer(org.member) });
        expect(listed.json<{ repos: { id: string }[] }>().repos.map((r) => r.id)).toContain(`gitlab:${HOST}/${grp}/a`);
        const removed = await board.app.inject({
            method: 'DELETE',
            url: `/api/org/gitlab-connections/${id}`,
            headers: bearer(org.admin),
        });
        expect(removed.statusCode).toBe(OK);
        expect(await trackedRepos({ sql, orgId: org.id, scope: { forge: 'gitlab', host: HOST } })).toEqual([]);
    });
});
