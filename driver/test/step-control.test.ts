import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGateServer } from '../src/gates.js';
import { createStepBroker, StepChannelClosed, StepTimedOut } from '../src/step-control.js';
import {
    AGENT_MAILBOX_DIR,
    MAILBOX_FILES,
    STEP_ANSWER_GRACE_MS,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from '../src/supervisor-contract.js';

/**
 * The supervised-step channel (issue #771): the broker the runners submit to, the control routes
 * the supervisor pulls them through, and — against the real supervisor script — the whole round trip.
 */
process.env.SUPERVISOR_NO_MAIN = '1';

const step = (id: string, over: Partial<StepRequest> = {}): StepRequest => ({
    id,
    invocation: 'i-1',
    kind: 'probe',
    argv: ['node', '-e', 'console.log(1)'],
    env: {},
    timeoutMs: 1_000,
    ...over,
});
const result = (stdout = 'ok'): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr: string): StepResult => ({ exitCode: 1, stdout: '', stderr, timedOut: false });
const REPORT: SupervisorReport = {
    id: 'report-1',
    outcome: 'completed',
    cause: null,
    agentExit: 0,
    agentEnd: 'exit',
    drained: true,
    serving: true,
};
const never = new AbortController().signal;

describe('the step broker', () => {
    it('hands a submitted step to the supervisor’s poll and answers the submitter with its result', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const answered = broker.submit('t', step('s1'));
        expect(await broker.next('t', 0, never)).toMatchObject({ id: 's1' });
        expect(broker.settle('t', 's1', 'i-1', result('done'))).toBe(true);
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

    it('joins the same invocation in flight, and queues a new invocation of a settled id afresh', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const first = broker.submit('t', step('same'));
        const joined = broker.submit('t', step('same'));
        // One step is queued, not two: a redelivery of one call is the same invocation.
        expect(await broker.next('t', 0, never)).toMatchObject({ id: 'same', invocation: 'i-1' });
        expect(await broker.next('t', 0, never)).toBeNull();
        broker.settle('t', 'same', 'i-1', failed('stale info'));
        expect(await first).toEqual(failed('stale info'));
        expect(await joined).toEqual(failed('stale info'));
        // A deliberate retry of the same effect is a new invocation: it reaches the supervisor, never
        // the answer the first call got.
        const retry = broker.submit('t', step('same', { invocation: 'i-2' }));
        expect(await broker.next('t', 0, never)).toMatchObject({ id: 'same', invocation: 'i-2' });
        broker.settle('t', 'same', 'i-2', result('pushed'));
        expect(await retry).toEqual(result('pushed'));
    });

    it('never settles a later invocation with an earlier one’s late answer', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const later = broker.submit('t', step('s1', { invocation: 'i-2' }));
        expect(broker.settle('t', 's1', 'i-1', result('late'))).toBe(false);
        broker.settle('t', 's1', 'i-2', result('mine'));
        expect(await later).toEqual(result('mine'));
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
            // Delivered or not, the invocation is free to be asked again; the supervisor answers it from its ledger.
            const retry = broker.submit('t', step('s1'));
            expect(await broker.next('t', 0, never)).toMatchObject({ id: 's1', invocation: 'i-1' });
            broker.settle('t', 's1', 'i-1', result());
            await retry;
        } finally {
            vi.useRealTimers();
        }
    });

    it('reads the supervisor’s report once it is posted, however late the reader asks', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const early = broker.awaitReport('t');
        broker.report('t', REPORT);
        expect(await early).toMatchObject({ outcome: 'completed' });
        expect(await broker.awaitReport('t')).toMatchObject({ agentExit: 0 });
    });

    it('accepts one report per token: its id again is a duplicate, another id a conflict', async () => {
        const broker = createStepBroker();
        broker.open('t');
        expect(broker.report('t', REPORT)).toBe('accepted');
        expect(broker.report('t', REPORT)).toBe('duplicate');
        expect(broker.report('t', { ...REPORT, id: 'report-2', outcome: 'failed' })).toBe('conflict');
        expect(await broker.awaitReport('t')).toEqual(REPORT);
    });

    it('rejects every pending and later step at once when the supervisor reports it is leaving', async () => {
        const broker = createStepBroker();
        broker.open('t');
        const pending = broker.submit('t', step('probe-1', { timeoutMs: 600_000 }));
        const queued = broker.submit('t', step('finish-1', { kind: 'finish', argv: [], timeoutMs: 60_000 }));
        const poll = new AbortController();
        // The first step is handed to a poll; the second still sits in the queue.
        expect(await broker.next('t', 0, poll.signal)).toMatchObject({ id: 'probe-1' });
        expect(broker.report('t', { ...REPORT, outcome: 'cancelled', serving: false })).toBe('accepted');
        await expect(pending).rejects.toBeInstanceOf(StepChannelClosed);
        await expect(queued).rejects.toBeInstanceOf(StepChannelClosed);
        await expect(broker.submit('t', step('probe-2'))).rejects.toBeInstanceOf(StepChannelClosed);
        expect(await broker.next('t', 0, never)).toBeNull();
    });

    it('takes a serving supervisor’s departure under the same report id, and never undoes it', async () => {
        const broker = createStepBroker();
        broker.open('t');
        expect(broker.report('t', REPORT)).toBe('accepted');
        const pending = broker.submit('t', step('probe-1'));
        expect(broker.report('t', { ...REPORT, serving: false })).toBe('accepted');
        await expect(pending).rejects.toBeInstanceOf(StepChannelClosed);
        // A stale `serving: true` arriving after the departure changes nothing.
        expect(broker.report('t', REPORT)).toBe('duplicate');
        await expect(broker.submit('t', step('probe-2'))).rejects.toBeInstanceOf(StepChannelClosed);
    });

    it('releases a token whose group is gone: pending and later steps reject until a new group attaches', async () => {
        const broker = createStepBroker();
        broker.open('t');
        await broker.next('t', 0, never);
        broker.report('t', { ...REPORT, serving: true });
        const pending = broker.submit('t', step('probe-1', { timeoutMs: 600_000 }));
        broker.release('t');
        await expect(pending).rejects.toBeInstanceOf(StepChannelClosed);
        await expect(broker.submit('t', step('finish-1', { kind: 'finish' }))).rejects.toBeInstanceOf(
            StepChannelClosed
        );
        // A group created again under the token starts fresh: no contact, no report, steps served —
        // and a late delivery from the group that was taken away is never its word.
        broker.attach('t');
        expect(broker.contacted('t')).toBe(false);
        expect(broker.report('t', { ...REPORT, serving: false })).toBe('conflict');
        expect(broker.contacted('t')).toBe(false);
        const fresh = broker.submit('t', step('probe-2'));
        expect(await broker.next('t', 0, never)).toMatchObject({ id: 'probe-2' });
        broker.settle('t', 'probe-2', 'i-1', result('again'));
        expect(await fresh).toEqual(result('again'));
        // Gone with no report taken: a later wait for one is refused, never left hanging.
        broker.release('t');
        await expect(broker.awaitReport('t')).rejects.toBeInstanceOf(StepChannelClosed);
        expect(broker.report('t', { ...REPORT, id: 'report-2' })).toBe('accepted');
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
    const EXPORTER = 'exporter-token';
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
        server.grantExporter(SUPERVISOR, EXPORTER);
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
            invocation: 'i-1',
            exitCode: 0,
            stdout: 'x',
            stderr: '',
            timedOut: false,
        });
        expect(posted.status).toBe(200);
        expect(await answered).toEqual(result('x'));
        // An answer nobody waits for is still acknowledged: the supervisor stops resending it.
        expect(
            (
                await call(SUPERVISOR, 'POST', '/step/s1', {
                    invocation: 'i-1',
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                    timedOut: false,
                })
            ).status
        ).toBe(200);
    });

    it('answers an empty poll with nothing, and a malformed answer with 400', async () => {
        expect(await (await call(SUPERVISOR, 'GET', '/step?wait=0')).json()).toEqual({});
        expect((await call(SUPERVISOR, 'POST', '/step/s1', { exitCode: 'zero' })).status).toBe(400);
        // An answer that does not say which invocation it answers could settle the wrong call.
        expect((await call(SUPERVISOR, 'POST', '/step/s1', result())).status).toBe(400);
    });

    it('takes the supervisor’s report once, acknowledges its redelivery and refuses another', async () => {
        const reported = steps.awaitReport(SUPERVISOR);
        expect((await call(SUPERVISOR, 'POST', '/report', REPORT)).status).toBe(200);
        expect(await reported).toMatchObject({ agentExit: 0, drained: true });
        // The same report again — its answer was lost — is acknowledged, not taken twice.
        expect((await call(SUPERVISOR, 'POST', '/report', REPORT)).status).toBe(200);
        expect((await call(SUPERVISOR, 'POST', '/report', { ...REPORT, id: 'report-2' })).status).toBe(409);
        const { id: _id, ...anonymous } = REPORT;
        expect((await call(SUPERVISOR, 'POST', '/report', anonymous)).status).toBe(400);
        const { serving: _serving, ...unsaid } = REPORT;
        expect((await call(SUPERVISOR, 'POST', '/report', unsaid)).status).toBe(400);
    });

    it('opens neither route to the agent’s token, and refuses an unknown or closed one', async () => {
        expect((await call(AGENT, 'GET', '/step?wait=0')).status).toBe(403);
        expect((await call(AGENT, 'POST', '/step/s1', result())).status).toBe(403);
        expect((await call(AGENT, 'POST', '/report', {})).status).toBe(403);
        expect((await call('nobody', 'GET', '/step?wait=0')).status).toBe(401);
        server.closeControl(SUPERVISOR);
        expect((await call(SUPERVISOR, 'GET', '/step?wait=0')).status).toBe(401);
    });

    // The transcript exporter shares the attempt but not the supervisor's doors: a step it tried to
    // take or answer, or a report it tried to post, stays the supervisor's.
    it('refuses the exporter’s token on every step route and leaves the step and report to the supervisor', async () => {
        const answered = steps.submit(SUPERVISOR, step('s1'));
        const reported = steps.awaitReport(SUPERVISOR);
        expect((await call(EXPORTER, 'GET', '/step?wait=0')).status).toBe(403);
        expect((await call(EXPORTER, 'POST', '/step/s1', { invocation: 'i-x', ...result('forged') })).status).toBe(403);
        expect((await call(EXPORTER, 'POST', '/report', REPORT)).status).toBe(403);
        expect((await call(EXPORTER, 'GET', '/control')).status).toBe(403);
        expect(server.controlPolled(SUPERVISOR)).toBe(false);

        const pulled = await call(SUPERVISOR, 'GET', '/step?wait=0');
        expect(((await pulled.json()) as { step: StepRequest }).step.id).toBe('s1');
        await call(SUPERVISOR, 'POST', '/step/s1', { invocation: 'i-1', ...result('x') });
        expect(await answered).toEqual(result('x'));
        expect((await call(SUPERVISOR, 'POST', '/report', REPORT)).status).toBe(200);
        expect(await reported).toMatchObject({ agentExit: 0, drained: true });
    });

    it('serves a supervisor-only token — a group with no attempt — its steps and a control that never stops', async () => {
        steps.open('reclaim-token');
        const answered = steps.submit('reclaim-token', step('r1', { kind: 'reclaim' }));
        expect(
            ((await (await call('reclaim-token', 'GET', '/step?wait=0')).json()) as { step: StepRequest }).step.id
        ).toBe('r1');
        expect(await (await call('reclaim-token', 'GET', '/control')).json()).toEqual({ stop: false, kill: false });
        await call('reclaim-token', 'POST', '/step/r1', {
            invocation: 'i-1',
            exitCode: 0,
            stdout: '',
            stderr: '',
            timedOut: false,
        });
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
    const closing: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const close of closing.splice(0)) await close();
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    /** A real control endpoint and the real supervisor polling it from a scratch mailbox root. */
    async function channel(env: Record<string, string> = {}) {
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
        closing.push(async () => {
            server.closeControl(TOKEN);
            await server.close();
        });
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
                ...env,
            },
            (line) => logs.push(line)
        );
        // A node start on a loaded machine takes seconds: the steps' own timeout is no subject here.
        const run = (id: string, kind: StepRequest['kind'], code: string, over: Partial<StepRequest> = {}) =>
            steps.submit(TOKEN, step(id, { kind, argv: ['node', '-e', code], timeoutMs: 30_000, ...over }));
        const go = (budgetMs = '60000') =>
            steps.submit(TOKEN, step('go-1', { kind: 'go', argv: [], env: { BUDGET_MS: budgetMs } }));
        const agentExits = (code: number) =>
            writeFileSync(join(root, 'out', AGENT_MAILBOX_DIR, MAILBOX_FILES.agentExit), `${code}\n`);
        return { steps, server, root, logs, done, run, go, agentExits };
    }

    it('runs the sync-shaped step before the agent, releases the agent by `go`, serves a mid-run and a post-run step, and finishes', async () => {
        const { steps, logs, done, run, go, agentExits } = await channel();

        // The first step of the attempt, before any agent exists.
        const sync = await run('sync-1', 'sync', 'console.log(JSON.stringify({ ok: true, reason: null }))');
        expect(JSON.parse(sync.stdout)).toEqual({ ok: true, reason: null });

        // The agent is held back until `go`, and the group serves steps while it works.
        await go();
        const midRun = await run('draft-1', 'publish', 'console.log(process.env.GITHUB_TOKEN)', {
            env: { GITHUB_TOKEN: 'only-for-this-step' },
        });
        expect(midRun.stdout.trim()).toBe('only-for-this-step');

        // The agent ends; the supervisor reports and keeps serving.
        agentExits(0);
        const report = await steps.awaitReport(TOKEN);
        expect(report).toMatchObject({ outcome: 'completed', agentExit: 0, agentEnd: 'exit', serving: true });
        const afterRun = await run('probe-1', 'probe', 'console.log("still here")');
        expect(afterRun.stdout.trim()).toBe('still here');

        await steps.submit(TOKEN, step('finish-1', { kind: 'finish', argv: [] }));
        expect(await done).toBe(0);
        expect(logs.find((line) => line.startsWith('FACTORY_SUPERVISOR_REPORT'))).toContain('"outcome":"completed"');
    });

    /*
     * An attempt the supervisor ends itself — the driver's kill, the run budget, a full spool —
     * leaves no group to serve the probe and the `finish` the loop still sends: the departure it
     * reports rejects both at once, where each would otherwise wait out its own timeout and the
     * answer grace, three times over.
     */
    it.each([
        ['a kill', {}, (c: Awaited<ReturnType<typeof channel>>) => c.server.raiseKill(TOKEN), 'cancelled'],
        ['the run budget', {}, () => undefined, 'timed_out'],
        [
            'a full spool',
            { SUPERVISOR_EXPORTS: '1' },
            (c: Awaited<ReturnType<typeof channel>>) =>
                writeFileSync(join(c.root, 'export', MAILBOX_FILES.exportStatus), JSON.stringify({ spoolFull: true })),
            'failed',
        ],
    ])('ends at %s and rejects the probe and `finish` at once', async (_how, env, end, outcome) => {
        const c = await channel({ SUPERVISOR_DRAIN_MS: '50', ...env });
        await c.go(outcome === 'timed_out' ? '100' : '60000');
        end(c);
        const killOrder = join(c.root, 'in', AGENT_MAILBOX_DIR, MAILBOX_FILES.kill);
        while (!existsSync(killOrder)) await new Promise((resolve) => setTimeout(resolve, 10));
        c.agentExits(137);
        expect(await c.steps.awaitReport(TOKEN)).toMatchObject({ outcome, serving: false });
        const asked = Date.now();
        await expect(c.run('probe-1', 'probe', 'console.log("nobody")', { timeoutMs: 600_000 })).rejects.toBeInstanceOf(
            StepChannelClosed
        );
        await expect(
            c.steps.submit(TOKEN, step('finish-1', { kind: 'finish', argv: [], timeoutMs: 60_000 }))
        ).rejects.toBeInstanceOf(StepChannelClosed);
        expect(Date.now() - asked).toBeLessThan(5_000);
        expect([0, 124]).toContain(await c.done);
    });

    it('serves the probe and `finish` after a cooperative Stop, which ends no attempt by itself', async () => {
        const c = await channel();
        await c.go();
        c.server.raiseStop(TOKEN);
        await new Promise((resolve) => setTimeout(resolve, 50));
        c.agentExits(0);
        expect(await c.steps.awaitReport(TOKEN)).toMatchObject({ outcome: 'cancelled', serving: true });
        expect((await c.run('probe-1', 'probe', 'console.log("read")')).stdout.trim()).toBe('read');
        await c.steps.submit(TOKEN, step('finish-1', { kind: 'finish', argv: [] }));
        expect(await c.done).toBe(0);
    });
});
