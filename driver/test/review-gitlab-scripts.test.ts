import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { HELPER_REGISTRY, scriptBodyFor } from '../src/helpers.js';
import { REVIEW_COLLECT_PROBE_ID, REVIEW_REPLY_PROBE_ID } from '../src/review/review-helpers.js';
import { githubRef } from './fixtures/repo-ref.js';

/**
 * The GitLab helper bodies (BEL-539): the composed `review-collect-probe` / `review-reply-probe` of a GitLab job carry
 * the attempt's pair to the board's review routes and decide on what it answers, with the unmodified prelude, middle and
 * postlude. A local HTTP stub plays the board. Nothing that is not a complete answer may read as a clean review.
 */

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const LEASE = '22222222-2222-4222-8222-222222222222';
const STATE_DIR = '.factory/review-reconcile';
const tempDirs: string[] = [];
let server: Server | null = null;

afterEach(async () => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
});

const gitlabJob = { repo: { forge: 'gitlab', host: 'board.gitlab.test', path: 'grp/web' } } as unknown as BoardJob;
const githubJob = { repo: githubRef('acme/web') } as unknown as BoardJob;

interface Seen {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
}

/** A board stub answering each request in turn with `answers`; the last answer repeats. */
async function board(answers: ((res: ServerResponse) => void)[]): Promise<{ url: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            seen.push({
                method: req.method ?? '',
                url: req.url ?? '',
                headers: req.headers,
                body: Buffer.concat(chunks).toString(),
            });
            answers[Math.min(seen.length, answers.length) - 1]!(res);
        });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
}

const json = (status: number, body: unknown) => (res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};
const raw = (status: number, text: string) => (res: ServerResponse) => {
    res.writeHead(status).end(text);
};
const reset = (res: ServerResponse) => {
    res.socket?.destroy();
};
const prematureClose = (res: ServerResponse) => {
    res.writeHead(200, { 'content-length': '1000' });
    res.write('{"schema":');
    setTimeout(() => res.socket?.destroy(), 10);
};
const never = () => undefined;

const collection = (over: Record<string, unknown> = {}) => ({
    version: 1,
    schema: 'review-collect/v1',
    ref: { owner: 'grp', repo: 'web', number: 7 },
    general: [],
    reviews: [],
    inline: [],
    threads: [],
    addressed: [],
    requestedReviewers: { users: [], teams: [] },
    decision: null,
    pendingChecks: 0,
    truncated: { sections: [], bodies: 0, diffHunks: 0, threads: 0, total: false },
    ...over,
});
const thread = (id: string) => ({
    id,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 3,
    comments: [{ id: '5', databaseId: 5, author: 'rev-one', body: 'please rename', createdAt: null }],
});

interface Probe {
    stdout: string;
    verdict: Record<string, unknown>;
    cwd: string;
}

async function probe(
    id: string,
    boardUrl: string | null,
    opts: { cwd?: string; env?: Record<string, string>; job?: BoardJob } = {}
): Promise<Probe> {
    const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'review-gitlab-'));
    tempDirs.push(cwd);
    const body = scriptBodyFor(HELPER_REGISTRY.get(id)!, opts.job ?? gitlabJob);
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        HELPER_INPUT: JSON.stringify({ publication: { repo: 'grp/web', prNumber: 7 } }),
        ...(boardUrl === null ? {} : { FACTORY_STATS_URL: boardUrl, RUNNER_JOB_ID: JOB_ID, RUNNER_LEASE_TOKEN: LEASE }),
        ...opts.env,
    };
    const child = spawn(process.execPath, ['-e', body], { cwd, env });
    let stdout = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    await new Promise((resolve) => child.on('close', resolve));
    return { stdout, verdict: JSON.parse(stdout.trim().split('\n').filter(Boolean).pop()!), cwd };
}

const fastDeadline = { REVIEW_GITLAB_DEADLINE_MS: '300' };

