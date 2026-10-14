import { describe, expect, it } from 'vitest';
import { refusal, runCli, type Sent } from './harness.js';

const KEY = 'attempt-0001-abcd';

/** One CLI run against a board whose answer is chosen per request, recording what was sent. */
async function cli(argv: string[], respond: (sent: Sent) => Response) {
    const result = await runCli(argv, respond);
    return { ...result, sent: result.sent.map(({ url, method, key, body }) => ({ url, method, key, body })) };
}

/** A board that accepts a retry as the new run `run-2`. */
const retryBoard = () => () => Response.json({ id: 'run-2', status: 'queued' }, { status: 201 });

describe('factory job retry', () => {
    it('posts a bodiless retry and names the new run, not the one retried', async () => {
        const result = await cli(['job', 'retry', 'run-1', '--json'], retryBoard());

        expect(result.code).toBe(0);
        expect(result.sent).toEqual([
            { url: 'http://board/api/jobs/run-1/retry', method: 'POST', key: null, body: undefined },
        ]);
        expect(JSON.parse(result.out).data).toEqual({ id: 'run-2', status: 'queued' });
    });

    it('prints the new run on one line, as a create does', async () => {
        const result = await cli(['job', 'retry', 'run-1'], retryBoard());

        expect(result.out).toBe('queued run-2\n');
    });

    it("surfaces the board's refusal", async () => {
        const result = await cli(['job', 'retry', 'run-1'], () =>
            refusal(409, 'NOT_FINISHED', 'Task is still running')
        );

        expect(result.code).toBe(1);
        expect(result.err).toContain('Task is still running');
        expect(result.err).toContain('NOT_FINISHED');
        expect(result.sent).toHaveLength(1);
    });

    it('surfaces a non-author refusal as the board worded it', async () => {
        const result = await cli(['job', 'retry', 'run-1'], () =>
            refusal(403, 'FORBIDDEN', 'Only the author can retry')
        );

        expect(result.code).toBe(1);
        expect(result.err).toContain('Only the author can retry');
    });

    it('says an unanswered write may have been applied, naming the key to repeat', async () => {
        const result = await cli(['job', 'retry', 'run-1', '--idempotency-key', KEY], () =>
            refusal(500, 'INTERNAL', 'boom')
        );

        expect(result.code).toBe(1);
        expect(result.err).toContain(`--idempotency-key ${KEY}`);
    });

    it('is a usage error without exactly one id, making no request', async () => {
        const none = await cli(['job', 'retry'], retryBoard());
        const two = await cli(['job', 'retry', 'a', 'b'], retryBoard());

        expect([none.code, two.code]).toEqual([2, 2]);
        expect([...none.sent, ...two.sent]).toEqual([]);
    });
});

describe('factory job edit', () => {
    it('patches the joined command onto the run and prints its id, still queued', async () => {
        const result = await cli(['job', 'edit', 'run-1', '--', 'npm', 'test'], () =>
            Response.json({ id: 'run-1', status: 'queued', command: 'npm test' })
        );

        expect(result.code).toBe(0);
        expect(result.out).toBe('queued run-1\n');
        expect(result.sent).toEqual([
            { url: 'http://board/api/jobs/run-1', method: 'PATCH', key: null, body: { command: 'npm test' } },
        ]);
    });

    it('shows the board answer in the envelope', async () => {
        const payload = { id: 'run-1', status: 'queued', command: 'again' };
        const result = await cli(['job', 'edit', 'run-1', 'again', '--json'], () => Response.json(payload));

        expect(JSON.parse(result.out)).toMatchObject({ ok: true, command: 'job edit', data: payload });
    });

    it('refuses once the board says the run is no longer queued', async () => {
        const result = await cli(['job', 'edit', 'run-1', 'again'], () =>
            refusal(409, 'NOT_QUEUED', "Task is running — only a queued task's command can be edited")
        );

        expect(result.code).toBe(1);
        expect(result.err).toContain('NOT_QUEUED');
    });

    it('surfaces a non-author refusal', async () => {
        const result = await cli(['job', 'edit', 'run-1', 'again'], () =>
            refusal(403, 'FORBIDDEN', 'Only the account that queued the task can edit its command')
        );

        expect(result.code).toBe(1);
        expect(result.err).toContain('Only the account that queued the task');
    });

    it('is a usage error with no id or no command, making no request', async () => {
        const noId = await cli(['job', 'edit'], () => Response.json({}));
        const noCommand = await cli(['job', 'edit', 'run-1'], () => Response.json({}));

        expect([noId.code, noCommand.code]).toEqual([2, 2]);
        expect([...noId.sent, ...noCommand.sent]).toEqual([]);
    });
});

describe('factory job reopen', () => {
    it('posts the reopen and says so', async () => {
        const result = await cli(['job', 'reopen', 'task-1'], () => Response.json({ id: 'task-1', reopened: true }));

        expect(result.code).toBe(0);
        expect(result.out).toBe('reopened task-1\n');
        expect(result.sent).toEqual([
            { url: 'http://board/api/jobs/task-1/reopen', method: 'POST', key: null, body: undefined },
        ]);
    });

    it('surfaces a refusal after the task changed state', async () => {
        const result = await cli(['job', 'reopen', 'task-1'], () => refusal(409, 'TASK_NOT_DONE', 'Task is not done'));

        expect(result.code).toBe(1);
        expect(result.err).toContain('TASK_NOT_DONE');
    });

    it('is a usage error without exactly one id', async () => {
        const result = await cli(['job', 'reopen'], () => Response.json({}));

        expect(result.code).toBe(2);
        expect(result.sent).toEqual([]);
    });
});
