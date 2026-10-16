import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateServer } from '../src/gates.js';
import { createStepBroker, StepChannelClosed, StepTimedOut } from '../src/step-control.js';
import { MAILBOX_FILES, STEP_ANSWER_GRACE_MS, type StepRequest, type StepResult } from '../src/supervisor-contract.js';

/**
 * The supervised-step channel (issue #771): the broker the runners submit to, the control routes
 * the supervisor pulls them through, and — against the real supervisor script — the whole round trip.
 */
process.env.SUPERVISOR_NO_MAIN = '1';

const step = (id: string, over: Partial<StepRequest> = {}): StepRequest => ({
    id,
    kind: 'probe',
    argv: ['node', '-e', 'console.log(1)'],
    env: {},
    timeoutMs: 1_000,
    ...over,
});
const result = (stdout = 'ok'): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const never = new AbortController().signal;

describe('the step broker', () => {
    it('hands a submitted step to the supervisor’s poll and answers the submitter with its result', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const answered = broker.submit('t', step('s1'));
        expect(await broker.next('t', 0, never)).toMatchObject({ id: 's1' });
        expect(broker.settle('t', 's1', result('done'))).toBe(true);
        expect(await answered).toEqual(result('done'));
    });

    it('holds a poll open until a step arrives, and answers null when none came in time', async () => {
        const broker = createStepBroker();
        broker.open('t');
        expect(await broker.next('t', 20, never)).toBeNull();
        const waiting = broker.next('t', 5_000, never);
        void broker.submit('t', step('late'));
        expect(await waiting).toMatchObject({ id: 'late' });
    });

    it('joins a step id already in flight, and answers a settled one from its record', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const first = broker.submit('t', step('same'));
        const joined = broker.submit('t', step('same'));
        // One step is queued, not two: the retry is the same operation.
        expect(await broker.next('t', 0, never)).toMatchObject({ id: 'same' });
        expect(await broker.next('t', 0, never)).toBeNull();
        broker.settle('t', 'same', result('once'));
        expect(await first).toEqual(result('once'));
        expect(await joined).toEqual(result('once'));
        expect(await broker.submit('t', step('same'))).toEqual({ ...result('once'), replayed: true });
    });

    it('rejects every waiter when the token closes, and refuses a step for a token that never opened', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const pending = broker.submit('t', step('s1'));
        const report = broker.awaitReport('t');
        broker.close('t');
        await expect(pending).rejects.toBeInstanceOf(StepChannelClosed);
        await expect(report).rejects.toBeInstanceOf(StepChannelClosed);
        await expect(broker.submit('t', step('s2'))).rejects.toBeInstanceOf(StepChannelClosed);
        expect(await broker.next('t', 0, never)).toBe('closed');
    });

    it('counts a step whose answer never comes as lost, and queues a retry under the same id afresh', async () => {
        vi.useFakeTimers();
        try {
            const broker = createStepBroker();
            broker.open('t');
            const lost = broker.submit('t', step('s1', { timeoutMs: 1_000 }));
            const caught = expect(lost).rejects.toBeInstanceOf(StepTimedOut);
            await vi.advanceTimersByTimeAsync(1_000 + STEP_ANSWER_GRACE_MS);
            await caught;
            // Delivered or not, the id is free to be asked again; the supervisor answers it from its ledger.
            const retry = broker.submit('t', step('s1'));
            expect(await broker.next('t', 0, never)).toMatchObject({ id: 's1' });
            broker.settle('t', 's1', result());
            await retry;
        } finally {
            vi.useRealTimers();
        }
    });

    it('reads the supervisor’s report once it is posted, however late the reader asks', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const early = broker.awaitReport('t');
        broker.report('t', { outcome: 'completed', cause: null, agentExit: 0, agentEnd: 'exit', drained: true });
        expect(await early).toMatchObject({ outcome: 'completed' });
        expect(await broker.awaitReport('t')).toMatchObject({ agentExit: 0 });
    });

    it('ends a wait for the answer when the caller’s signal aborts, without cancelling the step', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const controller = new AbortController();
        const waiting = broker.submit('t', step('s1'), controller.signal);
        controller.abort();
        await expect(waiting).rejects.toThrow(/was cancelled/);
        // The step itself is still the supervisor's to run: a stand-down never half-aborts a write.
        expect(await broker.next('t', 0, never)).toMatchObject({ id: 's1' });
    });
});

