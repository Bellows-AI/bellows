import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoFile as read } from './fixtures/repo-files.js';
import {
    MAILBOX_FILES,
    MAILBOXES,
    STEP_KINDS,
    SUPERVISOR_EXIT,
    SUPERVISOR_REPORT_MS,
} from '../src/supervisor-contract.js';

/*
 * The task supervisor (`scripts/supervisor.cjs`): the lifecycle machine and the run it drives. The
 * script is loaded in-process (`SUPERVISOR_NO_MAIN`) against a directory of mailboxes and a local
 * stand-in for the driver's run-control endpoint — nothing here spawns a process or sends a signal.
 * The agent and the exporter are played by the test, as files in the directories they mount.
 */
process.env.SUPERVISOR_NO_MAIN = '1';

interface Machine {
    readonly stage: string;
    readonly outcome: string | null;
    readonly cause: string | null;
    history(): string[];
    enter(next: string): void;
    abort(why: string, because?: string): void;
    complete(): void;
    performed(): string[];
    delegated(): string[];
}
interface SupervisorModule {
    STAGES: string[];
    TRANSITIONS: Record<string, string[]>;
    FILES: Record<string, string>;
    EXIT: { finalized: number; deadline: number; failed: number };
    REPORT_PREFIX: string;
    REPORT_MS: number;
    STEP_KINDS: string[];
    createMachine(initial?: string): Machine;
    supervise(env: Record<string, string>, log: (line: string) => void): Promise<number>;
}
const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as SupervisorModule;

const TOKEN = 'tok-supervisor-secret';

describe('the lifecycle machine', () => {
    it('walks prepare -> setup -> execute -> verify -> publish -> finalize -> report, and only that way', () => {
        const machine = supervisor.createMachine();
        for (const next of ['setup', 'execute', 'verify', 'publish', 'finalize', 'report']) machine.enter(next);
        expect(machine.history()).toEqual(supervisor.STAGES);
        expect(machine.stage).toBe('report');
    });

    it('refuses every move the table does not list, so a bug cannot skip a stage', () => {
        for (const [from, allowed] of Object.entries(supervisor.TRANSITIONS)) {
            for (const to of supervisor.STAGES.filter((stage) => !allowed.includes(stage))) {
                const machine = supervisor.createMachine(from);
                expect(() => machine.enter(to), `${from} -> ${to}`).toThrow(/illegal transition/);
            }
        }
    });

    it.each(['failed', 'cancelled', 'timed_out', 'lost'])(
        'a %s run enters finalize at once, never through verify or publish',
        (why) => {
            const machine = supervisor.createMachine();
            machine.enter('setup');
            machine.enter('execute');
            machine.abort(why, 'because');
            expect(machine.history()).toEqual(['prepare', 'setup', 'execute', 'finalize']);
            expect(machine.outcome).toBe(why);
            expect(machine.cause).toBe('because');
            expect(machine.delegated()).toEqual(['setup']);
            expect(machine.performed()).not.toContain('verify');
            expect(machine.performed()).not.toContain('publish');
        }
    );

    it('keeps the first reason an attempt was ended for, and aborts in finalize without a second entry', () => {
        const machine = supervisor.createMachine();
        machine.abort('cancelled', 'agent_killed');
        machine.abort('failed', 'something_else');
        expect(machine.outcome).toBe('cancelled');
        expect(machine.cause).toBe('agent_killed');
        expect(machine.history()).toEqual(['prepare', 'finalize']);
    });

    it('refuses `completed` as an abort: a completion is not a failure path', () => {
        expect(() => supervisor.createMachine().abort('completed')).toThrow(/not an abort outcome/);
    });

    it('records the stages the driver still performs as delegated, never as performed', () => {
        const machine = supervisor.createMachine();
        for (const next of ['setup', 'execute', 'verify', 'publish', 'finalize', 'report']) machine.enter(next);
        expect(machine.performed()).toEqual(['prepare', 'execute', 'finalize', 'report']);
        expect(machine.delegated()).toEqual(['setup', 'verify', 'publish']);
    });
});

interface QueuedStep {
    id: string;
    invocation?: string;
    kind: string;
    argv: string[];
    cwd?: string;
    env: Record<string, string>;
    timeoutMs: number;
}
interface StepAnswer {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    replayed?: boolean;
}

interface Driver {
    url: string;
    stop: boolean;
    kill: boolean;
    /** A driver that no longer knows the token: every route answers 401. */
    closed: boolean;
    posted: { id: string; body: unknown }[];
    /** The steps still to be pulled, and the answers the supervisor posted back. */
    queue: QueuedStep[];
    answers: Map<string, StepAnswer>;
    reports: Report[];
    /** How the n-th report delivery (from 1) is answered: a status, or `drop` — the answer is lost. */
    reportAnswer: (n: number) => number | 'drop';
    /** Whether the driver orders `finish` as soon as the supervisor reports; off, the supervisor keeps serving. */
    autoFinish: boolean;
    order(step: QueuedStep): void;
}

interface Report {
    id: string;
    outcome: string | null;
    serving: boolean;
}