describe('the GitLab collect body', () => {
    it('carries the attempt pair to the collect route and answers REVIEW-ACTIONABLE with a digest', async () => {
        const b = await board([json(200, collection({ threads: [thread('abc123')] }))]);
        const { verdict, cwd } = await probe(REVIEW_COLLECT_PROBE_ID, b.url);
        expect(verdict).toMatchObject({ ok: true, output: 'REVIEW-ACTIONABLE' });
        expect(b.seen).toHaveLength(1);
        expect(b.seen[0]).toMatchObject({ method: 'GET', url: `/api/jobs/${JOB_ID}/agent-review` });
        expect(b.seen[0]!.headers).toMatchObject({ 'x-factory-job-id': JOB_ID, 'x-factory-job-lease-token': LEASE });
        const digest = JSON.parse(readFileSync(join(cwd, STATE_DIR, 'digest.json'), 'utf8'));
        expect(digest.items).toMatchObject([{ key: 'thread:abc123', path: 'src/a.ts' }]);
    });

    it('waits on a running check and is clean with nothing at all', async () => {
        const waiting = await probe(
            REVIEW_COLLECT_PROBE_ID,
            (await board([json(200, collection({ pendingChecks: 1 }))])).url
        );
        expect(waiting.verdict).toMatchObject({ ok: true, output: 'REVIEW-WAIT', control: 'conclude' });
        await server?.close();
        const clean = await probe(REVIEW_COLLECT_PROBE_ID, (await board([json(200, collection())])).url);
        expect(clean.verdict).toMatchObject({ ok: true, output: 'REVIEW-CLEAN', control: 'conclude' });
    });

    it.each([
        ['a 503', json(503, { message: 'down' })],
        ['a 404 (the route is not registered)', json(404, {})],
        ['a non-JSON 200', raw(200, 'hello')],
        ['another schema', json(200, { ...collection(), schema: 'something/v9' })],
        ['a reset connection', reset],
        ['a premature close', prematureClose],
        ['a board that never answers', never],
    ])('is a runner_error, never a clean review, for %s', async (_name, answer) => {
        const b = await board([answer]);
        const { verdict, stdout } = await probe(REVIEW_COLLECT_PROBE_ID, b.url, { env: fastDeadline });
        expect(verdict).toMatchObject({ ok: false, reason: 'runner_error' });
        expect(stdout).not.toContain('REVIEW-CLEAN');
        expect(stdout).not.toContain(LEASE);
    });

    it('answers forge_wait for a held grant', async () => {
        const b = await board([json(409, { code: 'FORGE_GRANT_REQUIRED', message: 'grant', waiting: true })]);
        const { verdict } = await probe(REVIEW_COLLECT_PROBE_ID, b.url);
        expect(verdict).toMatchObject({ schema: 'review-collect-probe/v1', ok: false, reason: 'forge_wait' });
    });

    it('is a runner_error without the pair, asking nothing', async () => {
        const b = await board([json(200, collection())]);
        const { verdict } = await probe(REVIEW_COLLECT_PROBE_ID, null);
        expect(verdict).toMatchObject({ ok: false, reason: 'runner_error' });
        expect(b.seen).toEqual([]);
    });
});

