import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FakeGitlab, startFakeGitlab } from '../test-db/fake-gitlab.js';

const PROJECT = 'acme/group/proj';
const IDENTITY = {
    GIT_AUTHOR_NAME: 'Alice Author',
    GIT_AUTHOR_EMAIL: 'alice@users.example.test',
    GIT_COMMITTER_NAME: 'Bot Committer',
    GIT_COMMITTER_EMAIL: 'bot@users.example.test',
};
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...IDENTITY,
};

let gl: FakeGitlab;
let scratch: string;

/** Async on purpose: the fake runs in this process, and a blocked event loop could not answer git. */
const git = (cwd: string, ...args: string[]) =>
    new Promise<{ status: number; out: string; err: string }>((resolve) => {
        execFile('git', args, { cwd, env: GIT_ENV }, (error, stdout, stderr) =>
            resolve({
                status: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
                out: stdout.trim(),
                err: stderr,
            })
        );
    });
const urlFor = (token: string | null, path = PROJECT) => {
    const host = gl.base.replace('http://', '');
    return `http://${token === null ? '' : `oauth2:${token}@`}${host}/${path}.git`;
};
/** A working clone of a fresh local repository holding one commit on `main`. */
const workRepo = async (name: string) => {
    const dir = join(scratch, name);
    mkdirSync(dir);
    await git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'local.txt'), `${name}\n`);
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-q', '-m', `work in ${name}`);
    return dir;
};
const pushes = async () =>
    (await gl.read('gitlab/pushes')).body as Array<{
        project: string;
        tokenId: string;
        holder: string;
        refs: Array<{
            ref: string;
            before: string | null;
            after: string | null;
            commits: Array<{
                sha: string;
                author: { name: string; email: string };
                committer: { name: string; email: string };
            }>;
        }>;
    }>;
const tokenIdsSeen = (login: string) =>
    new Set(
        gl.forge
            .calls()
            .filter((call) => call.holder === login && call.tokenId)
            .map((call) => call.tokenId)
    );

beforeEach(async () => {
    gl = await startFakeGitlab();
    scratch = mkdtempSync(join(tmpdir(), 'fake-gitlab-git-'));
    await gl.control('gitlab/projects', { path: PROJECT, files: { 'README.md': 'hello\n' } });
});
afterEach(async () => {
    await gl.stop();
    rmSync(scratch, { recursive: true, force: true });
});