const ORDER_GO: QueuedStep = { id: 'go', invocation: 'i-1', kind: 'go', argv: [], env: {}, timeoutMs: 1000 };
const ORDER_FINISH: QueuedStep = {
    id: 'finish',
    invocation: 'i-1',
    kind: 'finish',
    argv: [],
    env: {},
    timeoutMs: 1000,
};

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        let text = '';
        request.on('data', (chunk: Buffer) => (text += chunk.toString()));
        request.on('end', () => resolve(text));
    });

/** The driver's run-control endpoint as the supervisor sees it: `/control`, and the question routes. */
async function startDriver({ release = true }: { release?: boolean } = {}): Promise<Driver> {
    const driver: Driver = {
        url: '',
        stop: false,
        kill: false,
        closed: false,
        posted: [],
        queue: release ? [ORDER_GO] : [],
        answers: new Map(),
        reports: [],
        reportAnswer: () => 200,
        autoFinish: true,
        order: (step) => driver.queue.push(step),
    };
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
            const send = (status: number, body: unknown) => {
                response.writeHead(status, { 'content-type': 'application/json' });
                response.end(JSON.stringify(body));
            };
            if (driver.closed || request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, {});
            if (request.method === 'GET' && request.url === '/control') {
                return send(200, { stop: driver.stop, kill: driver.kill });
            }
            if (request.method === 'GET' && request.url?.startsWith('/step?')) {
                const next = driver.queue.shift();
                if (next) return send(200, { step: next });
                await new Promise((resolve) => setTimeout(resolve, 20));
                return send(200, {});
            }
            if (request.method === 'POST' && request.url?.startsWith('/step/')) {
                const id = decodeURIComponent(request.url.slice('/step/'.length));
                driver.answers.set(id, JSON.parse(await readBody(request)) as StepAnswer);
                return send(200, { ok: true });
            }
            if (request.method === 'POST' && request.url === '/report') {
                driver.reports.push(JSON.parse(await readBody(request)) as Report);
                const answer = driver.reportAnswer(driver.reports.length);
                if (answer === 'drop') return request.socket.destroy();
                if (answer === 200 && driver.autoFinish) driver.order(ORDER_FINISH);
                return send(answer, {});
            }
            if (request.method === 'POST' && request.url === '/question') {
                const body = JSON.parse(await readBody(request)) as { id: string };
                driver.posted.push({ id: body.id, body });
                return send(202, {});
            }
            // A person never answers: the question stays pending until the supervisor itself cancels it.
            if (request.method === 'GET' && request.url?.startsWith('/question/'))
                return send(200, { state: 'pending' });
            return send(404, {});
        })();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    driver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return driver;
}

const until = async (what: string, ready: () => boolean, ms = 4_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!ready()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

/** A supervisor running in a scratch mailbox root, and the agent and exporter the test plays beside it. */
function run(driver: Driver | null, env: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'supervisor-'));
    dirs.push(root);
    const dir = (box: keyof typeof MAILBOXES) => join(root, MAILBOXES[box].path.split('/').pop()!);
    const box = { in: dir('in'), out: dir('out'), export: dir('export'), own: dir('supervisor') };
    for (const path of Object.values(box)) mkdirSync(path, { recursive: true });
    const logs: string[] = [];
    const done = supervisor.supervise(
        {
            FACTORY_CTL_ROOT: root,
            SUPERVISOR_TICK_MS: '10',
            SUPERVISOR_CONTROL_MS: '10',
            ...(driver ? { SUPERVISOR_CONTROL_URL: driver.url, SUPERVISOR_CONTROL_TOKEN: TOKEN } : {}),
            ...env,
        },
        (line) => logs.push(line)
    );
    const report = (): Record<string, unknown> => {
        const line = logs.find((l) => l.startsWith(supervisor.REPORT_PREFIX));
        return line ? (JSON.parse(line.slice(supervisor.REPORT_PREFIX.length)) as Record<string, unknown>) : {};
    };
    return {
        box,
        done,
        logs,
        report,
        /** The agent container's end, as its entrypoint writes it. */
        agentExits: (code: number) => writeFileSync(join(box.out, MAILBOX_FILES.agentExit), `${code}\n`),
        agentAsks: (id: string) =>
            writeFileSync(
                join(box.out, MAILBOX_FILES.questions, `${id}.json`),
                JSON.stringify({ id, questions: [{ question: 'which?' }] })
            ),
        answerOf: (id: string) =>
            JSON.parse(readFileSync(join(box.in, MAILBOX_FILES.answers, `${id}.json`), 'utf8')) as { state: string },
        saw: (name: string, where: 'in' | 'export' | 'own' = 'in') => existsSync(join(box[where], name)),
        drainOrder: () =>
            JSON.parse(readFileSync(join(box.export, MAILBOX_FILES.drain), 'utf8')) as {
                state: string;
                cause: string | null;
            },
        /** The exporter's word that every session is closed. */
        exporterDone: () => writeFileSync(join(box.export, MAILBOX_FILES.exportStatus), JSON.stringify({ done: true })),
        state: () =>
            JSON.parse(readFileSync(join(box.own, MAILBOX_FILES.state), 'utf8')) as {
                stage: string;
                history: string[];
            },
        /** The report as the supervisor keeps it on its own volume, and whether the driver took it. */
        kept: () =>
            JSON.parse(readFileSync(join(box.own, MAILBOX_FILES.report), 'utf8')) as {
                report: Report;
                acknowledged: boolean;
            },
        /** One step's ledger entry, as the supervisor keeps it. */
        ledger: (id: string) =>
            JSON.parse(readFileSync(join(box.own, MAILBOX_FILES.steps, `${encodeURIComponent(id)}.json`), 'utf8')) as {
                invocations: Record<string, { state: string }>;
            },
    };
}

