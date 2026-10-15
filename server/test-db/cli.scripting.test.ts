import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { run } from '../../cli/src/run.js';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/session.js';
import { createAuthStore } from '../src/auth/store.js';
import { createOrgOfJob, createOrgOfLease, createOrgOfReclaim } from '../src/db/job-store-org-resolvers.js';
import { createOrgRegistry } from '../src/orgs.js';
import { createFactsCache } from '../src/workspace/facts.js';
import { githubAuth, testConfig, TEST_JOB_BOARD_TOKEN } from '../test/helpers-config.js';
import { useTestDb } from './harness.js';
import { randomGithubId, testOrg } from './fixtures.js';

/**
 * The CLI's scripting contract (#596) against the real board: the CLI's own `run` over HTTP to a
 * listening app on a migrated `_test` database, a personal token for the person, the shared board
 * secret for the worker side. No driver, no runner — the worker's calls are made here by hand.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENVELOPE_KEYS = ['command', 'data', 'error', 'exitCode', 'ok', 'outcome'];
const TASK_COUNT = 3;
const WAIT_S = '5';
const LEASE_S = 300;

let app: FastifyInstance;
let boardUrl: string;
let token: string;
let repo: string;

interface Envelope {
    ok: boolean;
    command: string;
    outcome: string;
    exitCode: number;
    data: Record<string, unknown> | null;
    error: { code?: string; status?: number; message: string } | null;
}

beforeEach(async () => {
    if (!enabled) return;
    const sql = db.sql;
    const orgId = testOrg();
    await sql`insert into organization (id, name) values (${orgId}, ${`cli-org-${orgId}`})`;
    const auth = createAuthStore({ sql });
    const login = `cli-${randomUUID().slice(0, 8)}`;
    const caller = await auth.signIn(
        { githubUserId: randomGithubId(), login, displayName: login, avatarUrl: null },
        orgId,
        [{ id: orgId, name: orgId }]
    );
    token = `fat_${randomUUID()}`;
    await auth.createAccessToken({
        kind: 'personal',
        orgId,
        userId: caller.user.id,
        createdBy: caller.user.id,
        label: 'cli scripting',
        tokenHash: hashToken(token),
    });
    // What a finished clone leaves: the board refuses a create whose repo is not the caller's ready checkout.
    const name = `repo-${randomUUID().slice(0, 8)}`;
    repo = `cli-owner/${name}`;
    await sql`insert into user_repo (org_id, user_id, repo_owner, repo_name, status)
              values (${orgId}, ${caller.user.id}, 'cli-owner', ${name}, 'ready')`;

    const ready = Promise.resolve();
    const config = testConfig({ auth: githubAuth() });
    app = await buildApp({
        config,
        orgs: createOrgRegistry({ sql, ready, config, withStores: true, facts: createFactsCache() }),
        auth,
        orgOfLease: createOrgOfLease({ sql, ready }),
        orgOfJob: createOrgOfJob({ sql, ready }),
        orgOfReclaim: createOrgOfReclaim({ sql, ready }),
        ready,
        version: '0.0.0',
    });
    boardUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
    if (enabled) await app?.close();
});

/** The worker's side of the board, exactly as the driver calls it: the shared board secret. */
async function worker(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${boardUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_JOB_BOARD_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(response.ok, `${path}: ${response.status} ${await response.clone().text()}`).toBe(true);
    return (await response.json()) as Record<string, unknown>;
}

async function claim(id: string): Promise<string> {
    const claimed = await worker('/api/jobs/claim', { worker: 'cli-scripting', leaseSeconds: LEASE_S });
    expect(claimed.id).toBe(id);
    return claimed.leaseToken as string;
}

interface CliOptions {
    stdin?: string;
    fetch?: typeof globalThis.fetch;
    env?: NodeJS.ProcessEnv;
}

/**
 * One CLI invocation in-process, through the same `run` the binary calls. Every --json call is
 * held to the one envelope contract, which is what makes the commands consistent with each other.
 */
async function cli(argv: string[], options: CliOptions = {}): Promise<{ code: number; env: Envelope }> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await run(argv, {
        env: { FACTORY_URL: boardUrl, FACTORY_TOKEN: token, FACTORY_READ_RETRIES: '2', ...options.env },
        // A default path that never exists: the developer's own ~/.bellows/settings.json stays out.
        settings: { path: join(tmpdir(), `bellows-absent-${randomUUID()}`, 'settings.json'), explicit: false },
        fetch: options.fetch,
        readStdin: async () => options.stdin ?? '',
        sleep: async () => {},
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
    });
    expect(stderr.join('')).toBe('');
    const env = JSON.parse(stdout.join('')) as Envelope;
    expect(Object.keys(env).sort()).toEqual(ENVELOPE_KEYS);
    expect(env.exitCode).toBe(code);
    expect(env.ok).toBe(code === 0);
    if (env.ok) expect(env.error).toBeNull();
    return { code, env };
}