describe('fake GitLab: git smart-HTTP', () => {
    it('clones the seeded project with oauth2:<token>', async () => {
        const { access_token: token } = await gl.signIn('dev');
        const target = join(scratch, 'clone');
        const cloned = await git(scratch, 'clone', '-q', urlFor(token), target);
        expect(cloned.err).toBe('');
        expect(cloned.status).toBe(0);
        expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('hello\n');
        expect((await git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).out).toBe('main');
    });

    it('seeds a project from a directory', async () => {
        const seedDir = join(scratch, 'seed');
        mkdirSync(join(seedDir, 'docs'), { recursive: true });
        writeFileSync(join(seedDir, 'docs', 'a.md'), 'from a dir\n');
        await gl.control('gitlab/projects', { path: 'acme/seeded', seedDir });
        const { access_token: token } = await gl.signIn();
        const raw = await gl.send('GET', '/api/v4/projects/acme%2Fseeded/repository/files/docs%2Fa.md/raw?ref=main', {
            token,
        });
        expect(raw.body).toBe('from a dir\n');
    });

    it('refuses a clone and a push with no token, a bad token or a rotated-out one', async () => {
        const first = await gl.signIn('dev');
        const work = await workRepo('refused');
        await git(work, 'remote', 'add', 'origin', urlFor(null));
        const anonymous = await git(work, 'push', 'origin', 'main:topic');
        expect(anonymous.status).not.toBe(0);
        expect((await git(scratch, 'clone', '-q', urlFor(null), join(scratch, 'anon'))).status).not.toBe(0);
        const bad = await git(scratch, 'clone', '-q', urlFor('gloas-nope'), join(scratch, 'bad'));
        expect(bad.status).not.toBe(0);
        expect(bad.err).toMatch(/Authentication failed|401/);

        await gl.refresh(first.refresh_token);
        await git(work, 'remote', 'set-url', 'origin', urlFor(first.access_token));
        expect((await git(work, 'push', 'origin', 'main:topic')).status).not.toBe(0);
        expect((await pushes()).length).toBe(0);
        const challenge = await fetch(`${gl.base}/${PROJECT}.git/info/refs?service=git-upload-pack`);
        expect(challenge.status).toBe(401);
        expect(challenge.headers.get('www-authenticate')).toMatch(/^Basic /);
    });

    it('lets only a Developer push, and a Guest clone', async () => {
        const { access_token: token } = await gl.signIn('viewer');
        await gl.control('gitlab/members', { project: PROJECT, login: 'viewer', projectAccess: 20 });
        expect((await git(scratch, 'clone', '-q', urlFor(token), join(scratch, 'ro'))).status).toBe(0);
        const work = await workRepo('reporter');
        await git(work, 'remote', 'add', 'origin', urlFor(token));
        expect((await git(work, 'push', 'origin', 'main:topic')).status).not.toBe(0);
        await gl.control('gitlab/members', { project: PROJECT, login: 'viewer' });
        expect((await git(scratch, 'clone', '-q', urlFor(token), join(scratch, 'none'))).status).not.toBe(0);
        expect((await pushes()).length).toBe(0);
    });

    it('records the pushing token, its holder and each new commit author and committer', async () => {
        const { access_token: token } = await gl.signIn('dev');
        const work = join(scratch, 'work');
        await git(scratch, 'clone', '-q', urlFor(token), work);
        writeFileSync(join(work, 'one.txt'), '1\n');
        await git(work, 'add', '.');
        await git(work, 'commit', '-q', '-m', 'one');
        writeFileSync(join(work, 'two.txt'), '2\n');
        await git(work, 'add', '.');
        await git(work, 'commit', '-q', '-m', 'two');
        const head = (await git(work, 'rev-parse', 'HEAD')).out;
        const base = (await git(work, 'rev-parse', 'HEAD~2')).out;
        expect((await git(work, 'push', '-q', 'origin', 'main:topic/new')).status).toBe(0);

        const [push, ...rest] = await pushes();
        expect(rest).toEqual([]);
        expect(push).toMatchObject({ project: PROJECT, holder: 'dev' });
        expect([...tokenIdsSeen('dev')]).toEqual([push?.tokenId]);
        expect(JSON.stringify(push)).not.toContain(token);
        expect(push?.refs).toHaveLength(1);
        const [ref] = push?.refs ?? [];
        expect(ref).toMatchObject({ ref: 'refs/heads/topic/new', before: null, after: head });
        expect(ref?.commits.map((commit) => commit.sha)[0]).toBe(head);
        expect(ref?.commits).toHaveLength(2);
        for (const commit of ref?.commits ?? []) {
            expect(commit.author).toEqual({ name: 'Alice Author', email: 'alice@users.example.test' });
            expect(commit.committer).toEqual({ name: 'Bot Committer', email: 'bot@users.example.test' });
        }
        // the base commit existed before the push, so it is not one of the new commits
        expect(ref?.commits.map((commit) => commit.sha)).not.toContain(base);
        // the push also lands in the call log, apart from the plain HTTP calls
        expect(gl.forge.calls().filter((call) => call.event === 'push')).toHaveLength(1);

        const update = await git(work, 'commit', '-q', '--allow-empty', '-m', 'three');
        expect(update.status).toBe(0);
        expect((await git(work, 'push', '-q', 'origin', 'main:topic/new')).status).toBe(0);
        const second = (await pushes())[1]?.refs[0];
        expect(second?.before).toBe(head);
        expect(second?.commits).toHaveLength(1);
        expect((await git(work, 'push', '-q', 'origin', ':topic/new')).status).toBe(0);
        expect((await pushes())[2]?.refs[0]).toMatchObject({ ref: 'refs/heads/topic/new', after: null, commits: [] });
    });

    it('records the new token after a refresh, and refuses the rotated-out one', async () => {
        const first = await gl.signIn('dev');
        const work = await workRepo('rotate');
        await git(work, 'remote', 'add', 'origin', urlFor(first.access_token));
        expect((await git(work, 'push', '-q', 'origin', 'main:one')).status).toBe(0);
        const rotated = (await gl.refresh(first.refresh_token)).body;
        await git(work, 'remote', 'set-url', 'origin', urlFor(first.access_token));
        expect((await git(work, 'push', '-q', 'origin', 'main:stale')).status).not.toBe(0);
        await git(work, 'remote', 'set-url', 'origin', urlFor(rotated.access_token));
        expect((await git(work, 'push', '-q', 'origin', 'main:two')).status).toBe(0);

        const recorded = await pushes();
        expect(recorded.map((push) => push.refs[0]?.ref)).toEqual(['refs/heads/one', 'refs/heads/two']);
        expect(recorded[0]?.tokenId).not.toBe(recorded[1]?.tokenId);
        expect(recorded.every((push) => push.holder === 'dev')).toBe(true);
    });

    it('serves what was pushed to the REST side, and what merges back to git', async () => {
        const { access_token: token } = await gl.signIn('dev');
        const work = join(scratch, 'work');
        await git(scratch, 'clone', '-q', urlFor(token), work);
        await git(work, 'checkout', '-q', '-b', 'feature');
        writeFileSync(join(work, 'README.md'), 'pushed\n');
        await git(work, 'commit', '-q', '-am', 'edit');
        await git(work, 'push', '-q', 'origin', 'feature');
        const api = `/api/v4/projects/${encodeURIComponent(PROJECT)}`;
        const branch = await gl.send('GET', `${api}/repository/branches/feature`, { token });
        expect(branch.body.commit.id).toBe((await git(work, 'rev-parse', 'HEAD')).out);
        expect(branch.body.commit.author_email).toBe('alice@users.example.test');

        const mr = await gl.send('POST', `${api}/merge_requests`, {
            token,
            body: { source_branch: 'feature', target_branch: 'main', title: 'Edit' },
        });
        expect(mr.body.sha).toBe(branch.body.commit.id);
        const merged = await gl.send('PUT', `${api}/merge_requests/1/merge`, { token, body: { sha: mr.body.sha } });
        expect(merged.status).toBe(200);
        await git(work, 'fetch', '-q', 'origin');
        expect((await git(work, 'rev-parse', 'origin/main')).out).toBe(merged.body.merge_commit_sha);
        expect((await git(work, 'show', 'origin/main:README.md')).out).toBe('pushed');
        expect((await git(work, 'rev-list', '--parents', '-n', '1', 'origin/main')).out.split(' ')).toHaveLength(3);

        // a control commit is a real commit: a fresh clone sees it
        await gl.control('gitlab/commit', { project: PROJECT, branch: 'control', files: { 'c.txt': 'c\n' } });
        const fresh = join(scratch, 'fresh');
        await git(scratch, 'clone', '-q', '-b', 'control', urlFor(token), fresh);
        expect(readFileSync(join(fresh, 'c.txt'), 'utf8')).toBe('c\n');
    });

    it('survives a client that hangs up mid-request', async () => {
        const { access_token: token } = await gl.signIn('dev');
        const port = Number(new URL(gl.base).port);
        await new Promise<void>((resolve) => {
            const hangup = request({
                port,
                host: '127.0.0.1',
                method: 'POST',
                path: `/${PROJECT}.git/git-receive-pack`,
                headers: {
                    authorization: `Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`,
                    'content-type': 'application/x-git-receive-pack-request',
                    'content-length': '4096',
                },
            });
            hangup.on('error', () => resolve());
            hangup.write('0000');
            setTimeout(() => hangup.destroy(), 100);
        });
        const target = join(scratch, 'after');
        expect((await git(scratch, 'clone', '-q', urlFor(token), target)).status).toBe(0);
        expect((await pushes()).length).toBe(0);
    });
});