describe('the supervisor run: agent exit with the supervisor alive', () => {
    it('stays alive after the agent exits, finalizes once the exporter has drained, then reports', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver, { SUPERVISOR_EXPORTS: '1' });
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));

        supervised.agentExits(0);
        await until('the drain order', () => supervised.saw(MAILBOX_FILES.drain, 'export'));
        // The agent is gone, the exporter is still closing: the supervisor has not reported or exited.
        expect(supervised.drainOrder()).toEqual({ state: 'complete', cause: null });
        let finished = false;
        void supervised.done.then(() => (finished = true));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(finished).toBe(false);
        expect(supervised.report()).toEqual({});

        supervised.exporterDone();
        // The drained exporter is reported to the driver, and the supervisor then serves its steps:
        // the gates and the publish run beside it until the driver orders the end.
        await until('the report', () => driver.reports.length === 1);
        expect(driver.reports[0]).toMatchObject({ outcome: 'completed', agentEnd: 'exit', drained: true });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(finished).toBe(false);
        driver.order(ORDER_FINISH);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(supervised.report()).toMatchObject({
            outcome: 'completed',
            cause: null,
            agentExit: 0,
            agentEnd: 'exit',
            drained: true,
            // Verification and publication stay the driver's: never claimed as performed here.
            performed: ['prepare', 'execute', 'finalize', 'report'],
            delegated: ['setup', 'verify', 'publish'],
        });
        expect(supervised.state().stage).toBe('report');
    });

    it('reports a failed agent through finalize alone: no verification or publication is implied', async () => {
        const supervised = run(await startDriver());
        supervised.agentExits(2);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(supervised.report()).toMatchObject({ outcome: 'failed', agentExit: 2, delegated: ['setup'] });
        expect(supervised.state().history).toEqual(['prepare', 'setup', 'execute', 'finalize', 'report']);
    });

    it('reports a lost agent — a heartbeat that stopped — as lost, never as completed', async () => {
        const supervised = run(await startDriver(), { SUPERVISOR_AGENT_LOST_MS: '50' });
        writeFileSync(join(supervised.box.out, MAILBOX_FILES.agentAlive), `${Date.now() - 10_000}\n`);
        await supervised.done;
        expect(supervised.report()).toMatchObject({ outcome: 'lost', cause: 'agent_lost', agentEnd: 'lost' });
    });
});

describe('the supervisor run: Stop during a question', () => {
    it('ends the waits, stops the agent and still finalizes the artifacts', async () => {
        const driver = await startDriver();
        const supervised = run(driver, { SUPERVISOR_EXPORTS: '1' });
        supervised.agentAsks('toolu_1');
        await until('the question to reach the driver', () => driver.posted.length === 1);
        expect(supervised.saw(`${MAILBOX_FILES.answers}/toolu_1.json`)).toBe(false);

        // The board raises a Stop while the person has not answered.
        driver.stop = true;
        await until('the Stop to reach the agent', () => supervised.saw(MAILBOX_FILES.stop));
        // The wait ends: the agent finds a cancelled answer where it was blocked, and the Stop marker.
        await until('the question to be cancelled', () => supervised.saw(`${MAILBOX_FILES.answers}/toolu_1.json`));
        expect(supervised.answerOf('toolu_1')).toEqual({ state: 'cancelled' });
        expect(supervised.saw(MAILBOX_FILES.kill)).toBe(false);

        // The agent finishes its step and leaves; the transcript is whole, and the supervisor still finalizes.
        supervised.agentExits(0);
        await until('the drain order', () => supervised.saw(MAILBOX_FILES.drain, 'export'));
        supervised.exporterDone();
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(supervised.report()).toMatchObject({ outcome: 'cancelled', drained: true });
        expect(supervised.drainOrder()).toEqual({ state: 'complete', cause: null });
        expect(supervised.state().history).not.toContain('publish');
    });

    it('cancels a question asked after the Stop at once, without bothering the driver', async () => {
        const driver = await startDriver();
        const supervised = run(driver);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        driver.stop = true;
        await until('the Stop', () => supervised.saw(MAILBOX_FILES.stop));
        supervised.agentAsks('toolu_late');
        await until('the late question to be cancelled', () =>
            supervised.saw(`${MAILBOX_FILES.answers}/toolu_late.json`)
        );
        expect(supervised.answerOf('toolu_late')).toEqual({ state: 'cancelled' });
        expect(driver.posted).toEqual([]);
        supervised.agentExits(0);
        await supervised.done;
    });
});

