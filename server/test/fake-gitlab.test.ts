import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    CLIENT_AUTH,
    FAKE_CLIENT,
    type FakeGitlab,
    GITLAB_CODE_TTL_S,
    GITLAB_TOKEN_TTL_S,
    REDIRECT_URI,
    startFakeGitlab,
} from '../test-db/fake-gitlab.js';

let gl: FakeGitlab;

beforeEach(async () => {
    gl = await startFakeGitlab();
});
afterEach(async () => {
    await gl.stop();
});

const REDIRECT = REDIRECT_URI;
const PROJECT = 'acme/group/proj';
const ENCODED = encodeURIComponent(PROJECT);
const api = (path: string) => `/api/v4/projects/${ENCODED}${path}`;

/** A project with a `main` branch holding one file, and a `feature` branch that changes it. */
const seed = async (extra: object = {}) => {
    const project = await gl.control('gitlab/projects', {
        path: PROJECT,
        defaultBranch: 'main',
        files: { 'README.md': 'hello\n' },
        ...extra,
    });
    await gl.control('gitlab/commit', { project: PROJECT, branch: 'feature', files: { 'README.md': 'changed\n' } });
    return project.body as { id: number };
};
const openMr = async (token: string, body: object = {}) =>
    gl.send('POST', api('/merge_requests'), {
        token,
        body: { source_branch: 'feature', target_branch: 'main', title: 'Change it', ...body },
    });

describe('fake GitLab: OAuth', () => {
    it('issues a pair through authorize → code → token that identifies the member', async () => {
        const pair = await gl.signIn();
        expect(pair.token_type).toBe('Bearer');
        expect(pair.expires_in).toBe(GITLAB_TOKEN_TTL_S);
        expect(GITLAB_TOKEN_TTL_S).toBe(2 * 3600);
        const bearer = await gl.send('GET', '/api/v4/user', { token: pair.access_token });
        expect(bearer.status).toBe(200);
        expect(bearer.body.username).toBeTruthy();
        const header = await gl.send('GET', '/api/v4/user', { token: pair.access_token, header: 'private' });
        expect(header.body.id).toBe(bearer.body.id);
        const denied = await gl.send('GET', '/api/v4/user', { token: 'nope' });
        expect(denied.status).toBe(401);
        expect(denied.body.message).toBe('401 Unauthorized');
        expect((await gl.send('GET', '/api/v4/user')).status).toBe(401);
    });

    it('signs a member in through the lane door, without the redirect round trip', async () => {
        const pair = (await gl.control('gitlab/sign-in', { login: 'lane-dev', clientId: FAKE_CLIENT.clientId })).body;
        expect(pair).toMatchObject({ token_type: 'Bearer', expires_in: GITLAB_TOKEN_TTL_S });
        expect((await gl.send('GET', '/api/v4/user', { token: pair.access_token })).body.username).toBe('lane-dev');
        expect((await gl.refresh(pair.refresh_token)).status).toBe(200);
        const unbound = (await gl.control('gitlab/sign-in', { login: 'lane-dev' })).body;
        expect((await gl.refresh(unbound.refresh_token)).status).toBe(400);
    });

    it('answers as the login the authorize call names', async () => {
        const pair = await gl.signIn('reviewer');
        expect((await gl.send('GET', '/api/v4/user', { token: pair.access_token })).body.username).toBe('reviewer');
    });

    it('spends a code once, and refuses an unknown one', async () => {
        const authorize = await gl.send(
            'GET',
            `/oauth/authorize?redirect_uri=${REDIRECT}&response_type=code&state=abc&client_id=${FAKE_CLIENT.clientId}`
        );
        const target = new URL(authorize.location as string);
        expect(target.searchParams.get('state')).toBe('abc');
        const grant = {
            grant_type: 'authorization_code',
            code: target.searchParams.get('code') as string,
            redirect_uri: REDIRECT,
            ...CLIENT_AUTH,
        };
        expect((await gl.send('POST', '/oauth/token', { body: grant })).status).toBe(200);
        const replay = await gl.send('POST', '/oauth/token', { body: grant });
        expect(replay.status).toBe(400);
        expect(replay.body.error).toBe('invalid_grant');
        expect(
            (
                await gl.send('POST', '/oauth/token', {
                    body: { grant_type: 'authorization_code', code: 'x', redirect_uri: REDIRECT, ...CLIENT_AUTH },
                })
            ).status
        ).toBe(400);
    });

    it('enforces PKCE when a challenge was sent: a missing or wrong verifier is invalid_grant, the right one works', async () => {
        const verifier = 'v'.repeat(43);
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const codeFor = async () => {
            const query = new URLSearchParams({
                redirect_uri: REDIRECT,
                response_type: 'code',
                state: 's',
                client_id: FAKE_CLIENT.clientId,
                code_challenge: challenge,
                code_challenge_method: 'S256',
            });
            const authorize = await gl.send('GET', `/oauth/authorize?${query}`);
            return new URL(authorize.location as string).searchParams.get('code') as string;
        };
        const exchange = async (extra: object) =>
            gl.send('POST', '/oauth/token', {
                body: {
                    grant_type: 'authorization_code',
                    code: await codeFor(),
                    redirect_uri: REDIRECT,
                    ...CLIENT_AUTH,
                    ...extra,
                },
            });
        for (const extra of [{}, { code_verifier: 'w'.repeat(43) }]) {
            const refused = await exchange(extra);
            expect(refused.status).toBe(400);
            expect(refused.body.error).toBe('invalid_grant');
        }
        expect((await exchange({ code_verifier: verifier })).status).toBe(200);
    });

    it('rotates on every refresh: the used refresh token and the old access token die', async () => {
        const first = await gl.signIn();
        const rotated = (await gl.refresh(first.refresh_token)).body;
        expect(rotated.refresh_token).not.toBe(first.refresh_token);
        expect(rotated.access_token).not.toBe(first.access_token);
        expect((await gl.send('GET', '/api/v4/user', { token: first.access_token })).status).toBe(401);
        expect((await gl.send('GET', '/api/v4/user', { token: rotated.access_token })).status).toBe(200);
        const replay = await gl.refresh(first.refresh_token);
        expect(replay.status).toBe(400);
        expect(replay.body.error).toBe('invalid_grant');
        const second = (await gl.refresh(rotated.refresh_token)).body;
        expect(second.refresh_token).not.toBe(rotated.refresh_token);
        expect((await gl.refresh(rotated.refresh_token)).status).toBe(400);
    });

    it('expires the access token after 2 h on the injected clock, and still refreshes it', async () => {
        const pair = await gl.signIn();
        gl.forge.advance((GITLAB_TOKEN_TTL_S - 1) * 1000);
        expect((await gl.send('GET', '/api/v4/user', { token: pair.access_token })).status).toBe(200);
        gl.forge.advance(2000);
        expect((await gl.send('GET', '/api/v4/user', { token: pair.access_token })).status).toBe(401);
        const renewed = await gl.refresh(pair.refresh_token);
        expect(renewed.status).toBe(200);
        expect((await gl.send('GET', '/api/v4/user', { token: renewed.body.access_token })).status).toBe(200);
    });

    it('revokes both halves of the pair, by either token', async () => {
        const byAccess = await gl.signIn();
        expect((await gl.revoke(byAccess.access_token)).status).toBe(200);
        expect((await gl.send('GET', '/api/v4/user', { token: byAccess.access_token })).status).toBe(401);
        expect((await gl.refresh(byAccess.refresh_token)).body.error).toBe('invalid_grant');
        const byRefresh = await gl.signIn();
        await gl.revoke(byRefresh.refresh_token);
        expect((await gl.send('GET', '/api/v4/user', { token: byRefresh.access_token })).status).toBe(401);
        expect((await gl.refresh(byRefresh.refresh_token)).status).toBe(400);
        expect((await gl.revoke('unknown')).status).toBe(200);
    });
});