describe('the control routes of a step channel', () => {
    const SUPERVISOR = 'supervisor-token';
    const AGENT = 'agent-token';
    const steps = createStepBroker();
    const server = createGateServer({
        host: '127.0.0.1',
        manager: {
            acquire: () => Promise.reject(new Error('unused')),
            runGate: () => Promise.reject(new Error('unused')),
        },
        steps,
    });
    let base = '';

    beforeEach(async () => {
        base = `http://127.0.0.1:${await server.listen()}`;
        server.openControl(SUPERVISOR);
        server.grantAgent(SUPERVISOR, AGENT);
    });
    afterEach(async () => {
        server.closeControl(SUPERVISOR);
        await server.close();
    });

    const call = (token: string, method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}` },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    it('serves the supervisor a step and takes its answer', async () => {
        const answered = steps.submit(SUPERVISOR, step('s1'));
        const pulled = await call(SUPERVISOR, 'GET', '/step?wait=0');
        expect(pulled.status).toBe(200);
        expect(((await pulled.json()) as { step: StepRequest }).step.id).toBe('s1');
        const posted = await call(SUPERVISOR, 'POST', '/step/s1', {
            exitCode: 0,
            stdout: 'x',
            stderr: '',
            timedOut: false,
        });
        expect(posted.status).toBe(200);
        expect(await answered).toEqual(result('x'));
        // An answer nobody waits for is still acknowledged: the supervisor stops resending it.
        expect(
            (await call(SUPERVISOR, 'POST', '/step/s1', { exitCode: 0, stdout: '', stderr: '', timedOut: false }))
                .status
        ).toBe(200);
    });

    it('answers an empty poll with nothing, and a malformed answer with 400', async () => {
        expect(await (await call(SUPERVISOR, 'GET', '/step?wait=0')).json()).toEqual({});
        expect((await call(SUPERVISOR, 'POST', '/step/s1', { exitCode: 'zero' })).status).toBe(400);
    });

    it('takes the supervisor’s report', async () => {
        const reported = steps.awaitReport(SUPERVISOR);
        const posted = await call(SUPERVISOR, 'POST', '/report', {
            outcome: 'completed',
            cause: null,
            agentExit: 0,
            agentEnd: 'exit',
            drained: true,
        });
        expect(posted.status).toBe(200);
        expect(await reported).toMatchObject({ agentExit: 0, drained: true });
    });

    it('opens neither route to the agent’s token, and refuses an unknown or closed one', async () => {
        expect((await call(AGENT, 'GET', '/step?wait=0')).status).toBe(403);
        expect((await call(AGENT, 'POST', '/step/s1', result())).status).toBe(403);
        expect((await call(AGENT, 'POST', '/report', {})).status).toBe(403);
        expect((await call('nobody', 'GET', '/step?wait=0')).status).toBe(401);
        server.closeControl(SUPERVISOR);
        expect((await call(SUPERVISOR, 'GET', '/step?wait=0')).status).toBe(401);
    });

    it('serves a supervisor-only token — a group with no attempt — its steps and a control that never stops', async () => {
        steps.open('reclaim-token');
        const answered = steps.submit('reclaim-token', step('r1', { kind: 'reclaim' }));
        expect(
            ((await (await call('reclaim-token', 'GET', '/step?wait=0')).json()) as { step: StepRequest }).step.id
        ).toBe('r1');
        expect(await (await call('reclaim-token', 'GET', '/control')).json()).toEqual({ stop: false, kill: false });
        await call('reclaim-token', 'POST', '/step/r1', { exitCode: 0, stdout: '', stderr: '', timedOut: false });
        await answered;
        // It opens no question, publish or review route.
        expect((await call('reclaim-token', 'POST', '/publish', {})).status).toBe(401);
        steps.close('reclaim-token');
        expect((await call('reclaim-token', 'GET', '/step?wait=0')).status).toBe(401);
    });
});

describe('the whole channel against the real supervisor', () => {
    const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
        supervise(env: Record<string, string>, log: (line: string) => void): Promise<number>;
    };
    const TOKEN = 'e2e-supervisor-token';
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it('runs the sync-shaped step before the agent, releases the agent by `go`, serves a mid-run and a post-run step, and finishes', async () => {
        const steps = createStepBroker();
        const server = createGateServer({
            host: '127.0.0.1',
            manager: {
                acquire: () => Promise.reject(new Error('unused')),
                runGate: () => Promise.reject(new Error('unused')),
            },
            steps,
        });
        const port = await server.listen();
        server.openControl(TOKEN);
        const root = mkdtempSync(join(tmpdir(), 'channel-'));
        roots.push(root);
        for (const dir of ['in', 'out', 'export', 'supervisor']) mkdirSync(join(root, dir), { recursive: true });
        const logs: string[] = [];
        const done = supervisor.supervise(
            {
                FACTORY_CTL_ROOT: root,
                SUPERVISOR_TICK_MS: '10',
                SUPERVISOR_CONTROL_MS: '10',
                SUPERVISOR_STEP_WAIT_MS: '200',
                SUPERVISOR_CONTROL_URL: `http://127.0.0.1:${port}`,
                SUPERVISOR_CONTROL_TOKEN: TOKEN,
            },
            (line) => logs.push(line)
        );
        const run = (id: string, kind: StepRequest['kind'], code: string, env: Record<string, string> = {}) =>
            steps.submit(TOKEN, step(id, { kind, argv: ['node', '-e', code], env }));

        // The first step of the attempt, before any agent exists.
        const sync = await run('sync-1', 'sync', 'console.log(JSON.stringify({ ok: true, reason: null }))');
        expect(JSON.parse(sync.stdout)).toEqual({ ok: true, reason: null });

        // The agent is held back until `go`, and the group serves steps while it works.
        await steps.submit(TOKEN, step('go-1', { kind: 'go', argv: [], env: { BUDGET_MS: '60000' } }));
        const midRun = await run('draft-1', 'publish', 'console.log(process.env.GITHUB_TOKEN)', {
            GITHUB_TOKEN: 'only-for-this-step',
        });
        expect(midRun.stdout.trim()).toBe('only-for-this-step');

        // The agent ends; the supervisor reports and keeps serving.
        writeFileSync(join(root, 'out', MAILBOX_FILES.agentExit), '0\n');
        const report = await steps.awaitReport(TOKEN);
        expect(report).toMatchObject({ outcome: 'completed', agentExit: 0, agentEnd: 'exit' });
        const afterRun = await run('probe-1', 'probe', 'console.log("still here")');
        expect(afterRun.stdout.trim()).toBe('still here');

        await steps.submit(TOKEN, step('finish-1', { kind: 'finish', argv: [] }));
        expect(await done).toBe(0);
        expect(logs.find((line) => line.startsWith('FACTORY_SUPERVISOR_REPORT'))).toContain('"outcome":"completed"');
        server.closeControl(TOKEN);
        await server.close();
    });
});