describe('the supervisor run: the agent is killed', () => {
    it('drains the exporter after the kill: partial, with the cause, and the run still finalizes', async () => {
        const driver = await startDriver();
        const supervised = run(driver, { SUPERVISOR_EXPORTS: '1' });
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));

        driver.kill = true;
        await until('the kill order', () => supervised.saw(MAILBOX_FILES.kill));
        expect(supervised.saw(MAILBOX_FILES.stop)).toBe(true);

        supervised.agentExits(143);
        await until('the drain order', () => supervised.saw(MAILBOX_FILES.drain, 'export'));
        expect(supervised.drainOrder()).toEqual({ state: 'partial', cause: 'agent_killed' });
        supervised.exporterDone();
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(supervised.report()).toMatchObject({
            outcome: 'cancelled',
            cause: 'agent_killed',
            agentExit: 143,
            drained: true,
        });
    });

    it('reports an exporter that never closes as not drained — and still reports, bytes left on the volume', async () => {
        const supervised = run(await startDriver(), { SUPERVISOR_EXPORTS: '1', SUPERVISOR_DRAIN_MS: '150' });
        supervised.agentExits(1);
        await supervised.done;
        expect(supervised.report()).toMatchObject({ outcome: 'failed', drained: false });
    });

    it('ends the agent when the exporter reports a full spool, naming it', async () => {
        const supervised = run(await startDriver(), { SUPERVISOR_EXPORTS: '1' });
        writeFileSync(join(supervised.box.export, MAILBOX_FILES.exportStatus), JSON.stringify({ spoolFull: true }));
        await until('the kill order', () => supervised.saw(MAILBOX_FILES.kill));
        supervised.agentExits(137);
        await until('the drain order', () => supervised.saw(MAILBOX_FILES.drain, 'export'));
        expect(supervised.drainOrder()).toEqual({ state: 'partial', cause: 'artifact_spool_full' });
        supervised.exporterDone();
        await supervised.done;
        expect(supervised.report()).toMatchObject({ outcome: 'failed', cause: 'artifact_spool_full' });
    });

    it('ends the run when the control token is closed, as a cancellation', async () => {
        const driver = await startDriver();
        const supervised = run(driver, { SUPERVISOR_CONTROL_TOKEN: 'a-closed-token' });
        await until('the kill order', () => supervised.saw(MAILBOX_FILES.kill));
        await supervised.done;
        // The agent was never released: its entrypoint waits on `go` and exits on the kill marker.
        expect(supervised.saw(MAILBOX_FILES.go)).toBe(false);
        expect(supervised.report()).toMatchObject({
            outcome: 'cancelled',
            cause: 'control_closed',
            agentEnd: 'unlaunched',
        });
    });
});

describe('the supervisor run: the budget', () => {
    it('ends the agent at the run budget and exits 124, the deadline the driver reads as a timeout', async () => {
        const supervised = run(await startDriver(), { SUPERVISOR_DEADLINE_MS: '100' });
        await until('the kill order', () => supervised.saw(MAILBOX_FILES.kill));
        supervised.agentExits(143);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.deadline);
        expect(supervised.report()).toMatchObject({ outcome: 'timed_out', cause: 'timeout' });
    });

    it('holds the budget while a question waits for a person', async () => {
        const driver = await startDriver();
        const supervised = run(driver, { SUPERVISOR_DEADLINE_MS: '150' });
        supervised.agentAsks('toolu_wait');
        await until('the question to reach the driver', () => driver.posted.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(supervised.saw(MAILBOX_FILES.kill)).toBe(false);
        supervised.agentExits(0);
        await supervised.done;
    });
});

const step = (id: string, kind: string, argv: string[], extra: Partial<QueuedStep> = {}): QueuedStep => ({
    id,
    invocation: 'i-1',
    kind,
    argv,
    env: {},
    timeoutMs: 5_000,
    ...extra,
});

