import { describe, expect, it } from 'vitest';
import { json, refusal, runCli } from './harness.js';

const BATCH = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '3f2b6c1e-0000-4000-8000-000000000001';

/** `argv` with `--json` among the options: before a create's `--`, which starts the task's own command. */
function withJson(argv: readonly string[]): string[] {
    const end = argv.indexOf('--');
    return end === -1 ? [...argv, '--json'] : [...argv.slice(0, end), '--json', ...argv.slice(end)];
}

// Every verb surfaces a board refusal the same way: exit 1 with the board's words and code on
// stderr, and under --json one `refused` envelope carrying the code and status. `requests` pins
// how many requests were sent where a single write must not be repeated.
const REFUSALS: {
    label: string;
    argv: string[];
    status: number;
    code: string;
    message: string;
    requests?: number;
}[] = [
    {
        label: 'job follow-up on an unfinished parent',
        argv: ['job', 'follow-up', 'job-1', 'again'],
        status: 409,
        code: 'NOT_FINISHED',
        message: 'Task is still running',
    },
    {
        label: 'job retry of an unfinished run',
        argv: ['job', 'retry', 'run-1'],
        status: 409,
        code: 'NOT_FINISHED',
        message: 'Task is still running',
        requests: 1,
    },
    {
        label: 'job retry by a non-author',
        argv: ['job', 'retry', 'run-1'],
        status: 403,
        code: 'FORBIDDEN',
        message: 'Only the author can retry',
    },
    {
        label: 'job retry refused with a terse message',
        argv: ['job', 'retry', 'job-1'],
        status: 403,
        code: 'FORBIDDEN',
        message: 'nope',
    },
    {
        label: 'job remove of a running task',
        argv: ['job', 'remove', 'job-1', '--yes'],
        status: 409,
        code: 'TASK_RUNNING',
        message: 'The task is still running — stop it first',
    },
    {
        label: 'job edit of a run no longer queued',
        argv: ['job', 'edit', 'run-1', 'again'],
        status: 409,
        code: 'NOT_QUEUED',
        message: "Task is running — only a queued task's command can be edited",
    },
    {
        label: 'job edit by a non-author',
        argv: ['job', 'edit', 'run-1', 'again'],
        status: 403,
        code: 'FORBIDDEN',
        message: 'Only the account that queued the task can edit its command',
    },
    {
        label: 'job reopen after the task changed state',
        argv: ['job', 'reopen', 'task-1'],
        status: 409,
        code: 'TASK_NOT_DONE',
        message: 'Task is not done',
    },
    {
        label: 'job create with an inaccessible Jira connection',
        argv: ['job', 'create', '--connection', CONNECTION, '--', 'npm test'],
        status: 403,
        code: 'CONNECTION_NOT_AUTHORIZED',
        message: 'That Jira connection does not exist or is not available to you. Pick one from GET /api/connections.',
    },
    {
        label: 'task list with a cursor issued for another query',
        argv: ['task', 'list', '--state', 'past', '--cursor', 'stale'],
        status: 400,
        code: 'BAD_CURSOR',
        message: 'cursor was not issued by this endpoint for this query',
    },
    {
        label: 'repo list with no board runtime',
        argv: ['repo', 'list'],
        status: 503,
        code: 'REPOS_UNAVAILABLE',
        message: "No runtime for 'o'; retry",
    },
    {
        label: 'connection list with no store',
        argv: ['connection', 'list'],
        status: 503,
        code: 'CONNECTIONS_UNAVAILABLE',
        message: 'No connection store for this organization',
    },
    {
        label: 'batch cancel not available',
        argv: ['batch', 'cancel', BATCH],
        status: 409,
        code: 'BATCH_UNSUPPORTED',
        message: 'Batch cancel is not available yet',
    },
    {
        label: 'batch accept of an unknown task',
        argv: ['batch', 'accept', BATCH, 'zzz'],
        status: 404,
        code: 'NOT_FOUND',
        message: 'No such task',
        requests: 1,
    },
];

describe('a board refusal', () => {
    it.each(REFUSALS)('$label exits 1, worded on stderr and refused under --json', async (row) => {
        const answer = () => refusal(row.status, row.code, row.message);

        const human = await runCli(row.argv, answer);
        expect(human.code).toBe(1);
        expect(human.err).toContain(row.message);
        expect(human.err).toContain(`[${row.code}]`);
        if (row.requests !== undefined) expect(human.sent).toHaveLength(row.requests);

        const machine = await runCli(withJson(row.argv), answer);
        expect(machine.code).toBe(1);
        expect(machine.err).toBe('');
        const envelope = JSON.parse(machine.out);
        expect(envelope).toMatchObject({ ok: false, outcome: 'refused', exitCode: 1 });
        expect(envelope.error).toMatchObject({ code: row.code, status: row.status });
        expect(envelope.error.message).toContain(row.message);
    });
});

// A command line the CLI cannot act on exits 2 before any request. `stderr` is what the refusal
// must name; null where the line asks for --json, so stderr stays empty by contract.
const USAGE: { label: string; argv: string[]; stderr: string | null }[] = [
    {
        label: 'job create with a scope outside user|org',
        argv: ['job', 'create', '--executor', 'main', '--executor-scope', 'repo', '--', 'npm test'],
        stderr: '--executor-scope',
    },
    { label: 'job follow-up with an id but no command', argv: ['job', 'follow-up', 'job-1'], stderr: 'usage:' },
    { label: 'job retry with no id', argv: ['job', 'retry'], stderr: 'usage:' },
    { label: 'job retry with two ids', argv: ['job', 'retry', 'job-1', 'job-2'], stderr: 'usage:' },
    { label: 'job retry with an unknown flag', argv: ['job', 'retry', 'job-1', '--frob'], stderr: '--frob' },
    { label: 'job edit with no id', argv: ['job', 'edit'], stderr: 'usage:' },
    { label: 'job edit with no command', argv: ['job', 'edit', 'run-1'], stderr: 'usage:' },
    { label: 'job reopen with no id', argv: ['job', 'reopen'], stderr: 'usage:' },
    {
        label: 'job preflight with a command positional',
        argv: ['job', 'preflight', '--repo', 'acme/api', 'npm', 'test', '--json'],
        stderr: null,
    },
    { label: 'repo list with a stray argument', argv: ['repo', 'list', 'acme/api'], stderr: 'usage:' },
    { label: 'auth status with a stray argument', argv: ['auth', 'status', 'extra'], stderr: 'usage:' },
    { label: 'batch retry missing its task', argv: ['batch', 'retry', BATCH], stderr: 'usage:' },
    { label: 'batch report with no id', argv: ['batch', 'report'], stderr: 'usage:' },
];

describe('a usage error', () => {
    it.each(USAGE)('$label exits 2, making no request', async ({ argv, stderr }) => {
        const result = await runCli(argv, () => json({}));

        expect(result.code).toBe(2);
        if (stderr !== null) expect(result.err).toContain(stderr);
        expect(result.sent).toEqual([]);
    });
});