describe('fake GitLab: projects, branches and files', () => {
    it('answers a project by numeric id and by URL-encoded nested path, with permissions', async () => {
        const { id } = await seed();
        const { access_token: token } = await gl.signIn('dev');
        const byPath = await gl.send('GET', `/api/v4/projects/${ENCODED}`, { token });
        expect(byPath.status).toBe(200);
        expect(byPath.body).toMatchObject({
            id,
            path_with_namespace: PROJECT,
            path: 'proj',
            default_branch: 'main',
            namespace: { full_path: 'acme/group' },
        });
        expect(byPath.body.permissions.project_access.access_level).toBe(40);
        expect(byPath.body.http_url_to_repo).toBe(`${gl.base}/${PROJECT}.git`);
        expect((await gl.send('GET', `/api/v4/projects/${id}`, { token })).body.id).toBe(id);
        expect((await gl.send('GET', '/api/v4/projects/999999', { token })).status).toBe(404);
        expect((await gl.send('GET', '/api/v4/projects/acme%2Fnone', { token })).body.message).toBe(
            '404 Project Not Found'
        );
        expect((await gl.send('GET', `/api/v4/projects/${id}`)).status).toBe(401);
    });

    it('reports project and group access per token holder; no access is a 404', async () => {
        await seed();
        const { access_token: token } = await gl.signIn('dev');
        await gl.control('gitlab/members', { project: PROJECT, login: 'dev', projectAccess: 20, groupAccess: 30 });
        const permissions = (await gl.send('GET', `/api/v4/projects/${ENCODED}`, { token })).body.permissions;
        expect(permissions).toEqual({
            project_access: { access_level: 20, notification_level: 3 },
            group_access: { access_level: 30, notification_level: 3 },
        });
        await gl.control('gitlab/members', { project: PROJECT, login: 'dev' });
        expect((await gl.send('GET', `/api/v4/projects/${ENCODED}`, { token })).status).toBe(404);
    });

    it('lists, creates and deletes branches', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        const list = await gl.send('GET', api('/repository/branches'), { token });
        expect(list.body.map((branch: { name: string }) => branch.name).sort()).toEqual(['feature', 'main']);
        const main = (await gl.send('GET', api('/repository/branches/main'), { token })).body;
        expect(main).toMatchObject({ name: 'main', default: true, protected: false });
        expect(main.commit.id).toMatch(/^[0-9a-f]{40}$/);
        const created = await gl.send('POST', api('/repository/branches'), {
            token,
            body: { branch: 'topic/x', ref: 'main' },
        });
        expect(created.status).toBe(201);
        expect(created.body.commit.id).toBe(main.commit.id);
        const again = await gl.send('POST', api('/repository/branches'), {
            token,
            body: { branch: 'topic/x', ref: 'main' },
        });
        expect(again.status).toBe(400);
        expect(again.body.message).toBe('Branch already exists');
        expect(
            (await gl.send('POST', api('/repository/branches'), { token, body: { branch: 'y', ref: 'nope' } })).status
        ).toBe(400);
        expect(
            (await gl.send('GET', api(`/repository/branches/${encodeURIComponent('topic/x')}`), { token })).status
        ).toBe(200);
        expect(
            (await gl.send('DELETE', api(`/repository/branches/${encodeURIComponent('topic/x')}`), { token })).status
        ).toBe(204);
        expect((await gl.send('GET', api('/repository/branches/topic%2Fx'), { token })).status).toBe(404);
        expect((await gl.send('DELETE', api('/repository/branches/topic%2Fx'), { token })).status).toBe(404);
    });

    it('serves a file by URL-encoded path and ref, as JSON and raw', async () => {
        await seed({ files: { 'docs/guide.md': 'guide\n' } });
        const { access_token: token } = await gl.signIn();
        const file = await gl.send('GET', api('/repository/files/docs%2Fguide.md?ref=main'), { token });
        expect(file.status).toBe(200);
        expect(file.body).toMatchObject({
            file_name: 'guide.md',
            file_path: 'docs/guide.md',
            ref: 'main',
            encoding: 'base64',
        });
        expect(Buffer.from(file.body.content, 'base64').toString()).toBe('guide\n');
        const raw = await gl.send('GET', api('/repository/files/docs%2Fguide.md/raw?ref=main'), { token });
        expect(raw.body).toBe('guide\n');
        const missing = await gl.send('GET', api('/repository/files/nope.md?ref=main'), { token });
        expect(missing.status).toBe(404);
        expect(missing.body.message).toBe('404 File Not Found');
        expect((await gl.send('GET', api('/repository/files/docs%2Fguide.md?ref=none'), { token })).status).toBe(404);
        expect((await gl.send('GET', api('/repository/files/docs%2Fguide.md'), { token })).status).toBe(400);
    });
});