describe('the supervisor run: supervised steps', () => {
    it('holds the agent back until `go`, and does not start the budget before it', async () => {
        const driver = await startDriver({ release: false });
        // A budget the released agent's exit lands well inside even on a loaded machine, and a
        // pre-`go` wait well past it.
        const supervised = run(driver, { SUPERVISOR_DEADLINE_MS: '1000' });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        // Past the whole budget with no `go`: the agent was never released, so nothing timed out.
        expect(supervised.saw(MAILBOX_FILES.go)).toBe(false);
        expect(supervised.saw(MAILBOX_FILES.kill)).toBe(false);
        driver.order(ORDER_GO);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(0);
        await supervised.done;
        expect(supervised.report()).toMatchObject({ outcome: 'completed' });
    });

    it('runs a command step in its own container and answers its output and exit', async () => {
        const driver = await startDriver();
        driver.order(
            step('probe-1', 'probe', ['node', '-e', 'console.log(process.cwd()); process.exit(3)'], { cwd: tmpdir() })
        );
        const supervised = run(driver);
        await until('the answer', () => driver.answers.has('probe-1'));
        expect(driver.answers.get('probe-1')).toMatchObject({ exitCode: 3, timedOut: false });
        // The step's cwd as the child resolves it: macOS links its temp directory through /private.
        expect(driver.answers.get('probe-1')?.stdout.trim()).toBe(realpathSync(tmpdir()));
        supervised.agentExits(0);
        await supervised.done;
    });

    it('serves a step while the agent works, and again once it is gone', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        driver.order(step('draft-1', 'publish', ['node', '-e', 'console.log("mid-run")']));
        await until('the mid-run answer', () => driver.answers.has('draft-1'));
        supervised.agentExits(0);
        await until('the report', () => driver.reports.length === 1);
        driver.order(step('probe-2', 'probe', ['node', '-e', 'console.log("after")']));
        await until('the answer after the agent', () => driver.answers.has('probe-2'));
        expect(driver.answers.get('probe-2')?.stdout.trim()).toBe('after');
        driver.order(ORDER_FINISH);
        await supervised.done;
    });

    it('gives a step its own environment and never the supervisor’s credential', async () => {
        const driver = await startDriver();
        driver.order(
            step('env-1', 'helper', ['node', '-e', 'console.log(JSON.stringify(process.env))'], {
                env: { GITHUB_TOKEN: 'publish-token-value', PLAIN: 'literal' },
            })
        );
        const supervised = run(driver, { SUPERVISOR_EXPORTS: '' });
        await until('the answer', () => driver.answers.has('env-1'));
        const seen = JSON.parse(driver.answers.get('env-1')!.stdout) as Record<string, string>;
        expect(seen.GITHUB_TOKEN).toBe('publish-token-value');
        expect(seen.PLAIN).toBe('literal');
        expect(Object.keys(seen).filter((name) => name.startsWith('SUPERVISOR_'))).toEqual([]);
        expect(JSON.stringify(seen)).not.toContain(TOKEN);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('kills a step past its own timeout and says so', async () => {
        const driver = await startDriver();
        driver.order(step('slow-1', 'helper', ['node', '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 150 }));
        const supervised = run(driver);
        await until('the answer', () => driver.answers.has('slow-1'));
        expect(driver.answers.get('slow-1')).toMatchObject({ timedOut: true });
        supervised.agentExits(0);
        await supervised.done;
    });

    /** A step that appends to a marker file — how many times it really ran — then exits `code`. */
    const marked = (code = 0) => {
        const marker = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ran');
        dirs.push(join(marker, '..'));
        const argv = [
            'node',
            '-e',
            `require("fs").appendFileSync(${JSON.stringify(marker)}, "x"); console.log("ran"); process.exit(${code})`,
        ];
        return { argv, runs: () => (existsSync(marker) ? readFileSync(marker, 'utf8').length : 0) };
    };

    it('answers a step that succeeded from its ledger, for a redelivery and a new invocation alike', async () => {
        const driver = await startDriver();
        const push = marked();
        driver.order(step('push-1', 'publish', push.argv));
        const supervised = run(driver);
        await until('the first answer', () => driver.answers.has('push-1'));
        // The driver lost the answer and asks again under the same invocation…
        driver.answers.clear();
        driver.order(step('push-1', 'publish', push.argv));
        await until('the replayed answer', () => driver.answers.has('push-1'));
        expect(driver.answers.get('push-1')).toMatchObject({ exitCode: 0, replayed: true });
        // …and a new call of the same effect: it landed, so running it again is the harm the ledger prevents.
        driver.answers.clear();
        driver.order(step('push-1', 'publish', push.argv, { invocation: 'i-2' }));
        await until('the answer to the new call', () => driver.answers.has('push-1'));
        expect(driver.answers.get('push-1')).toMatchObject({ exitCode: 0, replayed: true });
        expect(push.runs()).toBe(1);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers a redelivered invocation of a failed step from its ledger, never running it twice', async () => {
        const driver = await startDriver();
        const push = marked(1);
        driver.order(step('push-1', 'publish', push.argv));
        const supervised = run(driver);
        await until('the first answer', () => driver.answers.has('push-1'));
        driver.answers.clear();
        driver.order(step('push-1', 'publish', push.argv));
        await until('the replayed answer', () => driver.answers.has('push-1'));
        expect(driver.answers.get('push-1')).toMatchObject({ exitCode: 1, replayed: true });
        expect(push.runs()).toBe(1);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('runs a failed step again for a new invocation, and still replays each earlier one', async () => {
        const driver = await startDriver();
        const push = marked(1);
        driver.order(step('push-1', 'publish', push.argv, { invocation: 'a' }));
        const supervised = run(driver);
        await until('the first answer', () => driver.answers.has('push-1'));
        driver.answers.clear();
        // A deliberate retry after the caller reconciled: a new invocation runs.
        driver.order(step('push-1', 'publish', push.argv, { invocation: 'b' }));
        await until('the retry', () => driver.answers.has('push-1'));
        expect(driver.answers.get('push-1')).toMatchObject({ exitCode: 1 });
        expect(driver.answers.get('push-1')?.replayed).toBeUndefined();
        expect(push.runs()).toBe(2);
        // A late redelivery of the first call is still that call: answered, never run a third time.
        driver.answers.clear();
        driver.order(step('push-1', 'publish', push.argv, { invocation: 'a' }));
        await until('the late redelivery', () => driver.answers.has('push-1'));
        expect(driver.answers.get('push-1')).toMatchObject({ exitCode: 1, replayed: true });
        expect(push.runs()).toBe(2);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers a redelivered invocation of a step killed at its timeout from its ledger', async () => {
        const driver = await startDriver();
        const marker = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ran');
        dirs.push(join(marker, '..'));
        const slow = [
            'node',
            '-e',
            `require("fs").appendFileSync(${JSON.stringify(marker)}, "x"); setTimeout(() => {}, 60000)`,
        ];
        driver.order(step('push-1', 'publish', slow, { timeoutMs: 1_000 }));
        const supervised = run(driver);
        await until('the timeout', () => driver.answers.has('push-1'));
        driver.answers.clear();
        driver.order(step('push-1', 'publish', slow, { timeoutMs: 1_000 }));
        await until('the replayed answer', () => driver.answers.has('push-1'));
        // Possibly half-applied: the redelivery is told so, and nothing runs it again.
        expect(driver.answers.get('push-1')).toMatchObject({ timedOut: true, replayed: true });
        expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '').not.toBe('xx');
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers an invocation its ledger left running as unknown, without running it', async () => {
        const driver = await startDriver();
        const push = marked();
        const supervised = run(driver);
        // A supervisor before this one took the call and never answered it.
        mkdirSync(join(supervised.box.own, MAILBOX_FILES.steps), { recursive: true });
        writeFileSync(
            join(supervised.box.own, MAILBOX_FILES.steps, 'push-1.json'),
            JSON.stringify({
                id: 'push-1',
                kind: 'publish',
                effect: null,
                invocations: { 'i-1': { state: 'running' } },
            })
        );
        driver.order(step('push-1', 'publish', push.argv));
        await until('the answer', () => driver.answers.has('push-1'));
        expect(driver.answers.get('push-1')).toMatchObject({ exitCode: null });
        expect(driver.answers.get('push-1')?.stderr).toMatch(/whether its effect landed is unknown/);
        expect(push.runs()).toBe(0);
        // The caller reconciles and calls again: that runs.
        driver.answers.clear();
        driver.order(step('push-1', 'publish', push.argv, { invocation: 'i-2' }));
        await until('the new call', () => driver.answers.has('push-1'));
        expect(driver.answers.get('push-1')).toMatchObject({ exitCode: 0 });
        expect(push.runs()).toBe(1);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('refuses a publish step once the attempt ended any way but completed', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(2);
        await until('the report', () => driver.reports.length === 1);
        driver.order(step('late-publish', 'publish', ['node', '-e', 'console.log("pushed")']));
        await until('the refusal', () => driver.answers.has('late-publish'));
        expect(driver.answers.get('late-publish')).toMatchObject({ exitCode: 126 });
        expect(driver.answers.get('late-publish')?.stderr).toMatch(/refusing to publish/);
        expect(driver.answers.get('late-publish')?.stdout).toBe('');
        // A read-only step is still served: the machine only refuses what could publish.
        driver.order(step('late-probe', 'probe', ['node', '-e', 'console.log("read")']));
        await until('the probe', () => driver.answers.has('late-probe'));
        expect(driver.answers.get('late-probe')).toMatchObject({ exitCode: 0 });
        driver.order(ORDER_FINISH);
        await supervised.done;
    });

    it('refuses a malformed step without starting anything', async () => {
        const driver = await startDriver();
        driver.order({ id: 'bad id!', invocation: 'i-1', kind: 'helper', argv: ['node'], env: {}, timeoutMs: 100 });
        driver.order({ id: 'no-such-kind', invocation: 'i-1', kind: 'shell', argv: ['sh'], env: {}, timeoutMs: 100 });
        // A step that does not say which call it is could be answered for another one.
        driver.order({ id: 'anonymous', kind: 'helper', argv: ['node', '-e', ''], env: {}, timeoutMs: 100 });
        const supervised = run(driver);
        await until('the answer', () => driver.answers.has('anonymous'));
        expect(driver.answers.get('no-such-kind')).toMatchObject({ exitCode: 126, stderr: 'malformed step' });
        expect(driver.answers.get('anonymous')).toMatchObject({ exitCode: 126, stderr: 'malformed step' });
        supervised.agentExits(0);
        await supervised.done;
    });

    it('serves an agentless attempt with no agent to wait for: steps, then the order to finish', async () => {
        const driver = await startDriver({ release: false });
        driver.autoFinish = false;
        driver.order(step('probe-1', 'probe', ['node', '-e', 'console.log("ok")']));
        const supervised = run(driver, { SUPERVISOR_AGENTLESS: '1' });
        await until('the answer', () => driver.answers.has('probe-1'));
        expect(supervised.saw(MAILBOX_FILES.go)).toBe(false);
        driver.order(ORDER_FINISH);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(supervised.report()).toMatchObject({ outcome: 'completed', agentEnd: 'none' });
    });

    it('does not release an agent for a Stop that landed before `go`', async () => {
        const driver = await startDriver({ release: false });
        driver.stop = true;
        const supervised = run(driver);
        await until('the stop', () => supervised.saw(MAILBOX_FILES.stop));
        driver.order(ORDER_GO);
        await supervised.done;
        expect(supervised.saw(MAILBOX_FILES.go)).toBe(false);
        expect(supervised.report()).toMatchObject({ outcome: 'cancelled', agentEnd: 'unlaunched' });
    });

    it('never launches the agent for a driver that does not answer past the orphan bound', async () => {
        const driver = await startDriver();
        const supervised = run({ ...driver, url: 'http://127.0.0.1:1' }, { SUPERVISOR_ORPHAN_MS: '200' });
        // Its own exit, not 0: a Job whose agent never ran must not read as a finished run to adopt.
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.lost);
        expect(supervised.saw(MAILBOX_FILES.go)).toBe(false);
        expect(supervised.report()).toMatchObject({ outcome: 'lost', cause: 'driver_lost', agentEnd: 'unlaunched' });
    });

    it('finalizes on its own once the agent is over and the driver stops answering past the orphan bound', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver, { SUPERVISOR_ORPHAN_MS: '300' });
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(0);
        await until('the report', () => driver.reports.length === 1);
        // The driver dies with its attempt: the finished agent's group ends by itself for the next claim to adopt.
        for (const server of servers) server.closeAllConnections();
        for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(supervised.report()).toMatchObject({ outcome: 'completed', agentExit: 0 });
    });

    it('finalizes inside the orphan bound when the driver is lost while the exporter drains', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver, {
            SUPERVISOR_EXPORTS: '1',
            SUPERVISOR_DRAIN_MS: '60000',
            SUPERVISOR_ORPHAN_MS: '300',
        });
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(0);
        await until('the drain order', () => supervised.saw(MAILBOX_FILES.drain, 'export'));
        // The driver is gone and the exporter, unable to reach it, never says `done`.
        for (const server of servers) server.closeAllConnections();
        for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
        const lost = Date.now();
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(Date.now() - lost).toBeLessThan(3_000);
        expect(supervised.report()).toMatchObject({ outcome: 'completed', agentExit: 0, drained: false });
    });

    it('keeps waiting on a slow drain while the driver still answers', async () => {
        const driver = await startDriver();
        const supervised = run(driver, { SUPERVISOR_EXPORTS: '1', SUPERVISOR_ORPHAN_MS: '200' });
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(0);
        await until('the drain order', () => supervised.saw(MAILBOX_FILES.drain, 'export'));
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(driver.reports).toEqual([]);
        supervised.exporterDone();
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(supervised.report()).toMatchObject({ outcome: 'completed', drained: true });
    });
});

describe('the supervisor run: its report, delivered until acknowledged', () => {
    it('redelivers its report after a 503 until the driver accepts it, keeps it, and keeps serving', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        driver.reportAnswer = (n) => (n < 3 ? 503 : 200);
        const supervised = run(driver);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(0);
        await until('the accepted delivery', () => driver.reports.length === 3);
        // One report, three deliveries: the driver takes it once by its id.
        expect(new Set(driver.reports.map((r) => r.id)).size).toBe(1);
        expect(driver.reports.every((r) => r.serving && r.outcome === 'completed')).toBe(true);
        await until('the acknowledgement on the volume', () => supervised.kept().acknowledged);
        expect(supervised.kept().report).toMatchObject({ id: driver.reports[0]!.id, serving: true });
        // Delivered and still serving: the steps after the agent are its.
        driver.order(step('probe-1', 'probe', ['node', '-e', 'console.log("after")']));
        await until('the probe', () => driver.answers.has('probe-1'));
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(driver.reports).toHaveLength(3);
        driver.order(ORDER_FINISH);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
    });

    it('redelivers a report whose answer was lost, under the same id', async () => {
        const driver = await startDriver();
        driver.reportAnswer = (n) => (n === 1 ? 'drop' : 200);
        const supervised = run(driver);
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(driver.reports).toHaveLength(2);
        expect(driver.reports[1]!.id).toBe(driver.reports[0]!.id);
    });

    it('stops redelivering once the driver no longer knows its token, and finalizes with the report kept', async () => {
        const driver = await startDriver();
        // The driver restarted as the report went out: the token it held is gone with it.
        driver.reportAnswer = () => 401;
        const supervised = run(driver);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(driver.reports).toHaveLength(1);
        expect(supervised.kept()).toMatchObject({ report: { outcome: 'completed' }, acknowledged: false });
        expect(supervised.report()).toMatchObject({ outcome: 'completed' });
    });

    it('departs under the same report id when a kill arrives while it serves, without waiting for `finish`', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(0);
        await until('the report', () => driver.reports.length === 1);
        expect(driver.reports[0]).toMatchObject({ serving: true });
        driver.kill = true;
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(driver.reports.at(-1)).toMatchObject({ id: driver.reports[0]!.id, serving: false });
        expect(supervised.kept()).toMatchObject({ report: { serving: false }, acknowledged: true });
    });

    it('departs when a kill lands between a failed delivery and its retry', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        driver.reportAnswer = (n) => {
            if (n > 1) return 200;
            driver.kill = true;
            return 503;
        };
        const supervised = run(driver);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        // The accepted delivery is the departure: nothing tells the driver this group still serves.
        expect(driver.reports.at(-1)).toMatchObject({ serving: false });
        expect(supervised.kept().acknowledged).toBe(true);
    });

    it.each([
        ['a kill', (driver: Driver) => (driver.kill = true), {}],
        ['the run budget', () => undefined, { SUPERVISOR_DEADLINE_MS: '100' }],
    ])('reports `serving: false` when it ends the attempt at %s', async (_how, end, env) => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver, env);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        end(driver);
        await until('the kill order', () => supervised.saw(MAILBOX_FILES.kill));
        supervised.agentExits(137);
        await supervised.done;
        expect(driver.reports).toHaveLength(1);
        expect(driver.reports[0]).toMatchObject({ serving: false });
    });

    it('bounds the departure’s delivery even while every other route answers, keeping the report', async () => {
        const driver = await startDriver();
        driver.reportAnswer = () => 503;
        const supervised = run(driver, { SUPERVISOR_REPORT_MS: '300' });
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        driver.kill = true;
        await until('the kill order', () => supervised.saw(MAILBOX_FILES.kill));
        supervised.agentExits(137);
        // Bounded by its own 300ms, never the default minute, however slow each delivery is.
        const ended = Date.now();
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(Date.now() - ended).toBeLessThan(10_000);
        expect(driver.reports.length).toBeGreaterThan(0);
        expect(supervised.kept()).toMatchObject({ report: { serving: false }, acknowledged: false });
    });
});