describe('the GitLab reply body', () => {
    /** A worktree whose digest presents `keys` and whose repair agent declared a reply and a resolve for each. */
    function worktree(keys: string[]): string {
        const cwd = mkdtempSync(join(tmpdir(), 'review-gitlab-'));
        mkdirSync(join(cwd, STATE_DIR), { recursive: true });
        writeFileSync(
            join(cwd, STATE_DIR, 'digest.json'),
            JSON.stringify({ schema: 'review-reconcile-digest/v1', version: 1, items: keys.map((key) => ({ key })) })
        );
        writeFileSync(
            join(cwd, STATE_DIR, 'intents.json'),
            JSON.stringify({
                schema: 'review-reconcile-intents/v1',
                version: 1,
                items: keys.map((key) => ({ key, reply: 'done', resolve: true })),
            })
        );
        return cwd;
    }
    const live = collection({ threads: [thread('d1'), thread('d2')] });
    const verdictOf = (results: unknown[]) => ({
        version: 1,
        schema: 'review-reply/v1',
        ref: live.ref,
        results,
        error: null,
    });

    it('re-collects, posts the plan of marked targets and concludes REVIEW-REPLIED on a done verdict', async () => {
        const b = await board([
            json(200, live),
            json(200, verdictOf([{ id: 'd1', kind: 'thread', status: 'done', reason: null }])),
        ]);
        const cwd = worktree(['thread:d1', 'thread:d2']);
        const { verdict } = await probe(REVIEW_REPLY_PROBE_ID, b.url, { cwd });
        expect(verdict).toMatchObject({ ok: true, output: 'REVIEW-REPLIED', control: 'conclude' });
        expect(b.seen.map((s) => `${s.method} ${s.url}`)).toEqual([
            `GET /api/jobs/${JOB_ID}/agent-review`,
            `POST /api/jobs/${JOB_ID}/agent-review/replies`,
        ]);
        expect(b.seen[1]!.headers['x-factory-job-lease-token']).toBe(LEASE);
        const plan = JSON.parse(b.seen[1]!.body);
        expect(plan.schema).toBe('review-reply/plan/v1');
        const replies = plan.targets.filter((t: { kind: string }) => t.kind === 'thread');
        expect(replies.map((t: { id: string }) => t.id).sort()).toEqual(['d1', 'd2']);
        for (const t of replies)
            expect(t.reply).toContain(`<!-- factory-review-reconcile addressed thread:${t.id} -->`);
        expect(plan.targets.filter((t: { kind: string }) => t.kind === 'resolve')).toHaveLength(2);
    });

    it('posts nothing when the collect failed', async () => {
        const b = await board([json(503, {})]);
        const { verdict } = await probe(REVIEW_REPLY_PROBE_ID, b.url, { cwd: worktree(['thread:d1']) });
        expect(verdict).toMatchObject({ ok: false });
        expect(b.seen).toHaveLength(1);
    });

    it.each([
        ['a refused result', json(200, verdictOf([{ id: 'd1', kind: 'thread', status: 'refused', reason: 'auth' }]))],
        ['a 503', json(503, {})],
        ['a reset', reset],
        ['a board that never answers', never],
    ])('is ok:false for %s', async (_name, answer) => {
        const b = await board([json(200, live), answer]);
        const { verdict } = await probe(REVIEW_REPLY_PROBE_ID, b.url, {
            cwd: worktree(['thread:d1']),
            env: fastDeadline,
        });
        expect(verdict).toMatchObject({ ok: false });
        expect(verdict.reason).toBe('runner_error');
    });

    it('answers forge_wait for a held grant on the reply', async () => {
        const b = await board([json(200, live), json(409, { code: 'FORGE_GRANT_REQUIRED', waiting: true })]);
        const { verdict } = await probe(REVIEW_REPLY_PROBE_ID, b.url, { cwd: worktree(['thread:d1']) });
        expect(verdict).toMatchObject({ schema: 'review-reply-probe/v1', ok: false, reason: 'forge_wait' });
    });
});

describe('which body a job runs', () => {
    it('gives a GitHub job the gh body byte for byte, and a GitLab job its own', () => {
        for (const id of [REVIEW_COLLECT_PROBE_ID, REVIEW_REPLY_PROBE_ID]) {
            const descriptor = HELPER_REGISTRY.get(id)!;
            expect(scriptBodyFor(descriptor, githubJob)).toBe(descriptor.scriptBody);
            expect(scriptBodyFor(descriptor, gitlabJob)).toBe(descriptor.gitlabScriptBody);
            expect(descriptor.gitlabScriptBody).not.toBe(descriptor.scriptBody);
        }
    });

    it('keeps merge-conflict-probe on its single body for a GitLab job', () => {
        const descriptor = HELPER_REGISTRY.get('merge-conflict-probe')!;
        expect(descriptor.gitlabScriptBody).toBeUndefined();
        expect(scriptBodyFor(descriptor, gitlabJob)).toBe(descriptor.scriptBody);
    });
});