describe('fake GitLab: merge requests', () => {
    it('creates, lists, views and updates a merge request', async () => {
        await seed();
        const { access_token: token } = await gl.signIn('dev');
        const created = await openMr(token, { description: 'why' });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            iid: 1,
            state: 'opened',
            source_branch: 'feature',
            target_branch: 'main',
            title: 'Change it',
            description: 'why',
            draft: false,
            detailed_merge_status: 'mergeable',
            author: { username: 'dev' },
        });
        const feature = (await gl.send('GET', api('/repository/branches/feature'), { token })).body;
        expect(created.body.sha).toBe(feature.commit.id);
        expect(created.body.web_url).toBe(`${gl.base}/${PROJECT}/-/merge_requests/1`);

        const duplicate = await openMr(token);
        expect(duplicate.status).toBe(409);
        expect(duplicate.body.message).toEqual([
            'Another open merge request already exists for this source branch: !1',
        ]);

        const filter = async (query: string) =>
            (await gl.send('GET', api(`/merge_requests?${query}`), { token })).body.map(
                (mr: { iid: number }) => mr.iid
            );
        expect(await filter('source_branch=feature&state=opened')).toEqual([1]);
        expect(await filter('source_branch=other')).toEqual([]);
        expect(await filter('state=closed')).toEqual([]);
        expect(await filter('state=all&target_branch=main')).toEqual([1]);

        expect((await gl.send('GET', api('/merge_requests/1'), { token })).body.title).toBe('Change it');
        expect((await gl.send('GET', api('/merge_requests/7'), { token })).status).toBe(404);

        const updated = await gl.send('PUT', api('/merge_requests/1'), {
            token,
            body: { title: 'Draft: renamed', description: 'new' },
        });
        expect(updated.body).toMatchObject({
            title: 'Draft: renamed',
            description: 'new',
            draft: true,
            detailed_merge_status: 'draft_status',
        });
        const closed = await gl.send('PUT', api('/merge_requests/1'), { token, body: { state_event: 'close' } });
        expect(closed.body.state).toBe('closed');
        expect(await filter('state=opened')).toEqual([]);
        // a closed MR frees the source branch for a new one, and reopening it then collides
        expect((await openMr(token)).body.iid).toBe(2);
        const reopen = await gl.send('PUT', api('/merge_requests/1'), { token, body: { state_event: 'reopen' } });
        expect(reopen.status).toBe(409);
    });

    it('retargets a merge request, and refuses a target that already has one', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        await gl.send('POST', api('/repository/branches'), { token, body: { branch: 'release', ref: 'main' } });
        await openMr(token);
        await openMr(token, { target_branch: 'release' });
        const taken = await gl.send('PUT', api('/merge_requests/2'), { token, body: { target_branch: 'main' } });
        expect(taken.status).toBe(409);
        const moved = await gl.send('PUT', api('/merge_requests/1'), { token, body: { target_branch: 'topic' } });
        expect(moved.status).toBe(400);
        const free = await gl.send('POST', api('/repository/branches'), {
            token,
            body: { branch: 'topic', ref: 'main' },
        });
        expect(free.status).toBe(201);
        expect(
            (await gl.send('PUT', api('/merge_requests/1'), { token, body: { target_branch: 'topic' } })).body
                .target_branch
        ).toBe('topic');
    });

    it('rejects a merge request over a missing branch', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        expect((await openMr(token, { source_branch: 'ghost' })).status).toBe(400);
        expect((await openMr(token, { target_branch: 'ghost' })).status).toBe(400);
    });

    it('merges with the head sha, moves the target and answers merged', async () => {
        await seed();
        const { access_token: token } = await gl.signIn('dev');
        const mr = (await openMr(token)).body;
        const stale = await gl.send('PUT', api('/merge_requests/1/merge'), { token, body: { sha: 'a'.repeat(40) } });
        expect(stale.status).toBe(409);
        expect(stale.body.message).toBe(`SHA does not match HEAD of source branch: ${mr.sha}`);
        const before = (await gl.send('GET', api('/repository/branches/main'), { token })).body.commit.id;
        const merged = await gl.send('PUT', api('/merge_requests/1/merge'), {
            token,
            body: { sha: mr.sha, should_remove_source_branch: true, merge_commit_message: 'merge it' },
        });
        expect(merged.status).toBe(200);
        expect(merged.body).toMatchObject({
            state: 'merged',
            detailed_merge_status: 'not_open',
            merged_by: { username: 'dev' },
        });
        const after = (await gl.send('GET', api('/repository/branches/main'), { token })).body.commit.id;
        expect(after).not.toBe(before);
        expect(merged.body.merge_commit_sha).toBe(after);
        expect(merged.body.squash_commit_sha).toBeFalsy();
        expect((await gl.send('GET', api('/repository/branches/feature'), { token })).status).toBe(404);
        const readme = await gl.send('GET', api('/repository/files/README.md/raw?ref=main'), { token });
        expect(readme.body).toBe('changed\n');
        const again = await gl.send('PUT', api('/merge_requests/1/merge'), { token });
        expect(again.status).toBe(405);
        expect((await gl.send('GET', api('/merge_requests?state=merged'), { token })).body).toHaveLength(1);
    });

    it('honours squash and the project squash_option', async () => {
        await seed({ squashOption: 'always' });
        const { access_token: token } = await gl.signIn();
        await openMr(token);
        const squashed = await gl.send('PUT', api('/merge_requests/1/merge'), { token, body: { squash: false } });
        expect(squashed.body.squash_commit_sha).toBe(squashed.body.merge_commit_sha);
        expect(squashed.body.squash_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('never squashes under squash_option never, and squashes on request otherwise', async () => {
        await seed({ squashOption: 'never' });
        const { access_token: token } = await gl.signIn();
        await openMr(token);
        expect(
            (await gl.send('PUT', api('/merge_requests/1/merge'), { token, body: { squash: true } })).body
                .squash_commit_sha
        ).toBeFalsy();
        await gl.stop();
        gl = await startFakeGitlab();
        await seed();
        const second = await gl.signIn();
        await openMr(second.access_token);
        const asked = await gl.send('PUT', api('/merge_requests/1/merge'), {
            token: second.access_token,
            body: { squash: true },
        });
        expect(asked.body.squash_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    });

    it('refuses a merge that is not mergeable, with the reason in detailed_merge_status', async () => {
        await seed({ onlyAllowMergeIfPipelineSucceeds: true, onlyAllowMergeIfAllDiscussionsAreResolved: true });
        const { access_token: token } = await gl.signIn();
        const mr = (await openMr(token)).body;
        expect(mr.detailed_merge_status).toBe('ci_must_pass');
        const refused = await gl.send('PUT', api('/merge_requests/1/merge'), { token });
        expect(refused.status).toBe(422);
        expect(refused.body.message).toBe('Branch cannot be merged');

        const pipeline = (await gl.control('gitlab/pipelines', { project: PROJECT, ref: 'feature', status: 'running' }))
            .body;
        expect((await gl.send('GET', api('/merge_requests/1'), { token })).body.detailed_merge_status).toBe(
            'ci_still_running'
        );
        await gl.control(`gitlab/pipelines/${pipeline.id}`, { status: 'success' });
        const thread = await gl.send('POST', api('/merge_requests/1/discussions'), {
            token,
            body: { body: 'fix this' },
        });
        const view = (await gl.send('GET', api('/merge_requests/1'), { token })).body;
        expect(view).toMatchObject({
            detailed_merge_status: 'discussions_not_resolved',
            blocking_discussions_resolved: false,
        });
        expect(view.head_pipeline).toMatchObject({ id: pipeline.id, status: 'success' });
        await gl.send('PUT', api(`/merge_requests/1/discussions/${thread.body.id}`), {
            token,
            body: { resolved: true },
        });
        const ready = (await gl.send('GET', api('/merge_requests/1'), { token })).body;
        expect(ready).toMatchObject({ detailed_merge_status: 'mergeable', blocking_discussions_resolved: true });

        await gl.control('gitlab/merge_status', { project: PROJECT, iid: 1, detailedMergeStatus: 'conflict' });
        expect((await gl.send('GET', api('/merge_requests/1'), { token })).body).toMatchObject({
            detailed_merge_status: 'conflict',
            has_conflicts: true,
        });
        expect((await gl.send('PUT', api('/merge_requests/1/merge'), { token })).status).toBe(406);
        await gl.control('gitlab/merge_status', { project: PROJECT, iid: 1 });
        expect((await gl.send('PUT', api('/merge_requests/1/merge'), { token })).status).toBe(200);
    });

    it('merges diverged branches with both sides changes, merge commit and squash alike', async () => {
        for (const squash of [false, true]) {
            await gl.stop();
            gl = await startFakeGitlab();
            await seed({ files: { 'README.md': 'hello\n', 'a.txt': 'a\n' } });
            const { access_token: token } = await gl.signIn();
            await gl.control('gitlab/commit', { project: PROJECT, branch: 'main', files: { 'a.txt': 'target\n' } });
            await openMr(token);
            const merged = await gl.send('PUT', api('/merge_requests/1/merge'), { token, body: { squash } });
            expect(merged.status).toBe(200);
            const raw = (path: string) => gl.send('GET', api(`/repository/files/${path}/raw?ref=main`), { token });
            expect((await raw('a.txt')).body).toBe('target\n');
            expect((await raw('README.md')).body).toBe('changed\n');
        }
    });

    it('reports a conflict and refuses the merge without moving the target', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        await gl.control('gitlab/commit', { project: PROJECT, branch: 'main', files: { 'README.md': 'other\n' } });
        await openMr(token);
        const view = (await gl.send('GET', api('/merge_requests/1'), { token })).body;
        expect(view).toMatchObject({ detailed_merge_status: 'conflict', has_conflicts: true });
        const before = (await gl.send('GET', api('/repository/branches/main'), { token })).body.commit.id;
        expect((await gl.send('PUT', api('/merge_requests/1/merge'), { token })).status).toBe(406);
        expect((await gl.send('GET', api('/repository/branches/main'), { token })).body.commit.id).toBe(before);
    });

    it('answers an error, not a crash, when a branch is deleted before the merge', async () => {
        for (const gone of ['feature', 'main']) {
            await gl.stop();
            gl = await startFakeGitlab();
            await seed();
            const { access_token: token } = await gl.signIn();
            await openMr(token);
            await gl.send('DELETE', api(`/repository/branches/${gone}`), { token });
            expect((await gl.send('PUT', api('/merge_requests/1/merge'), { token })).status).toBe(422);
            expect((await gl.send('GET', api('/merge_requests/1'), { token })).status).toBe(200);
        }
    });

    it('answers 500 and keeps serving when a handler rejects', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        await openMr(token);
        // a repository that vanished under the fake makes the next read reject
        rmSync(join(gl.stateDir, 'repos'), { recursive: true, force: true });
        expect((await gl.send('GET', api('/repository/branches'), { token })).status).toBe(500);
        expect((await gl.send('GET', '/api/v4/user', { token })).status).toBe(200);
    });

    it('refuses to merge a draft', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        await openMr(token, { title: 'Draft: wip' });
        expect((await gl.send('PUT', api('/merge_requests/1/merge'), { token })).status).toBe(422);
        await gl.send('PUT', api('/merge_requests/1'), { token, body: { title: 'ready' } });
        expect((await gl.send('PUT', api('/merge_requests/1/merge'), { token })).status).toBe(200);
    });

    it('lets only a Developer change anything', async () => {
        await seed();
        const { access_token: token } = await gl.signIn('viewer');
        await gl.control('gitlab/members', { project: PROJECT, login: 'viewer', projectAccess: 20 });
        expect((await gl.send('GET', api('/merge_requests'), { token })).status).toBe(200);
        const denied = await openMr(token);
        expect(denied.status).toBe(403);
        expect(denied.body.message).toBe('403 Forbidden');
        expect((await gl.send('POST', api('/hooks'), { token, body: { url: 'http://x.test' } })).status).toBe(403);
    });
});