describe('the supervisor run: a step still running when it stops serving', () => {
    const SLOW = ['node', '-e', 'setTimeout(() => {}, 60000)'];

    it('interrupts it on a departure and records it unknown, never waiting out its timeout', async () => {
        const driver = await startDriver();
        const supervised = run(driver);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        driver.order(step('draft-1', 'publish', SLOW, { timeoutMs: 60_000 }));
        await until('the step to start', () =>
            existsSync(join(supervised.box.own, MAILBOX_FILES.steps, 'draft-1.json'))
        );
        driver.kill = true;
        await until('the kill order', () => supervised.saw(MAILBOX_FILES.kill));
        supervised.agentExits(137);
        const ended = Date.now();
        await supervised.done;
        expect(Date.now() - ended).toBeLessThan(10_000);
        expect(supervised.ledger('draft-1').invocations['i-1']).toMatchObject({ state: 'interrupted' });
    });

    it.each([
        [
            'the driver closes the endpoint',
            (driver: Driver) => {
                driver.closed = true;
            },
        ],
        [
            'the driver is lost past the orphan bound',
            async () => {
                for (const server of servers) server.closeAllConnections();
                for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
            },
        ],
    ])('interrupts it when %s', async (_how, lose) => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver, { SUPERVISOR_ORPHAN_MS: '300' });
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        supervised.agentExits(0);
        await until('the report', () => driver.reports.length === 1);
        driver.order(step('probe-1', 'probe', SLOW, { timeoutMs: 60_000 }));
        await until('the step to start', () =>
            existsSync(join(supervised.box.own, MAILBOX_FILES.steps, 'probe-1.json'))
        );
        const lost = Date.now();
        await lose(driver);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(Date.now() - lost).toBeLessThan(10_000);
        expect(supervised.ledger('probe-1').invocations['i-1']).toMatchObject({ state: 'interrupted' });
    });
});

