import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeGitlab, GITLAB_TOKEN_TTL_S, startFakeGitlab } from '../test-db/fake-gitlab.js';

let gl: FakeGitlab;

beforeEach(async () => {
    gl = await startFakeGitlab();
});
afterEach(async () => {
    await gl.stop();
});

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

    it('answers as the login the authorize call names', async () => {
        const pair = await gl.signIn('reviewer');
        expect((await gl.send('GET', '/api/v4/user', { token: pair.access_token })).body.username).toBe('reviewer');
    });

    it('spends a code once, and refuses an unknown one', async () => {
        const authorize = await gl.send('GET', '/oauth/authorize?redirect_uri=http://board.test/cb&state=abc');
        const target = new URL(authorize.location as string);
        expect(target.searchParams.get('state')).toBe('abc');
        const grant = { grant_type: 'authorization_code', code: target.searchParams.get('code') as string };
        expect((await gl.send('POST', '/oauth/token', { body: grant })).status).toBe(200);
        const replay = await gl.send('POST', '/oauth/token', { body: grant });
        expect(replay.status).toBe(400);
        expect(replay.body.error).toBe('invalid_grant');
        expect(
            (await gl.send('POST', '/oauth/token', { body: { grant_type: 'authorization_code', code: 'x' } })).status
        ).toBe(400);
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
        expect((await gl.send('POST', '/oauth/revoke', { body: { token: byAccess.access_token } })).status).toBe(200);
        expect((await gl.send('GET', '/api/v4/user', { token: byAccess.access_token })).status).toBe(401);
        expect((await gl.refresh(byAccess.refresh_token)).body.error).toBe('invalid_grant');
        const byRefresh = await gl.signIn();
        await gl.send('POST', '/oauth/revoke', { body: { token: byRefresh.refresh_token } });
        expect((await gl.send('GET', '/api/v4/user', { token: byRefresh.access_token })).status).toBe(401);
        expect((await gl.refresh(byRefresh.refresh_token)).status).toBe(400);
        expect((await gl.send('POST', '/oauth/revoke', { body: { token: 'unknown' } })).status).toBe(200);
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
        expect((await gl.send('PUT', api('/merge_requests/1/merge'), { token })).status).toBe(422);
        await gl.control('gitlab/merge_status', { project: PROJECT, iid: 1 });
        expect((await gl.send('PUT', api('/merge_requests/1/merge'), { token })).status).toBe(200);
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