describe('fake GitLab: discussions and notes', () => {
    it('opens a thread, replies, resolves and unresolves it', async () => {
        await seed();
        const { access_token: token } = await gl.signIn('dev');
        await openMr(token);
        const thread = await gl.send('POST', api('/merge_requests/1/discussions'), {
            token,
            body: { body: 'looks off' },
        });
        expect(thread.status).toBe(201);
        expect(thread.body.individual_note).toBe(false);
        expect(thread.body.notes[0]).toMatchObject({
            body: 'looks off',
            resolvable: true,
            resolved: false,
            author: { username: 'dev' },
        });
        const reply = await gl.send('POST', api(`/merge_requests/1/discussions/${thread.body.id}/notes`), {
            token,
            body: { body: 'fixed' },
        });
        expect(reply.status).toBe(201);
        expect(reply.body.body).toBe('fixed');

        const resolved = await gl.send('PUT', api(`/merge_requests/1/discussions/${thread.body.id}`), {
            token,
            body: { resolved: true },
        });
        expect(resolved.body.notes.every((note: { resolved: boolean }) => note.resolved)).toBe(true);
        expect(resolved.body.notes[0].resolved_by.username).toBe('dev');
        const reopened = await gl.send('PUT', api(`/merge_requests/1/discussions/${thread.body.id}?resolved=false`), {
            token,
        });
        expect(reopened.body.notes[0].resolved).toBe(false);

        const list = await gl.send('GET', api('/merge_requests/1/discussions'), { token });
        expect(list.body).toHaveLength(1);
        expect(list.body[0].notes).toHaveLength(2);
        expect((await gl.send('GET', api('/merge_requests/1/discussions/none'), { token })).status).toBe(404);
        expect(
            (await gl.send('POST', api('/merge_requests/9/discussions'), { token, body: { body: 'x' } })).status
        ).toBe(404);
        expect((await gl.send('POST', api('/merge_requests/1/discussions'), { token, body: {} })).status).toBe(400);
    });

    it('records a plain note as an individual, non-resolvable discussion', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        await openMr(token);
        const note = await gl.send('POST', api('/merge_requests/1/notes'), { token, body: { body: 'ping' } });
        expect(note.status).toBe(201);
        expect(note.body).toMatchObject({
            body: 'ping',
            resolvable: false,
            system: false,
            noteable_type: 'MergeRequest',
            noteable_iid: 1,
        });
        const notes = await gl.send('GET', api('/merge_requests/1/notes'), { token });
        expect(notes.body.map((entry: { body: string }) => entry.body)).toEqual(['ping']);
        const discussions = await gl.send('GET', api('/merge_requests/1/discussions'), { token });
        expect(discussions.body[0]).toMatchObject({ individual_note: true });
        const edited = await gl.send('PUT', api(`/merge_requests/1/notes/${note.body.id}`), {
            token,
            body: { body: 'pong' },
        });
        expect(edited.body.body).toBe('pong');
    });
});

describe('fake GitLab: pipelines and commit statuses', () => {
    it('lists pipelines for a ref or sha, and shows one by id', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        const feature = (await gl.send('GET', api('/repository/branches/feature'), { token })).body.commit.id;
        const created = (await gl.control('gitlab/pipelines', { project: PROJECT, ref: 'feature', status: 'failed' }))
            .body;
        await gl.control('gitlab/pipelines', { project: PROJECT, ref: 'main', status: 'success' });
        expect(created).toMatchObject({ ref: 'feature', sha: feature, status: 'failed' });
        const byRef = await gl.send('GET', api('/pipelines?ref=feature'), { token });
        expect(byRef.body.map((pipeline: { id: number }) => pipeline.id)).toEqual([created.id]);
        expect((await gl.send('GET', api(`/pipelines?sha=${feature}`), { token })).body).toHaveLength(1);
        expect(
            (await gl.send('GET', api('/pipelines?status=success'), { token })).body.map((p: { ref: string }) => p.ref)
        ).toEqual(['main']);
        expect((await gl.send('GET', api('/pipelines'), { token })).body).toHaveLength(2);
        expect((await gl.send('GET', api(`/pipelines/${created.id}`), { token })).body.status).toBe('failed');
        expect((await gl.send('GET', api('/pipelines/424242'), { token })).status).toBe(404);
        const mrPipelines = await gl.send('GET', api('/merge_requests/1/pipelines'), { token });
        expect(mrPipelines.status).toBe(404);
    });

    it('posts and lists commit statuses, folding them into the commit pipeline', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        const sha = (await gl.send('GET', api('/repository/branches/feature'), { token })).body.commit.id;
        const posted = await gl.send('POST', api(`/statuses/${sha}`), {
            token,
            body: { state: 'running', name: 'ci/unit', ref: 'feature' },
        });
        expect(posted.status).toBe(201);
        expect(posted.body).toMatchObject({ name: 'ci/unit', status: 'running', sha, ref: 'feature' });
        await gl.send('POST', api(`/statuses/${sha}`), { token, body: { state: 'success', name: 'ci/lint' } });
        expect((await gl.send('GET', api(`/pipelines?sha=${sha}`), { token })).body[0].status).toBe('running');
        await gl.send('POST', api(`/statuses/${sha}`), { token, body: { state: 'success', name: 'ci/unit' } });
        expect((await gl.send('GET', api(`/pipelines?sha=${sha}`), { token })).body).toHaveLength(1);
        expect((await gl.send('GET', api(`/pipelines?sha=${sha}`), { token })).body[0].status).toBe('success');
        const list = await gl.send('GET', api(`/repository/commits/${sha}/statuses`), { token });
        expect(
            list.body.map((status: { name: string; status: string }) => `${status.name}:${status.status}`).sort()
        ).toEqual(['ci/lint:success', 'ci/unit:success']);
        await gl.send('POST', api(`/statuses/${sha}`), { token, body: { state: 'failed', name: 'ci/e2e' } });
        expect((await gl.send('GET', api(`/pipelines?sha=${sha}`), { token })).body[0].status).toBe('failed');
        const bad = await gl.send('POST', api(`/statuses/${sha}`), { token, body: { state: 'weird', name: 'x' } });
        expect(bad.status).toBe(400);
        expect(
            (await gl.send('POST', api(`/statuses/${'0'.repeat(40)}`), { token, body: { state: 'success' } })).status
        ).toBe(404);
    });
});