describe('what crosses the mailboxes', () => {
    it('writes no credential into a directory the agent mounts, nor into the exporter’s', async () => {
        const driver = await startDriver();
        const supervised = run(driver, { SUPERVISOR_EXPORTS: '1' });
        supervised.agentAsks('toolu_1');
        await until('the question to reach the driver', () => driver.posted.length === 1);
        driver.kill = true;
        await until('the kill order', () => supervised.saw(MAILBOX_FILES.kill));
        supervised.agentExits(143);
        await until('the drain order', () => supervised.saw(MAILBOX_FILES.drain, 'export'));
        supervised.exporterDone();
        await supervised.done;

        const everyFile = (dir: string): string[] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
                entry.isDirectory() ? everyFile(join(dir, entry.name)) : [join(dir, entry.name)]
            );
        for (const where of [supervised.box.in, supervised.box.out, supervised.box.export]) {
            for (const file of everyFile(where)) expect(readFileSync(file, 'utf8'), file).not.toContain(TOKEN);
        }
    });

    it('speaks the contract the driver and the images spell: the same file names and exit statuses', () => {
        expect(supervisor.FILES).toEqual(MAILBOX_FILES);
        expect(supervisor.EXIT).toEqual(SUPERVISOR_EXIT);
        expect(supervisor.REPORT_MS).toBe(SUPERVISOR_REPORT_MS);
        expect(supervisor.STEP_KINDS).toEqual([...STEP_KINDS]);
    });

    it('gives the agent `in` read-only and `out` read-write, and no other mailbox', () => {
        expect(MAILBOXES.in.agent).toBe('ro');
        expect(MAILBOXES.out.agent).toBe('rw');
        expect(MAILBOXES.export.agent).toBeNull();
        expect(MAILBOXES.supervisor.agent).toBeNull();
        expect(MAILBOXES.supervisor.exporter).toBeNull();
        expect(MAILBOXES.export.exporter).toBe('rw');
    });

    it('names no Kubernetes API in the supervisor, which has none to reach', () => {
        const source = read('driver/src/scripts/supervisor.cjs');
        expect(source).not.toMatch(/serviceaccount|KUBERNETES_SERVICE|\/api\/v1|kubectl/i);
    });
});