/** A fetch that lets the first create reach the board and commit, then loses its answer. */
function losingFirstCreate(): typeof globalThis.fetch {
    let lost = false;
    return async (input, init) => {
        const response = await fetch(input, init);
        const isCreate = init?.method === 'POST' && new URL(String(input)).pathname === '/api/jobs';
        if (isCreate && !lost) {
            lost = true;
            await response.text();
            throw new TypeError('fetch failed');
        }
        return response;
    };
}

async function jobRows(): Promise<number> {
    const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from job`;
    return row!.n;
}

const created = (env: Envelope) => env.data as { id: string; status: string; replayed?: boolean };

describe.skipIf(!enabled)('CLI scripting against the real board', () => {
    it('scripts a task: multiline stdin create, a pending question answered, failure told apart, retry', async () => {
        const command = 'line one\nline two ✓\n';
        const create = await cli(
            ['job', 'create', '--repo', repo, '--stdin', '--idempotency-key', `k-${randomUUID()}`, '--json'],
            {
                stdin: command,
            }
        );
        expect(create.code).toBe(0);
        const { id, status } = created(create.env);
        expect(status).toBe('queued');

        const detail = await cli(['job', 'investigate', id, '--json']);
        expect(detail.code).toBe(0);
        expect(JSON.stringify(detail.env.data)).toContain(JSON.stringify(command));

        const lease = await claim(id);
        const questionId = `toolu_${randomUUID().slice(0, 8)}`;
        await worker(`/api/jobs/${id}/question`, {
            leaseToken: lease,
            questionId,
            questions: [
                {
                    question: 'Which database?',
                    header: 'Database',
                    multiSelect: false,
                    options: [{ label: 'Postgres', description: 'The default' }, { label: 'SQLite' }],
                },
            ],
        });

        const pending = await cli(['job', 'questions', id, '--json']);
        expect(pending.code).toBe(0);
        expect(JSON.stringify(pending.env.data)).toContain(questionId);

        const answered = await cli(['job', 'answer', id, questionId, '--answer', 'Postgres', '--json']);
        expect(answered.code).toBe(0);
        const again = await cli(['job', 'answer', id, questionId, '--answer', 'SQLite', '--json']);
        expect(again.code).toBe(1);
        expect(again.env.error).toMatchObject({ code: 'QUESTION_ANSWERED', status: 409 });

        const beat = await worker(`/api/jobs/${id}/heartbeat`, { leaseToken: lease, leaseSeconds: LEASE_S });
        expect(JSON.stringify(beat.answeredQuestions)).toContain('Postgres');

        await worker(`/api/jobs/${id}/complete`, { leaseToken: lease, status: 'failed', exitCode: 1 });
        const failed = await cli(['job', 'wait', id, '--timeout', WAIT_S, '--json']);
        expect(failed.code).toBe(4);
        expect(failed.env.outcome).toBe('failed');
        expect(failed.env.data).not.toBeNull();
        expect(failed.env.error).toBeNull();

        const retry = await cli(['job', 'retry', id, '--idempotency-key', `r-${randomUUID()}`, '--json']);
        expect(retry.code).toBe(0);
        const retried = created(retry.env).id;
        expect(retried).not.toBe(id);

        const retryLease = await claim(retried);
        await worker(`/api/jobs/${retried}/complete`, { leaseToken: retryLease, status: 'succeeded', exitCode: 0 });
        const succeeded = await cli(['job', 'wait', retried, '--timeout', WAIT_S, '--json']);
        expect(succeeded.code).toBe(0);
        expect(succeeded.env.outcome).toBe('succeeded');
    });

    it('recovers a committed create whose answer was lost by repeating it under the same key', async () => {
        const key = `k-${randomUUID()}`;
        const argv = ['job', 'create', '--repo', repo, 'echo once', '--idempotency-key', key, '--json'];
        const lost = await cli(argv, { fetch: losingFirstCreate(), env: { FACTORY_READ_RETRIES: '0' } });
        expect(lost.code).toBe(7);
        expect(lost.env.outcome).toBe('unreachable');
        expect(lost.env.error?.message).toContain(`--idempotency-key ${key}`);
        expect(await jobRows()).toBe(1);

        const repeated = await cli(argv);
        expect(repeated.code).toBe(0);
        expect(created(repeated.env).replayed).toBe(true);
        expect(await jobRows()).toBe(1);
    });

    it('a keyed create the transport re-issues returns the task the first attempt made', async () => {
        const key = `k-${randomUUID()}`;
        const result = await cli(['job', 'create', '--repo', repo, 'echo once', '--idempotency-key', key, '--json'], {
            fetch: losingFirstCreate(),
        });
        expect(result.code).toBe(0);
        expect(created(result.env).replayed).toBe(true);
        expect(await jobRows()).toBe(1);
    });

    it('an unkeyed lost create is reported uncertain and never re-issued', async () => {
        const result = await cli(['job', 'create', '--repo', repo, 'echo once', '--json'], {
            fetch: losingFirstCreate(),
        });
        expect(result.code).toBe(7);
        expect(result.env.error?.message).toContain('check the task list');
        expect(await jobRows()).toBe(1);
    });

    it('refuses a key reused for a different command', async () => {
        const key = `k-${randomUUID()}`;
        expect(
            (await cli(['job', 'create', '--repo', repo, 'echo one', '--idempotency-key', key, '--json'])).code
        ).toBe(0);
        const reused = await cli(['job', 'create', '--repo', repo, 'echo two', '--idempotency-key', key, '--json']);
        expect(reused.code).toBe(1);
        expect(reused.env.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
        expect(await jobRows()).toBe(1);
    });

    it('traverses the task list by cursor, and refuses a cursor under other filters', async () => {
        const ids = new Set<string>();
        for (let n = 0; n < TASK_COUNT; n++) {
            ids.add(created((await cli(['job', 'create', '--repo', repo, `echo ${n}`, '--json'])).env).id);
        }
        const seen: string[] = [];
        let cursor: string | null = null;
        let firstCursor: string | null = null;
        do {
            const argv = ['task', 'list', '--limit', '1', '--json', ...(cursor ? ['--cursor', cursor] : [])];
            const page = await cli(argv);
            expect(page.code).toBe(0);
            const data = page.env.data as { tasks: { id: string }[]; nextCursor: string | null };
            seen.push(...data.tasks.map((item) => item.id));
            cursor = data.nextCursor;
            firstCursor ??= cursor;
        } while (cursor !== null);
        expect(new Set(seen)).toEqual(ids);
        expect(seen).toHaveLength(TASK_COUNT);

        const mismatched = await cli(['task', 'list', '--sort', 'oldest', '--cursor', firstCursor!, '--json']);
        expect(mismatched.code).toBe(1);
        expect(mismatched.env.error).toMatchObject({ code: 'BAD_CURSOR' });
    });

    it('runs through one npm layer, multiline stdin and all', async () => {
        // An empty settings file named by --config keeps the developer's own ~/.bellows out, and
        // proves the flag survives the npm layer.
        const settings = join(mkdtempSync(join(tmpdir(), 'bellows-settings-')), 'settings.json');
        writeFileSync(settings, '{}');
        const child = spawn(
            'npm',
            [
                'run',
                '--silent',
                'dev',
                '-w',
                'cli',
                '--',
                'job',
                'create',
                '--repo',
                repo,
                '--stdin',
                '--json',
                '--config',
                settings,
            ],
            {
                cwd: REPO_ROOT,
                // Only what npm needs to start: no FACTORY_* from the developer's shell reaches the CLI.
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    FACTORY_URL: boardUrl,
                    FACTORY_TOKEN: token,
                    FACTORY_READ_RETRIES: '0',
                    FACTORY_REQUEST_TIMEOUT_S: '30',
                },
            }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        const command = 'first line\nsecond line\n';
        child.stdin.end(command);
        try {
            const code = await new Promise<number | null>((resolve, reject) => {
                child.on('error', reject);
                child.on('close', resolve);
            });
            expect(code, `${stdout}\n${stderr}`).toBe(0);
        } finally {
            child.kill();
        }
        const envelope = JSON.parse(stdout) as Envelope;
        expect(envelope).toMatchObject({ ok: true, command: 'job create', exitCode: 0 });
        const [row] = await db.sql<{ command: string }[]>`select command from job where id = ${created(envelope).id}`;
        expect(row?.command).toBe(command);
    }, 60_000);
});