describe('fake GitLab: project hooks', () => {
    it('creates, lists and deletes hooks without ever returning the secret token', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        const created = await gl.send('POST', api('/hooks'), {
            token,
            body: { url: 'http://hook.test/in', token: 'secret', merge_requests_events: true, push_events: false },
        });
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({
            url: 'http://hook.test/in',
            merge_requests_events: true,
            push_events: false,
        });
        expect(JSON.stringify(created.body)).not.toContain('secret');
        expect((await gl.send('GET', api('/hooks'), { token })).body).toHaveLength(1);
        expect((await gl.send('GET', api(`/hooks/${created.body.id}`), { token })).body.url).toBe(
            'http://hook.test/in'
        );
        expect((await gl.send('POST', api('/hooks'), { token, body: {} })).status).toBe(400);
        expect((await gl.send('DELETE', api(`/hooks/${created.body.id}`), { token })).status).toBe(204);
        expect((await gl.send('GET', api('/hooks'), { token })).body).toEqual([]);
        expect((await gl.send('DELETE', api(`/hooks/${created.body.id}`), { token })).status).toBe(404);
    });

    it('fires an event to the hooks that subscribe to it, with X-Gitlab-Token', async () => {
        await seed();
        const { access_token: token } = await gl.signIn();
        const received: { event: string | undefined; secret: string | undefined; body: unknown }[] = [];
        const sink = createServer((request, response) => {
            let raw = '';
            request.on('data', (chunk) => (raw += chunk));
            request.on('end', () => {
                received.push({
                    event: request.headers['x-gitlab-event'] as string | undefined,
                    secret: request.headers['x-gitlab-token'] as string | undefined,
                    body: JSON.parse(raw),
                });
                response.writeHead(200).end();
            });
        });
        await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(sink.address() as { port: number }).port}/in`;
        try {
            await gl.send('POST', api('/hooks'), {
                token,
                body: { url, token: 'shh', merge_requests_events: true, push_events: false },
            });
            const fired = await gl.control('gitlab/hooks/fire', {
                project: PROJECT,
                event: 'merge_request',
                payload: { object_kind: 'merge_request', object_attributes: { iid: 1 } },
            });
            expect(fired.body).toEqual([{ url, status: 200 }]);
            expect(received).toEqual([
                {
                    event: 'Merge Request Hook',
                    secret: 'shh',
                    body: { object_kind: 'merge_request', object_attributes: { iid: 1 } },
                },
            ]);
            const skipped = await gl.control('gitlab/hooks/fire', { project: PROJECT, event: 'push', payload: {} });
            expect(skipped.body).toEqual([]);
            expect(received).toHaveLength(1);
        } finally {
            await new Promise((resolve) => sink.close(resolve));
        }
    });
});

describe('fake GitLab: version', () => {
    it('answers the instance version to a signed-in caller, 401 otherwise, and a lane can change it', async () => {
        const { access_token: token } = await gl.signIn();
        const ok = await gl.send('GET', '/api/v4/version', { token });
        expect(ok.status).toBe(200);
        expect(ok.body.version).toMatch(/^\d+\.\d+\.\d+/);
        expect((await gl.send('GET', '/api/v4/version')).status).toBe(401);
        await gl.control('gitlab/version', { version: '16.11.2' });
        expect((await gl.send('GET', '/api/v4/version', { token })).body.version).toBe('16.11.2');
    });
});

describe('fake GitLab: group projects', () => {
    const seedTree = async () => {
        for (const path of ['acme/a', 'acme/b', 'acme/sub/c', 'acme/sub/deep/d', 'other/e'])
            await gl.control('gitlab/projects', { path });
        await gl.control('gitlab/members', { project: 'acme/b', login: 'dev', projectAccess: 20 });
        await gl.control('gitlab/members', { project: 'acme/a', login: 'dev', projectAccess: 30 });
        await gl.control('gitlab/members', { project: 'acme/sub/c', login: 'dev', groupAccess: 40 });
        await gl.control('gitlab/members', { project: 'acme/sub/deep/d', login: 'dev', projectAccess: 0 });
    };
    const list = async (group: string, query = '', login = 'dev') => {
        const { access_token: token } = await gl.signIn(login);
        return gl.send('GET', `/api/v4/groups/${encodeURIComponent(group)}/projects${query}`, { token });
    };
    const paths = (res: { body: { path_with_namespace: string }[] }) => res.body.map((p) => p.path_with_namespace);

    it('lists direct projects by default and nested ones with include_subgroups, with the member permissions', async () => {
        await seedTree();
        const direct = await list('acme');
        expect(direct.status).toBe(200);
        expect(paths(direct)).toEqual(['acme/a', 'acme/b']);
        for (const entry of direct.body) expect(entry).not.toHaveProperty('permissions');
        const { access_token: token } = await gl.signIn('dev');
        const single = await gl.send('GET', `/api/v4/projects/${encodeURIComponent('acme/a')}`, { token });
        expect(single.body.permissions.project_access.access_level).toBe(30);
        const nested = await list('acme', '?include_subgroups=true');
        expect(paths(nested)).toEqual(['acme/a', 'acme/b', 'acme/sub/c']);
        expect(paths(await list('acme/sub', '?include_subgroups=true'))).toEqual(['acme/sub/c']);
    });

    it('filters by min_access_level and answers an unknown group 404', async () => {
        await seedTree();
        expect(paths(await list('acme', '?include_subgroups=true&min_access_level=30'))).toEqual([
            'acme/a',
            'acme/sub/c',
        ]);
        expect((await list('nope')).status).toBe(404);
    });

    it('lists a group by the namespace id a project response returned, and ids survive new projects', async () => {
        await seedTree();
        const { access_token: token } = await gl.signIn('dev');
        const project = await gl.send('GET', `/api/v4/projects/${encodeURIComponent('acme/sub/c')}`, { token });
        const subId = project.body.namespace.id;
        expect(subId).toEqual(expect.any(Number));
        const direct = await gl.send('GET', `/api/v4/groups/${subId}/projects`, { token });
        expect(paths(direct)).toEqual(['acme/sub/c']);
        await gl.control('gitlab/projects', { path: 'aaa/zzz/new' });
        await gl.control('gitlab/projects', { path: 'acme/sub/more' });
        const again = await gl.send('GET', `/api/v4/projects/${encodeURIComponent('acme/sub/c')}`, { token });
        expect(again.body.namespace.id).toBe(subId);
        expect(paths(await gl.send('GET', `/api/v4/groups/${subId}/projects`, { token }))).toEqual([
            'acme/sub/c',
            'acme/sub/more',
        ]);
        const acme = (await gl.send('GET', `/api/v4/projects/${encodeURIComponent('acme/a')}`, { token })).body
            .namespace.id;
        expect(acme).not.toBe(subId);
        expect(paths(await gl.send('GET', `/api/v4/groups/${acme}/projects`, { token }))).toEqual(['acme/a', 'acme/b']);
        expect((await gl.send('GET', '/api/v4/groups/999999/projects', { token })).status).toBe(404);
    });

    it('hides a group the caller holds no project under', async () => {
        await seedTree();
        await gl.control('gitlab/members', { project: 'other/e', login: 'dev', projectAccess: 0 });
        expect((await list('other')).status).toBe(404);
    });

    it('sends a Link header with first, prev, next and last, and every page is reachable by next alone', async () => {
        await seedTree();
        const { access_token: token } = await gl.signIn('dev');
        const rels = (link: string) =>
            Object.fromEntries([...link.matchAll(/<([^>]+)>; rel="(\w+)"/g)].map((m) => [m[2], m[1]]));
        const get = async (url: string) => {
            const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
            return { headers: res.headers, body: (await res.json()) as { path_with_namespace: string }[] };
        };
        let url = `${gl.base}/api/v4/groups/acme/projects?include_subgroups=true&per_page=1`;
        const seen: string[] = [];
        let first = true;
        for (let guard = 0; guard < 10 && url; guard++) {
            const res = await get(url);
            seen.push(...res.body.map((p) => p.path_with_namespace));
            const links = rels(res.headers.get('link') as string);
            expect(Object.keys(links)).toContain('first');
            expect(Object.keys(links)).toContain('last');
            expect(new URL(links.first).searchParams.get('include_subgroups')).toBe('true');
            expect(new URL(links.first).searchParams.get('per_page')).toBe('1');
            expect('prev' in links).toBe(!first);
            first = false;
            url = links.next ?? '';
        }
        expect(seen).toEqual(['acme/a', 'acme/b', 'acme/sub/c']);
        expect(url).toBe('');
    });

    it('paginates with X-Page, X-Next-Page and X-Total headers until the last page', async () => {
        await seedTree();
        const first = await list('acme', '?include_subgroups=true&per_page=2&page=1');
        expect(paths(first)).toEqual(['acme/a', 'acme/b']);
        expect(first.headers['x-next-page']).toBe('2');
        expect(first.headers['x-total']).toBe('3');
        const last = await list('acme', '?include_subgroups=true&per_page=2&page=2');
        expect(paths(last)).toEqual(['acme/sub/c']);
        expect(last.headers['x-next-page']).toBe('');
    });
});

describe('fake GitLab: OAuth contract', () => {
    const authorize = async (query = '') => {
        const client = query.includes('client_id=') ? '' : `&client_id=${FAKE_CLIENT.clientId}`;
        const res = await gl.send(
            'GET',
            `/oauth/authorize?redirect_uri=${REDIRECT}&response_type=code&login=dev${client}${query}`
        );
        return new URL(res.location as string).searchParams.get('code') as string;
    };
    const token = (body: object) => gl.send('POST', '/oauth/token', { body });
    const exchange = (code: string, extra: object = { redirect_uri: REDIRECT, ...CLIENT_AUTH }) =>
        token({ grant_type: 'authorization_code', code, ...extra });
    const GITLAB_ERROR = { error: expect.any(String), error_description: expect.any(String) };

    it('requires the redirect URI of the authorization request: missing and different are refused, matching passes', async () => {
        const missing = await exchange(await authorize(), CLIENT_AUTH);
        expect(missing.status).toBe(400);
        expect(missing.body).toMatchObject({ ...GITLAB_ERROR, error: 'invalid_grant' });
        const different = await exchange(await authorize(), {
            redirect_uri: 'http://board.test/other',
            ...CLIENT_AUTH,
        });
        expect(different.status).toBe(400);
        expect(different.body.error).toBe('invalid_grant');
        const code = await authorize();
        expect((await exchange(code, { redirect_uri: 'http://board.test/other', ...CLIENT_AUTH })).status).toBe(400);
        expect((await exchange(code)).status).toBe(200);
    });

    it('checks grant_type: only authorization_code and refresh_token are served', async () => {
        for (const grant_type of ['password', 'client_credentials', undefined]) {
            const res = await token({ grant_type, code: await authorize(), redirect_uri: REDIRECT, ...CLIENT_AUTH });
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ ...GITLAB_ERROR, error: 'unsupported_grant_type' });
        }
        const pair = await gl.signIn();
        expect(
            (await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, ...CLIENT_AUTH })).status
        ).toBe(200);
    });

    it('names a missing code or refresh token invalid_request', async () => {
        expect(
            (await token({ grant_type: 'authorization_code', redirect_uri: REDIRECT, ...CLIENT_AUTH })).body
        ).toMatchObject({
            ...GITLAB_ERROR,
            error: 'invalid_request',
        });
        expect((await token({ grant_type: 'refresh_token', ...CLIENT_AUTH })).body.error).toBe('invalid_request');
    });

    it('spends a code once and lets it expire after its lifetime on the injected clock', async () => {
        const code = await authorize();
        expect((await exchange(code)).status).toBe(200);
        const replay = await exchange(code);
        expect(replay.status).toBe(400);
        expect(replay.body).toMatchObject({ ...GITLAB_ERROR, error: 'invalid_grant' });
        const stale = await authorize();
        gl.forge.advance((GITLAB_CODE_TTL_S + 1) * 1000);
        const expired = await exchange(stale);
        expect(expired.status).toBe(400);
        expect(expired.body.error).toBe('invalid_grant');
        const fresh = await authorize();
        gl.forge.advance((GITLAB_CODE_TTL_S - 1) * 1000);
        expect((await exchange(fresh)).status).toBe(200);
    });

    it('echoes the requested scope in the token response, and keeps it across a refresh', async () => {
        expect((await exchange(await authorize())).body.scope).toBe('api');
        const pair = (await exchange(await authorize('&scope=read_user+openid'))).body;
        expect(pair.scope).toBe('read_user openid');
        const rotated = await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, ...CLIENT_AUTH });
        expect(rotated.body.scope).toBe('read_user openid');
    });

    it('refuses the used refresh token after rotation with invalid_grant', async () => {
        const pair = await gl.signIn();
        const rotated = await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, ...CLIENT_AUTH });
        expect(rotated.status).toBe(200);
        const replay = await token({ grant_type: 'refresh_token', refresh_token: pair.refresh_token, ...CLIENT_AUTH });
        expect(replay.status).toBe(400);
        expect(replay.body).toMatchObject({ ...GITLAB_ERROR, error: 'invalid_grant' });
    });

    it('answers a client failure 401 invalid_client and a code issued to another client 400 invalid_grant', async () => {
        await gl.control('gitlab/oauth-clients', {
            clientId: 'app-1',
            clientSecret: 'secret-1',
            redirectUris: [REDIRECT],
        });
        await gl.control('gitlab/oauth-clients', {
            clientId: 'app-2',
            clientSecret: 'secret-2',
            redirectUris: [REDIRECT],
        });
        const code = await authorize('&client_id=app-1');
        const bad = await exchange(code, { redirect_uri: REDIRECT, client_id: 'app-1', client_secret: 'nope' });
        expect(bad.status).toBe(401);
        expect(bad.body).toMatchObject({ ...GITLAB_ERROR, error: 'invalid_client' });
        const other = await exchange(code, { redirect_uri: REDIRECT, client_id: 'app-2', client_secret: 'secret-2' });
        expect(other.status).toBe(400);
        expect(other.body).toMatchObject({ ...GITLAB_ERROR, error: 'invalid_grant' });
        const own = await exchange(code, { redirect_uri: REDIRECT, client_id: 'app-1', client_secret: 'secret-1' });
        expect(own.status).toBe(200);
    });
});

describe('fake GitLab: OAuth authorize', () => {
    const go = (query: Record<string, string | undefined>) => {
        const params = new URLSearchParams({
            redirect_uri: REDIRECT,
            response_type: 'code',
            client_id: FAKE_CLIENT.clientId,
            ...query,
        } as Record<string, string>);
        for (const [key, value] of Object.entries(query)) if (value === undefined) params.delete(key);
        return gl.send('GET', `/oauth/authorize?${params}`);
    };
    const back = (res: { location: string | null }) => new URL(res.location as string).searchParams;
    const GITLAB_ERROR = { error: expect.any(String), error_description: expect.any(String) };
    const register = () =>
        gl.control('gitlab/oauth-clients', {
            clientId: 'app-1',
            clientSecret: 'secret-1',
            redirectUris: [REDIRECT],
            scopes: ['api', 'read_user'],
        });

    it('requires response_type=code, redirecting with error= and the state otherwise, and issues no code', async () => {
        await register();
        for (const [response_type, error] of [
            [undefined, 'invalid_request'],
            ['token', 'unsupported_response_type'],
        ] as const) {
            const res = await go({ client_id: 'app-1', response_type, state: 'st' });
            expect(res.status).toBe(302);
            const params = back(res);
            expect(params.get('error')).toBe(error);
            expect(params.get('error_description')).toBeTruthy();
            expect(params.get('state')).toBe('st');
            expect(params.has('code')).toBe(false);
        }
    });

    it('requires a registered client: unknown and missing are a 401 invalid_client with no redirect', async () => {
        await register();
        for (const client_id of ['ghost', undefined]) {
            const res = await go({ client_id });
            expect(res.status).toBe(401);
            expect(res.location).toBeNull();
            expect(res.body).toMatchObject({ ...GITLAB_ERROR, error: 'invalid_client' });
        }
    });

    it('requires a redirect URI registered for the client: a different or missing one is a 400, never a redirect', async () => {
        await register();
        const other = await go({ client_id: 'app-1', redirect_uri: 'http://evil.test/cb' });
        expect(other.status).toBe(400);
        expect(other.location).toBeNull();
        expect(other.body).toMatchObject({ ...GITLAB_ERROR, error: 'invalid_redirect_uri' });
        const missing = await go({ client_id: 'app-1', redirect_uri: undefined });
        expect(missing.status).toBe(400);
        expect(missing.location).toBeNull();
        expect((await go({ client_id: 'app-1', redirect_uri: 'not a url' })).status).toBe(400);
        expect((await go({ client_id: 'app-1' })).status).toBe(302);
    });

    it('sends the state back unchanged, on success and on error', async () => {
        const state = 'a b&c=d/é?';
        expect(back(await go({ state })).get('state')).toBe(state);
        expect(back(await go({ state, scope: 'nonsense' })).get('state')).toBe(state);
        expect(back(await go({})).has('state')).toBe(false);
    });

    it('checks scope against what the client may have, redirecting with invalid_scope', async () => {
        await register();
        const ok = back(await go({ client_id: 'app-1', scope: 'api read_user' }));
        expect(ok.get('code')).toBeTruthy();
        for (const scope of ['write_repository', 'api read_registry', 'nonsense']) {
            const params = back(await go({ client_id: 'app-1', scope, state: 's' }));
            expect(params.get('error')).toBe('invalid_scope');
            expect(params.has('code')).toBe(false);
        }
    });

    it('with no client registered, needs response_type=code and a known scope all the same', async () => {
        expect(back(await go({ response_type: undefined })).get('error')).toBe('invalid_request');
        expect(back(await go({ response_type: 'token' })).get('error')).toBe('unsupported_response_type');
        expect(back(await go({ scope: 'bogus' })).get('error')).toBe('invalid_scope');
        expect(back(await go({ scope: 'read_user' })).get('code')).toBeTruthy();
    });

    it('keeps the redirect URI query and adds code and state to it', async () => {
        const target = new URL(`${REDIRECT}?keep=1`);
        await gl.control('gitlab/oauth-clients', {
            clientId: 'app-q',
            clientSecret: 'secret-q',
            redirectUris: [target.toString()],
        });
        const res = await go({ client_id: 'app-q', redirect_uri: target.toString(), state: 'x' });
        const params = back(res);
        expect(params.get('keep')).toBe('1');
        expect(params.get('code')).toBeTruthy();
        expect(params.get('state')).toBe('x');
    });

    it('refuses to register a client without redirect URIs', async () => {
        const res = await gl.control('gitlab/oauth-clients', { clientId: 'a', clientSecret: 'b' });
        expect(res.status).toBe(400);
    });
});

describe('fake GitLab: OAuth clients', () => {
    it('binds a pair to the client that authorized it, and refuses another client and a wrong secret', async () => {
        await gl.control('gitlab/oauth-clients', {
            clientId: 'app-1',
            clientSecret: 'secret-1',
            redirectUris: [REDIRECT],
        });
        await gl.control('gitlab/oauth-clients', {
            clientId: 'app-2',
            clientSecret: 'secret-2',
            redirectUris: [REDIRECT],
        });
        const authorize = await gl.send(
            'GET',
            '/oauth/authorize?redirect_uri=http://board.test/cb&response_type=code&client_id=app-1&login=dev'
        );
        const code = new URL(authorize.location as string).searchParams.get('code') as string;
        const exchange = (clientSecret: string, clientId = 'app-1') =>
            gl.send('POST', '/oauth/token', {
                body: {
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: 'http://board.test/cb',
                    client_id: clientId,
                    client_secret: clientSecret,
                },
            });
        expect((await exchange('wrong')).status).toBe(401);
        expect((await exchange('secret-2', 'app-2')).status).toBe(400);
        const pair = (await exchange('secret-1')).body;
        expect(pair.access_token).toBeTruthy();
        const refresh = (clientId: string, clientSecret: string, token = pair.refresh_token) =>
            gl.send('POST', '/oauth/token', {
                body: {
                    grant_type: 'refresh_token',
                    refresh_token: token,
                    client_id: clientId,
                    client_secret: clientSecret,
                },
            });
        expect((await refresh('app-2', 'secret-2')).status).toBe(400);
        const rotated = await refresh('app-1', 'secret-1');
        expect(rotated.status).toBe(200);
        expect((await refresh('app-1', 'secret-1', rotated.body.refresh_token)).status).toBe(200);
    });

    it('refuses an unknown client with no credentials, and a known client with a wrong or missing secret', async () => {
        await gl.control('gitlab/oauth-clients', {
            clientId: 'app-1',
            clientSecret: 'secret-1',
            redirectUris: [REDIRECT],
        });
        const code = async () => {
            const authorize = await gl.send(
                'GET',
                '/oauth/authorize?redirect_uri=http://board.test/cb&response_type=code&client_id=app-1&login=dev'
            );
            return new URL(authorize.location as string).searchParams.get('code') as string;
        };
        const exchange = async (extra: object) =>
            gl.send('POST', '/oauth/token', {
                body: {
                    grant_type: 'authorization_code',
                    code: await code(),
                    redirect_uri: 'http://board.test/cb',
                    ...extra,
                },
            });
        expect((await exchange({})).status).toBe(401);
        expect((await exchange({ client_id: 'ghost' })).status).toBe(401);
        expect((await exchange({ client_id: 'ghost', client_secret: 'secret-1' })).status).toBe(401);
        expect((await exchange({ client_id: 'app-1' })).status).toBe(401);
        expect((await exchange({ client_id: 'app-1', client_secret: 'wrong' })).status).toBe(401);
        expect((await exchange({ client_id: 'app-1', client_secret: 'secret-1' })).status).toBe(200);
        const unknownAuthorize = await gl.send(
            'GET',
            '/oauth/authorize?redirect_uri=http://board.test/cb&response_type=code&client_id=ghost'
        );
        expect(unknownAuthorize.status).toBe(401);
    });

    it('has no permissive mode: an empty registry refuses authorize, token, refresh and revoke', async () => {
        await gl.stop();
        gl = await startFakeGitlab({ client: false });
        const query = new URLSearchParams({ redirect_uri: REDIRECT, response_type: 'code', client_id: 'anyone' });
        expect((await gl.send('GET', `/oauth/authorize?${query}`)).status).toBe(401);
        expect((await gl.send('GET', `/oauth/authorize?${query}`)).location).toBeNull();
        const pair = (await gl.control('gitlab/sign-in', { login: 'dev' })).body;
        const grants = [
            { grant_type: 'authorization_code', code: 'x', redirect_uri: REDIRECT },
            { grant_type: 'refresh_token', refresh_token: pair.refresh_token },
        ];
        for (const grant of grants) {
            for (const auth of [{}, { client_id: 'anyone' }, { client_id: 'anyone', client_secret: 'x' }]) {
                const res = await gl.send('POST', '/oauth/token', { body: { ...grant, ...auth } });
                expect(res.status).toBe(401);
                expect(res.body.error).toBe('invalid_client');
            }
        }
        expect((await gl.send('POST', '/oauth/revoke', { body: { token: pair.access_token } })).status).toBe(401);
        expect((await gl.send('GET', '/api/v4/user', { token: pair.access_token })).status).toBe(200);
    });

    it('does not let a code issued to one client be exchanged by an unregistered one', async () => {
        const query = new URLSearchParams({ redirect_uri: REDIRECT, response_type: 'code', client_id: 'ghost' });
        expect((await gl.send('GET', `/oauth/authorize?${query}`)).status).toBe(401);
        const code = new URL(
            (await gl.send('GET', `/oauth/authorize?${query}`.replace('ghost', FAKE_CLIENT.clientId)))
                .location as string
        ).searchParams.get('code');
        const res = await gl.send('POST', '/oauth/token', {
            body: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: 'ghost' },
        });
        expect(res.status).toBe(401);
    });

    it('revokes only for the client that holds the token, and authenticates the client first', async () => {
        await gl.control('gitlab/oauth-clients', {
            clientId: 'app-2',
            clientSecret: 'secret-2',
            redirectUris: [REDIRECT],
        });
        const pair = await gl.signIn();
        const other = await gl.send('POST', '/oauth/revoke', {
            body: { token: pair.access_token, client_id: 'app-2', client_secret: 'secret-2' },
        });
        expect(other.status).toBe(403);
        expect((await gl.send('GET', '/api/v4/user', { token: pair.access_token })).status).toBe(200);
        const wrong = await gl.send('POST', '/oauth/revoke', {
            body: { token: pair.access_token, client_id: FAKE_CLIENT.clientId, client_secret: 'no' },
        });
        expect(wrong.status).toBe(401);
        expect((await gl.revoke(pair.access_token)).status).toBe(200);
        expect((await gl.send('GET', '/api/v4/user', { token: pair.access_token })).status).toBe(401);
    });
});

describe('fake GitLab: token scopes', () => {
    const INSUFFICIENT = {
        error: 'insufficient_scope',
        error_description: expect.any(String),
        scope: expect.any(String),
    };
    const reach = async (token: string) => {
        await seed();
        const get = (path: string) => gl.send('GET', path, { token });
        return {
            user: (await get('/api/v4/user')).status,
            version: (await get('/api/v4/version')).status,
            project: (await get(`/api/v4/projects/${ENCODED}`)).status,
            group: (await get('/api/v4/groups/acme/projects')).status,
            write: (
                await gl.send('POST', api('/merge_requests'), {
                    token,
                    body: { source_branch: 'feature', target_branch: 'main', title: 't' },
                })
            ).status,
        };
    };

    it('lets read_user reach /user only, with GitLab 403 insufficient_scope everywhere else', async () => {
        const pair = await gl.signIn('dev', 'read_user');
        expect(pair.scope).toBe('read_user');
        expect(await reach(pair.access_token)).toEqual({
            user: 200,
            version: 403,
            project: 403,
            group: 403,
            write: 403,
        });
        const denied = await gl.send('GET', `/api/v4/projects/${ENCODED}`, { token: pair.access_token });
        expect(denied.body).toMatchObject(INSUFFICIENT);
        expect(denied.body.scope).toContain('api');
    });

    it('lets read_api read but not write, and api do both', async () => {
        const reader = await gl.signIn('dev', 'read_api');
        expect(await reach(reader.access_token)).toEqual({
            user: 200,
            version: 200,
            project: 200,
            group: 200,
            write: 403,
        });
        const full = await gl.signIn('dev', 'api');
        expect((await reach(full.access_token)).write).toBe(201);
    });

    it('carries the scopes across a refresh, so a narrow token stays narrow and a wide one stays wide', async () => {
        const narrow = await gl.signIn('dev', 'read_user');
        const renewed = (await gl.refresh(narrow.refresh_token)).body;
        expect(renewed.scope).toBe('read_user');
        const again = await gl.send('GET', `/api/v4/projects/${ENCODED}`, { token: renewed.access_token });
        expect(again.status).toBe(403);
        expect(again.body).toMatchObject(INSUFFICIENT);
        expect((await gl.send('GET', '/api/v4/user', { token: renewed.access_token })).status).toBe(200);
        const wide = await gl.signIn('dev', 'api');
        const wideRenewed = (await gl.refresh(wide.refresh_token)).body;
        await seed();
        expect((await gl.send('GET', `/api/v4/projects/${ENCODED}`, { token: wideRenewed.access_token })).status).toBe(
            200
        );
    });

    it('applies git over HTTP scopes: read_repository clones, only write_repository or api pushes', async () => {
        await seed();
        const reader = await gl.signIn('dev', 'read_repository');
        const git = (token: string, service: string) =>
            fetch(`${gl.base}/${PROJECT}.git/info/refs?service=${service}`, {
                headers: { authorization: `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}` },
            });
        expect((await git(reader.access_token, 'git-upload-pack')).status).toBe(200);
        expect((await git(reader.access_token, 'git-receive-pack')).status).toBe(403);
        const userOnly = await gl.signIn('dev', 'read_user');
        expect((await git(userOnly.access_token, 'git-upload-pack')).status).toBe(403);
        const writer = await gl.signIn('dev', 'write_repository');
        expect((await git(writer.access_token, 'git-receive-pack')).status).toBe(200);
    });
});

describe('fake GitLab: fault controls', () => {
    const FAST = 150;
    const faultOn = (body: object) => gl.control('gitlab/faults', body);

    it('answers 5xx on the matching path only, for the counted calls, then recovers', async () => {
        const { access_token: token } = await gl.signIn('dev');
        await seed();
        await faultOn({ pathIncludes: '/projects/', mode: 'status', status: 503, count: 2 });
        expect((await gl.send('GET', api(''), { token })).status).toBe(503);
        expect((await gl.send('GET', api(''), { token })).status).toBe(503);
        expect((await gl.send('GET', api(''), { token })).status).toBe(200);
        expect((await gl.send('GET', '/api/v4/user', { token })).status).toBe(200);
    });

    it('lets the first `after` matching calls through before the fault bites', async () => {
        const { access_token: token } = await gl.signIn('dev');
        await seed();
        await faultOn({ pathIncludes: '/projects/', mode: 'status', status: 502, count: 1, after: 2 });
        expect((await gl.send('GET', api(''), { token })).status).toBe(200);
        expect((await gl.send('GET', api(''), { token })).status).toBe(200);
        expect((await gl.send('GET', api(''), { token })).status).toBe(502);
        expect((await gl.send('GET', api(''), { token })).status).toBe(200);
    });

    it('answers a body that is not JSON with a 200', async () => {
        const { access_token: token } = await gl.signIn('dev');
        await faultOn({ pathIncludes: '/api/v4/version', mode: 'malformed' });
        const res = await fetch(`${gl.base}/api/v4/version`, { headers: { authorization: `Bearer ${token}` } });
        expect(res.status).toBe(200);
        await expect(res.json()).rejects.toThrow();
    });

    it('reaches an unauthenticated call before the 401, and recovers when cleared', async () => {
        expect((await gl.send('GET', '/api/v4/version')).status).toBe(401);
        await faultOn({ pathIncludes: '/api/v4/version', mode: 'status', status: 503 });
        expect((await gl.send('GET', '/api/v4/version')).status).toBe(503);
        await faultOn({ mode: 'none' });
        expect((await gl.send('GET', '/api/v4/version')).status).toBe(401);
        await faultOn({ pathIncludes: '/api/v4/version', mode: 'malformed' });
        const res = await fetch(`${gl.base}/api/v4/version`);
        expect(res.status).toBe(200);
        await expect(res.json()).rejects.toThrow();
        await faultOn({ mode: 'none' });
        await faultOn({ pathIncludes: '/api/v4/version', mode: 'timeout' });
        await expect(fetch(`${gl.base}/api/v4/version`, { signal: AbortSignal.timeout(FAST) })).rejects.toThrow();
        await faultOn({ mode: 'none' });
        expect((await gl.send('GET', '/api/v4/version')).status).toBe(401);
    });

    it('never answers in timeout mode, and clears on mode none', async () => {
        const { access_token: token } = await gl.signIn('dev');
        await faultOn({ pathIncludes: '/api/v4/version', mode: 'timeout' });
        await expect(
            fetch(`${gl.base}/api/v4/version`, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(FAST),
            })
        ).rejects.toThrow();
        await faultOn({ mode: 'none' });
        expect((await gl.send('GET', '/api/v4/version', { token })).status).toBe(200);
    });
});

describe('fake GitLab: the call log', () => {
    it('names the token kind, a stable token id and the holder, never the token', async () => {
        await seed();
        const first = await gl.signIn('dev');
        await gl.send('GET', '/api/v4/user', { token: first.access_token });
        const second = (await gl.refresh(first.refresh_token)).body;
        await gl.send('GET', '/api/v4/user', { token: second.access_token });
        await gl.send('GET', '/api/v4/user', { token: first.access_token });
        const users = gl.forge.calls().filter((call) => call.path === '/api/v4/user');
        expect(users.map((call) => [call.tokenKind, call.holder, call.status])).toEqual([
            ['user', 'dev', 200],
            ['user', 'dev', 200],
            ['none', null, 401],
        ]);
        const [firstId, secondId] = users.map((call) => call.tokenId);
        expect(firstId).toBeTruthy();
        expect(secondId).toBeTruthy();
        expect(firstId).not.toBe(secondId);
        const log = JSON.stringify(gl.forge.calls());
        for (const secret of [first.access_token, first.refresh_token, second.access_token])
            expect(log).not.toContain(secret);
    });
});
