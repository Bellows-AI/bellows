import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import {
    type ClientRequest,
    createServer,
    type IncomingHttpHeaders,
    request as httpRequest,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoFile as read } from './fixtures/repo-files.js';
import { bindingBody } from '../src/supervisor-plan.js';
import {
    AGENT_MAILBOX_DIR,
    GATE_CANCEL_GRACE_MS,
    GATE_FILES,
    REVIEW_FILES,
    GATE_LOST_MS,
    MAILBOX_FILES,
    MAILBOXES,
    STEP_KINDS,
    STEP_OUTPUT_LIMIT_BYTES,
    SUPERVISOR_EXIT,
    SUPERVISOR_REPORT_MS,
    SUPERVISOR_REPORT_PREFIX,
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
    AGENT_DIR: string;
    STAGES: string[];
    TRANSITIONS: Record<string, string[]>;
    FILES: Record<string, string>;
    EXIT: { finalized: number; deadline: number; failed: number };
    REPORT_PREFIX: string;
    REPORT_MS: number;
    STEP_KINDS: string[];
    GATE_FILES: Record<string, string>;
    GATE_LOST_MS: number;
    GATE_CANCEL_MS: number;
    createMachine(initial?: string): Machine;
    supervise(env: Record<string, string>, log: (line: string) => void): Promise<number>;
}
const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as SupervisorModule;

const TOKEN = 'tok-supervisor-secret';
const AGENT_TOKEN = 'tok-agent-secret';
const EXPORT_TOKEN = 'tok-export-secret';

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
    /** The driver read the agent container ended (#920): `/control` says so beside the stop and the kill. */
    agentEnded: boolean;
    /** The gate steps the driver cancelled: what `/control` answers beside the stop and the kill. */
    cancel: string[];
    /** A driver that no longer knows the token: every route answers 401. */
    closed: boolean;
    posted: { id: string; body: unknown }[];
    /** The steps still to be pulled, and the answers the supervisor posted back. */
    queue: QueuedStep[];
    answers: Map<string, StepAnswer>;
    /** Every step answer body as it arrived, the refused ones too. */
    answerBodies: string[];
    /** How a step's answer is answered, before the size bound applies. */
    stepAnswer: (id: string) => number;
    reports: Report[];
    /** How the n-th report delivery (from 1) is answered: a status, or `drop` — the answer is lost. */
    reportAnswer: (n: number) => number | 'drop';
    /** Whether the driver orders `finish` as soon as the supervisor reports; off, the supervisor keeps serving. */
    autoFinish: boolean;
    order(step: QueuedStep): void;
    /** The bearer token this driver accepts. */
    token: string;
    /** Every request it received, whatever the route. */
    calls: number;
    /** While set, a step pull waits for it before the queue is read: a holder that hands its step late. */
    hold: Promise<void> | null;
    /** How many step pulls are waiting on `hold`. */
    held: number;
    /** While set, every request is dropped unanswered: a driver that is gone. */
    silent: boolean;
    /** While set, the supervisor's own routes are dropped but the relayed ones answer: a driver only the agent reaches. */
    silentControl: boolean;
    /** The agent's and the exporter's bearer tokens this driver accepts on the relayed routes. */
    agentToken: string;
    exportToken: string;
    /** Every relayed request (`/publish`, `/review`, `/export`) it received, and whether its connection has closed. */
    seen: { method: string; url: string; authorization: string; body: Buffer; closed: boolean }[];
    /** Replaces the default relayed answer; the request has already been recorded in `seen`. */
    relayAnswer: ((response: ServerResponse, entry: Driver['seen'][number]) => void | Promise<void>) | null;
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

const readBytes = (request: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve) => {
        const parts: Buffer[] = [];
        request.on('data', (chunk: Buffer) => parts.push(chunk));
        request.on('end', () => resolve(Buffer.concat(parts)));
        request.on('close', () => resolve(Buffer.concat(parts)));
    });

/** The driver's run-control endpoint as the supervisor sees it: `/control`, and the question routes. */
async function startDriver({
    release = true,
    token = TOKEN,
    agentToken = AGENT_TOKEN,
    exportToken = EXPORT_TOKEN,
}: {
    release?: boolean;
    token?: string;
    agentToken?: string;
    exportToken?: string;
} = {}): Promise<Driver> {
    const driver: Driver = {
        url: '',
        token,
        calls: 0,
        hold: null,
        held: 0,
        silent: false,
        silentControl: false,
        agentToken,
        exportToken,
        seen: [],
        relayAnswer: null,
        stop: false,
        kill: false,
        agentEnded: false,
        cancel: [],
        closed: false,
        posted: [],
        queue: release ? [ORDER_GO] : [],
        answers: new Map(),
        answerBodies: [],
        stepAnswer: () => 200,
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
            driver.calls += 1;
            if (driver.silent) return request.socket.destroy();
            if (/^\/(publish|review|export)(\/|\?|$)/.test(request.url ?? '')) {
                const entry = {
                    method: request.method ?? '',
                    url: request.url ?? '',
                    authorization: request.headers.authorization ?? '',
                    body: await readBytes(request),
                    closed: false,
                };
                request.socket.on('close', () => (entry.closed = true));
                driver.seen.push(entry);
                if (driver.relayAnswer) return void (await driver.relayAnswer(response, entry));
                const want = (request.url ?? '').startsWith('/export') ? driver.exportToken : driver.agentToken;
                if (entry.authorization !== `Bearer ${want}`) return send(401, {});
                return send(200, {
                    echoed: entry.url,
                    bytes: entry.body.length,
                    sha: createHash('sha256').update(entry.body).digest('hex'),
                });
            }
            if (driver.silentControl) return request.socket.destroy();
            if (driver.closed || request.headers.authorization !== `Bearer ${driver.token}`) return send(401, {});
            if (request.method === 'GET' && request.url === '/control') {
                const cancel = driver.cancel.length > 0 ? { cancel: driver.cancel } : {};
                const ended = driver.agentEnded ? { agentEnded: true } : {};
                return send(200, { stop: driver.stop, kill: driver.kill, ...ended, ...cancel });
            }
            if (request.method === 'GET' && request.url?.startsWith('/step?')) {
                if (driver.hold) {
                    driver.held += 1;
                    await driver.hold;
                }
                // A pull held across a close answers as the closed driver does.
                if (driver.closed) return send(401, {});
                const next = driver.queue.shift();
                if (next) return send(200, { step: next });
                await new Promise((resolve) => setTimeout(resolve, 20));
                return send(200, {});
            }
            if (request.method === 'POST' && request.url?.startsWith('/step/')) {
                const id = decodeURIComponent(request.url.slice('/step/'.length));
                const body = await readBody(request);
                driver.answerBodies.push(body);
                const status = driver.stepAnswer(id);
                if (status !== 200) return send(status, {});
                // The driver's own bound (step-control.ts): two capped streams plus framing.
                if (Buffer.byteLength(body) > STEP_OUTPUT_LIMIT_BYTES * 2 + 4096) return send(413, {});
                driver.answers.set(id, JSON.parse(body) as StepAnswer);
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
    const box = {
        in: dir('in'),
        out: dir('out'),
        export: dir('export'),
        own: dir('supervisor'),
        gate: dir('gate'),
        review: dir('review'),
    };
    for (const path of Object.values(box)) mkdirSync(path, { recursive: true });
    // The agent's own directories inside its two mailboxes, which the supervisor creates (issue #814).
    const agent = { in: join(box.in, AGENT_MAILBOX_DIR), out: join(box.out, AGENT_MAILBOX_DIR) };
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
        agent,
        done,
        logs,
        report,
        /** The agent container's end, as its entrypoint writes it. */
        agentExits: (code: number) => writeFileSync(join(agent.out, MAILBOX_FILES.agentExit), `${code}\n`),
        agentAsks: (id: string) =>
            writeFileSync(
                join(agent.out, MAILBOX_FILES.questions, `${id}.json`),
                JSON.stringify({ id, questions: [{ question: 'which?' }] })
            ),
        answerOf: (id: string) =>
            JSON.parse(readFileSync(join(agent.in, MAILBOX_FILES.answers, `${id}.json`), 'utf8')) as { state: string },
        saw: (name: string, where: 'in' | 'export' | 'own' = 'in') =>
            existsSync(join(where === 'in' ? agent.in : box[where], name)),
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
        writeFileSync(join(supervised.agent.out, MAILBOX_FILES.agentAlive), `${Date.now() - 10_000}\n`);
        await supervised.done;
        expect(supervised.report()).toMatchObject({ outcome: 'lost', cause: 'agent_lost', agentEnd: 'lost' });
    });

    it('reads an agent container the driver saw end with no exit marker as lost at once, inside the start window (#920)', async () => {
        const driver = await startDriver();
        // The start and heartbeat windows are minutes: only the driver's reading of the container can end this in seconds.
        const supervised = run(driver, { SUPERVISOR_AGENT_START_MS: '600000', SUPERVISOR_AGENT_LOST_MS: '600000' });
        await until('the agent to be released', () => existsSync(join(supervised.agent.in, MAILBOX_FILES.go)));
        const began = Date.now();
        driver.agentEnded = true;
        await supervised.done;
        expect(Date.now() - began).toBeLessThan(10_000);
        expect(supervised.report()).toMatchObject({ outcome: 'lost', cause: 'agent_lost', agentEnd: 'lost' });
    });

    it("keeps the exit marker above the driver's reading: an agent that wrote agent.exit ended on its own (#920)", async () => {
        const driver = await startDriver();
        driver.agentEnded = true;
        const supervised = run(driver);
        supervised.agentExits(3);
        await supervised.done;
        expect(supervised.report()).toMatchObject({ outcome: 'failed', agentExit: 3, agentEnd: 'exit' });
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

    // Issue #814: the agent's tools run as their own uid in group 1000, so a step that writes the
    // tree (the sync, a publish) writes it group-writable — and the supervisor's own umask is untouched.
    it('runs every step under umask 002', async () => {
        const driver = await startDriver();
        const before = process.umask();
        driver.order(step('umask-1', 'helper', ['sh', '-c', 'umask']));
        const supervised = run(driver);
        await until('the answer', () => driver.answers.has('umask-1'));
        expect(driver.answers.get('umask-1')?.stdout.trim()).toBe('0002');
        expect(process.umask()).toBe(before);
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
        // The logged line says so too: the volume is gone with the pod, the log is what a lane reads.
        expect(supervised.report()).toMatchObject({ acknowledged: true });
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
        expect(supervised.report()).toMatchObject({ outcome: 'completed', acknowledged: false });
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
        expect(supervised.report()).toMatchObject({ acknowledged: true });
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
        expect(supervised.report()).toMatchObject({ acknowledged: false });
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

/** What one gate request carried across the mailbox, as the gate loop read it. */
interface GateRequestSeen {
    id: string;
    command: string;
    cwd: string;
    env: string;
}
/** How the fake loop answers one request: its exit and output, after `holdMs`. */
interface GatePlan {
    exitCode: number;
    output: string;
    holdMs?: number;
}

/**
 * The gate container's loop (`scripts/gate-loop.sh`), PLAYED in JS over the same mailbox: it claims a
 * request by renaming it into `running/`, reads its files, drops the env, honors a `cancel`, and
 * answers `output` and `exit` before renaming it into `done/`. The real loop is never executed here:
 * its `kill -KILL -1` would end every process of the user running the suite.
 */
function fakeGateLoop(
    gateDir: string,
    plan: (request: GateRequestSeen) => GatePlan = () => ({ exitCode: 0, output: 'ok' })
) {
    const at = (...parts: string[]) => join(gateDir, ...parts);
    for (const sub of [GATE_FILES.requests, GATE_FILES.running, GATE_FILES.done])
        mkdirSync(at(sub), { recursive: true });
    const loop = {
        seen: [] as GateRequestSeen[],
        cancelled: [] as string[],
        beating: true,
        taking: true,
    };
    const held = new Map<string, { plan: GatePlan; since: number }>();
    const answer = (id: string, exitCode: number, output: string) => {
        writeFileSync(at(GATE_FILES.running, id, GATE_FILES.output), output);
        writeFileSync(at(GATE_FILES.running, id, 'exit.tmp'), `${exitCode}\n`);
        renameSync(at(GATE_FILES.running, id, 'exit.tmp'), at(GATE_FILES.running, id, GATE_FILES.exit));
        renameSync(at(GATE_FILES.running, id), at(GATE_FILES.done, id));
        held.delete(id);
    };
    const tick = () => {
        if (loop.beating) writeFileSync(at(GATE_FILES.alive), '');
        if (loop.taking) {
            for (const id of readdirSync(at(GATE_FILES.requests))) {
                renameSync(at(GATE_FILES.requests, id), at(GATE_FILES.running, id));
                const file = (name: string) => readFileSync(at(GATE_FILES.running, id, name), 'utf8');
                const request = {
                    id,
                    command: file(GATE_FILES.command),
                    cwd: file(GATE_FILES.cwd),
                    env: file(GATE_FILES.env),
                };
                rmSync(at(GATE_FILES.running, id, GATE_FILES.env));
                loop.seen.push(request);
                held.set(id, { plan: plan(request), since: Date.now() });
            }
        }
        for (const [id, { plan: answerPlan, since }] of held) {
            if (existsSync(at(GATE_FILES.running, id, GATE_FILES.cancel))) {
                loop.cancelled.push(id);
                answer(id, 137, 'killed');
            } else if (loop.beating && Date.now() - since >= (answerPlan.holdMs ?? 0)) {
                answer(id, answerPlan.exitCode, answerPlan.output);
            }
        }
    };
    const timer = setInterval(tick, 5);
    loops.push(timer);
    return loop;
}
const loops: NodeJS.Timeout[] = [];
afterEach(() => {
    for (const timer of loops.splice(0)) clearInterval(timer);
});

const GATED = { SUPERVISOR_GATE: '1', SUPERVISOR_GATE_LOST_MS: '300', SUPERVISOR_GATE_CANCEL_MS: '300' };
const WORKTREE = '/workspaces/org/44444444-4444-4444-8444-444444444444/.worktrees/55555555-5555-4555-8555-555555555555';
const gateStep = (id: string, command: string, extra: Partial<QueuedStep> = {}): QueuedStep =>
    step(id, 'gate', [command], { cwd: WORKTREE, ...extra });

describe('the supervisor run: gate steps through the gate mailbox', () => {
    it('hands the gate its command, worktree and env, and answers the exit and the output', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        const loop = fakeGateLoop(supervised.box.gate, () => ({ exitCode: 3, output: '1 failing' }));
        driver.order(gateStep('gate-1', 'npm test', { env: { CI: 'true', TOKEN: 'gh-value' } }));
        await until('the gate answer', () => driver.answers.has('gate-1'));
        expect(driver.answers.get('gate-1')).toMatchObject({ exitCode: 3, stdout: '1 failing', timedOut: false });
        expect(loop.seen).toEqual([
            { id: 'gate-1', command: 'npm test', cwd: WORKTREE, env: 'CI=true\nTOKEN=gh-value\n' },
        ]);
        // The answer is read and gone: the mailbox keeps no finished request.
        expect(readdirSync(join(supervised.box.gate, GATE_FILES.done))).toEqual([]);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('cancels a gate past its deadline and answers it timed out, as the 124 of `timeout`', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        const loop = fakeGateLoop(supervised.box.gate, () => ({ exitCode: 0, output: '', holdMs: 60_000 }));
        driver.order(gateStep('gate-1', 'sleep 60', { timeoutMs: 200 }));
        await until('the gate answer', () => driver.answers.has('gate-1'));
        expect(loop.cancelled).toEqual(['gate-1']);
        expect(driver.answers.get('gate-1')).toMatchObject({ exitCode: 124, timedOut: true });
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers no exit — never a verdict — for a request the gate loop never took', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        const loop = fakeGateLoop(supervised.box.gate);
        loop.beating = false;
        loop.taking = false;
        driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
        await until('the gate answer', () => driver.answers.has('gate-1'));
        expect(driver.answers.get('gate-1')).toMatchObject({ exitCode: null, timedOut: false });
        expect(driver.answers.get('gate-1')?.stderr).toMatch(/never took/);
        // Never taken, so never to be taken: the request is withdrawn.
        expect(readdirSync(join(supervised.box.gate, GATE_FILES.requests))).toEqual([]);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers no exit for a request the gate loop took and then went silent on', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        const loop = fakeGateLoop(supervised.box.gate, () => ({ exitCode: 0, output: '', holdMs: 60_000 }));
        driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
        await until('the gate to be taken', () => loop.seen.length === 1);
        loop.beating = false;
        await until('the gate answer', () => driver.answers.has('gate-1'));
        expect(driver.answers.get('gate-1')).toMatchObject({ exitCode: null, timedOut: false });
        expect(driver.answers.get('gate-1')?.stderr).toMatch(/lost mid-run/);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers a gate whose output escapes to many times its bytes within the driver bound', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        // A NUL is one byte on disk and six (`\\u0000`) in the JSON answer.
        const output = `${'\0'.repeat(STEP_OUTPUT_LIMIT_BYTES)}the tail`;
        fakeGateLoop(supervised.box.gate, () => ({ exitCode: 0, output }));
        driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
        await until('the gate answer', () => driver.answers.has('gate-1'));
        const answer = driver.answers.get('gate-1');
        expect(answer).toMatchObject({ exitCode: 0, timedOut: false });
        expect(answer?.stdout.endsWith('the tail')).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(answer?.stdout))).toBeLessThanOrEqual(STEP_OUTPUT_LIMIT_BYTES);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers a command step whose streams escape past their bytes within the driver bound', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        const script = `process.stdout.write('\\x01'.repeat(${STEP_OUTPUT_LIMIT_BYTES}) + 'the tail')`;
        driver.order(step('helper-1', 'helper', ['node', '-e', script], { timeoutMs: 30_000 }));
        await until('the helper answer', () => driver.answers.has('helper-1'));
        const answer = driver.answers.get('helper-1');
        expect(answer?.stdout.endsWith('the tail')).toBe(true);
        expect(Buffer.byteLength(JSON.stringify(answer?.stdout))).toBeLessThanOrEqual(STEP_OUTPUT_LIMIT_BYTES);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('re-posts a refused-as-too-large answer without its streams, keeping the verdict', async () => {
        const driver = await startDriver();
        let refused = false;
        driver.stepAnswer = (id) => {
            if (id !== 'gate-1' || refused) return 200;
            refused = true;
            return 413;
        };
        const supervised = run(driver, GATED);
        fakeGateLoop(supervised.box.gate, () => ({ exitCode: 3, output: '1 failing' }));
        driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
        await until('the gate answer', () => driver.answers.has('gate-1'));
        expect(driver.answers.get('gate-1')).toMatchObject({
            exitCode: 3,
            stdout: '',
            stderr: 'the step output was too large to deliver',
            timedOut: false,
        });
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers another step while a gate runs: a gate never holds the step queue', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        fakeGateLoop(supervised.box.gate, () => ({ exitCode: 0, output: 'passed', holdMs: 1_500 }));
        driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
        driver.order(step('draft-1', 'publish', ['node', '-e', 'console.log("drafted")']));
        await until('the publish answer', () => driver.answers.has('draft-1'));
        expect(driver.answers.has('gate-1')).toBe(false);
        await until('the gate answer', () => driver.answers.has('gate-1'));
        expect(driver.answers.get('gate-1')).toMatchObject({ exitCode: 0, stdout: 'passed' });
        supervised.agentExits(0);
        await supervised.done;
    });

    it('takes a cancel off the control poll, not the step queue, even with a long step running', async () => {
        const driver = await startDriver();
        // The driver's own pace is slow here: a gate in flight is what quickens the poll.
        const supervised = run(driver, { ...GATED, SUPERVISOR_CONTROL_MS: '60000' });
        const loop = fakeGateLoop(supervised.box.gate, () => ({ exitCode: 0, output: '', holdMs: 60_000 }));
        driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
        await until('the gate to be taken', () => loop.seen.length === 1);
        driver.order(step('helper-1', 'helper', ['node', '-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 60_000 }));
        await until('the helper to start', () =>
            existsSync(join(supervised.box.own, MAILBOX_FILES.steps, 'helper-1.json'))
        );
        driver.cancel.push('gate-1');
        await until('the cancel to reach the gate loop', () => loop.cancelled.includes('gate-1'), 2_000);
        await until('the gate answer', () => driver.answers.has('gate-1'));
        expect(driver.answers.get('gate-1')?.timedOut).toBe(false);
        // The helper still holds the step queue: the group ends by its closed endpoint, read off the report.
        supervised.agentExits(0);
        driver.closed = true;
        await supervised.done;
    });

    it('withdraws a cancelled gate the loop has not taken yet, without running it', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        const loop = fakeGateLoop(supervised.box.gate);
        loop.taking = false;
        driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
        await until('the request', () => readdirSync(join(supervised.box.gate, GATE_FILES.requests)).length === 1);
        driver.cancel.push('gate-1');
        await until('the gate answer', () => driver.answers.has('gate-1'));
        loop.taking = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(loop.seen).toEqual([]);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('interrupts a gate still running when the driver orders `finish`', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver, GATED);
        const loop = fakeGateLoop(supervised.box.gate, () => ({ exitCode: 0, output: '', holdMs: 60_000 }));
        supervised.agentExits(0);
        await until('the report', () => driver.reports.length === 1);
        driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
        await until('the gate to be taken', () => loop.seen.length === 1);
        driver.order(ORDER_FINISH);
        const finished = Date.now();
        await supervised.done;
        expect(Date.now() - finished).toBeLessThan(10_000);
        expect(loop.cancelled).toEqual(['gate-1']);
        expect(supervised.ledger('gate-1').invocations['i-1']).toMatchObject({ state: 'interrupted' });
    });

    it('refuses a gate step in a group with no gate container, without writing a request', async () => {
        const driver = await startDriver();
        const supervised = run(driver);
        driver.order(gateStep('gate-1', 'npm test'));
        await until('the gate answer', () => driver.answers.has('gate-1'));
        expect(driver.answers.get('gate-1')).toMatchObject({ exitCode: 126 });
        expect(driver.answers.get('gate-1')?.stderr).toMatch(/no gate container/);
        expect(existsSync(join(supervised.box.gate, GATE_FILES.requests))).toBe(false);
        supervised.agentExits(0);
        await supervised.done;
    });

    it.each([
        ['a name sh cannot export', { 'NPM.CONFIG': '1' }, /cannot be exported/],
        ['a value holding a newline', { CI: 'a\nEVIL=1' }, /newline/],
    ])('refuses a gate whose env carries %s, without writing a request', async (_what, env, why) => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        const loop = fakeGateLoop(supervised.box.gate);
        driver.order(gateStep('gate-1', 'npm test', { env }));
        await until('the gate answer', () => driver.answers.has('gate-1'));
        expect(driver.answers.get('gate-1')).toMatchObject({ exitCode: 126 });
        expect(driver.answers.get('gate-1')?.stderr).toMatch(why);
        expect(loop.seen).toEqual([]);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('runs every gate execution it is asked for, and answers a redelivered one from its ledger', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        const loop = fakeGateLoop(supervised.box.gate, () => ({ exitCode: 0, output: 'passed', holdMs: 300 }));
        // The same named gate, asked twice: two executions, two ids.
        driver.order(gateStep('gate-a', 'npm test'));
        await until('the first answer', () => driver.answers.has('gate-a'));
        driver.order(gateStep('gate-b', 'npm test'));
        await until('the second answer', () => driver.answers.has('gate-b'));
        // A delivery of the first again, under its own invocation: answered as it ended, never run.
        driver.answers.delete('gate-a');
        driver.order(gateStep('gate-a', 'npm test'));
        await until('the redelivered answer', () => driver.answers.has('gate-a'));
        expect(driver.answers.get('gate-a')).toMatchObject({ exitCode: 0, replayed: true });
        expect(loop.seen.map((seen) => seen.id)).toEqual(['gate-a', 'gate-b']);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('joins a delivery of a gate still running instead of running it twice', async () => {
        const driver = await startDriver();
        const supervised = run(driver, GATED);
        const loop = fakeGateLoop(supervised.box.gate, () => ({ exitCode: 0, output: 'passed', holdMs: 500 }));
        driver.order(gateStep('gate-1', 'npm test'));
        await until('the gate to be taken', () => loop.seen.length === 1);
        driver.order(gateStep('gate-1', 'npm test'));
        await until('the answer', () => driver.answers.has('gate-1'));
        expect(driver.answers.get('gate-1')).toMatchObject({ exitCode: 0, stdout: 'passed' });
        expect(loop.seen).toHaveLength(1);
        supervised.agentExits(0);
        await supervised.done;
    });
});

const REVIEWING = { SUPERVISOR_REVIEWER: '1', SUPERVISOR_GATE_LOST_MS: '300', SUPERVISOR_GATE_CANCEL_MS: '300' };
const reviewStep = (id: string, argv: string[], extra: Partial<QueuedStep> = {}): QueuedStep =>
    step(id, 'review', argv, { cwd: WORKTREE, ...extra });

describe('the supervisor run: review steps through the review mailbox (issue #774)', () => {
    it('hands the reviewer its argv as one quoted command, its worktree and env, and answers the output', async () => {
        const driver = await startDriver();
        const supervised = run(driver, REVIEWING);
        const loop = fakeGateLoop(supervised.box.review, () => ({ exitCode: 0, output: 'the review' }));
        driver.order(reviewStep('review-1', ['claude', '-p', "it's"], { env: { KEY: 'v' } }));
        await until('the review answer', () => driver.answers.has('review-1'));
        expect(driver.answers.get('review-1')).toMatchObject({ exitCode: 0, stdout: 'the review', timedOut: false });
        expect(loop.seen).toEqual([
            { id: 'review-1', command: "'claude' '-p' 'it'\\''s'", cwd: WORKTREE, env: 'KEY=v\n' },
        ]);
        expect(readdirSync(join(supervised.box.review, GATE_FILES.done))).toEqual([]);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers 124, timed out, for a review past its deadline', async () => {
        const driver = await startDriver();
        const supervised = run(driver, REVIEWING);
        const loop = fakeGateLoop(supervised.box.review, () => ({ exitCode: 0, output: '', holdMs: 60_000 }));
        driver.order(reviewStep('review-1', ['sleep', '60'], { timeoutMs: 200 }));
        await until('the review answer', () => driver.answers.has('review-1'));
        expect(loop.cancelled).toEqual(['review-1']);
        expect(driver.answers.get('review-1')).toMatchObject({ exitCode: 124, timedOut: true });
        supervised.agentExits(0);
        await supervised.done;
    });

    it('opens the review mailbox to the reviewer\u2019s group: its directories and the request it claims', async () => {
        // The reviewer is another uid of the supervisor's group (REVIEWER_UID, GATE_GID): it must
        // create the loop's heartbeat, claim a request by rename and write its answer beside it
        // (test:jobs: "can't create /factory/review/alive: Permission denied").
        const driver = await startDriver();
        const supervised = run(driver, REVIEWING);
        const loop = fakeGateLoop(supervised.box.review, () => ({ exitCode: 0, output: '', holdMs: 60_000 }));
        driver.order(reviewStep('review-1', ['sleep', '60'], { env: { KEY: 'v' }, timeoutMs: 60_000 }));
        await until('the review to be taken', () => loop.seen.length === 1);
        const mode = (...parts: string[]) => statSync(join(supervised.box.review, ...parts)).mode & 0o777;
        const groupWritable = (m: number) => (m & 0o070) === 0o070;
        for (const dir of ['', GATE_FILES.requests, GATE_FILES.running, GATE_FILES.done]) {
            expect(groupWritable(mode(dir)), `the review mailbox ${dir || 'root'}`).toBe(true);
        }
        expect(groupWritable(mode(GATE_FILES.running, 'review-1')), 'the claimed request').toBe(true);
        driver.cancel.push('review-1');
        await until('the review answer', () => driver.answers.has('review-1'));
        supervised.agentExits(0);
        await supervised.done;
    });

    it('cancels a review off the control poll, answering the 130 the driver discards', async () => {
        const driver = await startDriver();
        const supervised = run(driver, REVIEWING);
        const loop = fakeGateLoop(supervised.box.review, () => ({ exitCode: 0, output: '', holdMs: 60_000 }));
        driver.order(reviewStep('review-1', ['sleep', '60'], { timeoutMs: 60_000 }));
        await until('the review to be taken', () => loop.seen.length === 1);
        driver.cancel.push('review-1');
        await until('the review answer', () => driver.answers.has('review-1'));
        expect(loop.cancelled).toEqual(['review-1']);
        expect(driver.answers.get('review-1')).toMatchObject({ exitCode: 130, timedOut: false });
        supervised.agentExits(0);
        await supervised.done;
    });

    it('answers no exit — no verdict — for a reviewer that went silent mid-review', async () => {
        const driver = await startDriver();
        const supervised = run(driver, REVIEWING);
        const loop = fakeGateLoop(supervised.box.review, () => ({ exitCode: 0, output: '', holdMs: 60_000 }));
        driver.order(reviewStep('review-1', ['sleep', '60'], { timeoutMs: 60_000 }));
        await until('the review to be taken', () => loop.seen.length === 1);
        loop.beating = false;
        await until('the review answer', () => driver.answers.has('review-1'));
        expect(driver.answers.get('review-1')).toMatchObject({ exitCode: null, timedOut: false });
        expect(driver.answers.get('review-1')?.stderr).toMatch(/lost mid-run/);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('interrupts a review still running when the driver orders `finish`', async () => {
        const driver = await startDriver();
        driver.autoFinish = false;
        const supervised = run(driver, REVIEWING);
        const loop = fakeGateLoop(supervised.box.review, () => ({ exitCode: 0, output: '', holdMs: 60_000 }));
        supervised.agentExits(0);
        await until('the report', () => driver.reports.length === 1);
        driver.order(reviewStep('review-1', ['sleep', '60'], { timeoutMs: 60_000 }));
        await until('the review to be taken', () => loop.seen.length === 1);
        driver.order(ORDER_FINISH);
        await supervised.done;
        expect(loop.cancelled).toEqual(['review-1']);
        expect(supervised.ledger('review-1').invocations['i-1']).toMatchObject({ state: 'interrupted' });
    });

    it('refuses a review step in a group with no reviewer container, without writing a request', async () => {
        const driver = await startDriver();
        const supervised = run(driver);
        driver.order(reviewStep('review-1', ['claude']));
        await until('the review answer', () => driver.answers.has('review-1'));
        expect(driver.answers.get('review-1')).toMatchObject({ exitCode: 126 });
        expect(driver.answers.get('review-1')?.stderr).toMatch(/no reviewer container/);
        expect(existsSync(join(supervised.box.review, GATE_FILES.requests))).toBe(false);
        supervised.agentExits(0);
        await supervised.done;
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

    // Issue #814: the agent's tools run as their own uid in the agent container, which mounts `in`
    // and `out` whole. The agent's files live in a directory only its own uid can open.
    it('makes the agent’s own mailbox directories owner-only before it releases the agent', async () => {
        const driver = await startDriver();
        const supervised = run(driver);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        for (const where of [supervised.agent.in, supervised.agent.out]) {
            expect(statSync(where).mode & 0o777, where).toBe(0o700);
        }
        supervised.agentExits(0);
        await supervised.done;
    });

    it('speaks the contract the driver and the images spell: the same file names and exit statuses', () => {
        expect(supervisor.AGENT_DIR).toBe(AGENT_MAILBOX_DIR);
        expect(supervisor.FILES).toEqual(MAILBOX_FILES);
        expect(supervisor.EXIT).toEqual(SUPERVISOR_EXIT);
        expect(supervisor.REPORT_MS).toBe(SUPERVISOR_REPORT_MS);
        expect(supervisor.REPORT_PREFIX).toBe(SUPERVISOR_REPORT_PREFIX);
        expect(supervisor.STEP_KINDS).toEqual([...STEP_KINDS]);
        expect(supervisor.GATE_FILES).toEqual(GATE_FILES);
        expect(supervisor.GATE_LOST_MS).toBe(GATE_LOST_MS);
        expect(supervisor.GATE_CANCEL_MS).toBe(GATE_CANCEL_GRACE_MS);
    });

    it('gives the agent `in` read-only and `out` read-write, and no other mailbox', () => {
        expect(MAILBOXES.in.agent).toBe('ro');
        expect(MAILBOXES.out.agent).toBe('rw');
        expect(MAILBOXES.export.agent).toBeNull();
        expect(MAILBOXES.supervisor.agent).toBeNull();
        expect(MAILBOXES.supervisor.exporter).toBeNull();
        expect(MAILBOXES.export.exporter).toBe('rw');
    });

    it('gives the gate mailbox to the supervisor and the gate container alone', () => {
        expect(MAILBOXES.gate).toMatchObject({ supervisor: 'rw', agent: null, exporter: null, gate: 'rw' });
        for (const box of [MAILBOXES.in, MAILBOXES.out, MAILBOXES.export, MAILBOXES.supervisor]) {
            expect(box.gate, box.name).toBeNull();
        }
    });

    it('gives the review mailbox to the supervisor and the reviewer container alone (#774)', () => {
        expect(MAILBOXES.review).toMatchObject({
            supervisor: 'rw',
            agent: null,
            exporter: null,
            gate: null,
            reviewer: 'rw',
        });
        expect(MAILBOXES.review.path).toBe('/factory/review');
        expect(REVIEW_FILES).toEqual(GATE_FILES);
        for (const box of [MAILBOXES.in, MAILBOXES.out, MAILBOXES.export, MAILBOXES.supervisor, MAILBOXES.gate]) {
            expect(box.reviewer, box.name).toBeNull();
        }
    });

    it('names no Kubernetes API in the supervisor, which has none to reach', () => {
        const source = read('driver/src/scripts/supervisor.cjs');
        expect(source).not.toMatch(/serviceaccount|KUBERNETES_SERVICE|\/api\/v1|kubectl/i);
    });
});

describe('the supervisor run: following a newer holder (issue #829)', () => {
    const NEWER_TOKEN = 'tok-newer-holder-secret';

    /** A supervisor of claim 1 that reads its binding file, and the writer of that file. */
    function bound(driver: Driver, env: Record<string, string> = {}) {
        const dir = mkdtempSync(join(tmpdir(), 'binding-'));
        dirs.push(dir);
        const file = join(dir, 'binding.json');
        const supervised = run(driver, { SUPERVISOR_CLAIM_SEQ: '1', SUPERVISOR_BINDING_FILE: file, ...env });
        return {
            supervised,
            file,
            name: (next: Driver, claimSeq: number) =>
                writeFileSync(
                    file,
                    bindingBody({
                        claimSeq,
                        url: next.url,
                        token: next.token,
                        agentToken: next.agentToken,
                        exportToken: next.exportToken,
                    })
                ),
            rebound: () => supervised.logs.some((line) => line.startsWith('supervisor: rebound to claim')),
        };
    }

    it('follows a strictly newer holder: the report and the finish go to it, not to the old one', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        old.autoFinish = false;
        const { supervised, name, rebound } = bound(old);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        name(next, 2);
        await until('the rebind', rebound);
        expect(supervised.logs).toContain('supervisor: rebound to claim 2');
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(next.reports).toHaveLength(1);
        expect(old.reports).toHaveLength(0);
    });

    it('does not log the accepted binding as ignored on later polls', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        old.autoFinish = false;
        const { supervised, name, rebound } = bound(old);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        name(next, 2);
        await until('the rebind', rebound);
        await new Promise((resolve) => setTimeout(resolve, 300));
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        const after = supervised.logs.slice(supervised.logs.indexOf('supervisor: rebound to claim 2') + 1);
        expect(after).not.toContain('supervisor: ignored a binding that names no newer holder');
    });

    it('refuses a holder that is not newer: an equal claim under another token, and an older one', async () => {
        const [old, other] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        const { supervised, name } = bound(old);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        name(other, 1);
        await new Promise((resolve) => setTimeout(resolve, 150));
        name(other, 0);
        await new Promise((resolve) => setTimeout(resolve, 150));
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(other.calls).toBe(0);
        expect(old.reports).toHaveLength(1);
        expect(supervised.logs.some((line) => line.startsWith('supervisor: rebound'))).toBe(false);
    });

    const NAMED = (
        claimSeq: string,
        url: string,
        token: string,
        relay = { agent: AGENT_TOKEN, export: EXPORT_TOKEN }
    ) =>
        `{"claimSeq":${claimSeq},"url":${JSON.stringify(url)},"token":${JSON.stringify(token)},"agentToken":${JSON.stringify(relay.agent)},"exportToken":${JSON.stringify(relay.export)}}`;
    it.each([
        ['an empty file', () => ''],
        ['a partial write', () => '{"claimSeq":2,"url":"http://127'],
        ['a claim sequence that is a string', (u: string) => NAMED('"2"', u, NEWER_TOKEN)],
        ['a negative claim sequence', (u: string) => NAMED('-1', u, NEWER_TOKEN)],
        ['a claim sequence past any number', (u: string) => NAMED('1e309', u, NEWER_TOKEN)],
        ['a claim sequence of huge digits', (u: string) => NAMED('99999999999999999999', u, NEWER_TOKEN)],
        ['a url that is not http', () => NAMED('2', 'ftp://127.0.0.1:1', NEWER_TOKEN)],
        ['no token', (u: string) => NAMED('2', u, '')],
        ['a token with whitespace', (u: string) => NAMED('2', u, 'tok en')],
        ['no agent token', (u: string) => NAMED('2', u, NEWER_TOKEN, { agent: '', export: EXPORT_TOKEN })],
        [
            'an agent token with whitespace',
            (u: string) => NAMED('2', u, NEWER_TOKEN, { agent: 'tok en', export: EXPORT_TOKEN }),
        ],
        ['no export token', (u: string) => NAMED('2', u, NEWER_TOKEN, { agent: AGENT_TOKEN, export: '' })],
        [
            'an export token with whitespace',
            (u: string) => NAMED('2', u, NEWER_TOKEN, { agent: AGENT_TOKEN, export: 'tok en' }),
        ],
        [
            'a binding that names no relay tokens at all',
            (u: string) => `{"claimSeq":2,"url":${JSON.stringify(u)},"token":"${NEWER_TOKEN}"}`,
        ],
        ['an array', () => '[]'],
    ])('keeps the holder it has through %s', async (_what, content) => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        const { supervised, file } = bound(old);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        writeFileSync(file, content(next.url));
        await new Promise((resolve) => setTimeout(resolve, 150));
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(next.calls).toBe(0);
        expect(old.reports).toHaveLength(1);
        expect(supervised.logs.join('\n')).not.toContain(NEWER_TOKEN);
        expect(supervised.logs.join('\n')).not.toContain(next.url);
    });

    it('keeps the holder it has when the binding is not a readable file', async () => {
        const old = await startDriver();
        const { supervised, file } = bound(old);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        mkdirSync(file);
        await new Promise((resolve) => setTimeout(resolve, 100));
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(old.reports).toHaveLength(1);
    });

    it('never runs a step the old holder hands over after the rebind', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        const marker = join(mkdtempSync(join(tmpdir(), 'marker-')), 'ran');
        dirs.push(join(marker, '..'));
        const { supervised, name, rebound } = bound(old);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        let release = () => {};
        old.hold = new Promise<void>((resolve) => (release = resolve));
        await new Promise((resolve) => setTimeout(resolve, 100));
        old.order(
            step('late-1', 'probe', ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`])
        );
        name(next, 2);
        await until('the rebind', rebound);
        release();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(existsSync(marker)).toBe(false);
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(old.answers.has('late-1')).toBe(false);
    });

    it('keeps the result of a call the old holder handed before the rebind in the ledger only', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        old.order(step('slow-1', 'probe', ['node', '-e', 'setTimeout(() => {}, 400)']));
        const { supervised, name, rebound } = bound(old);
        await until('the call to be running', () => {
            try {
                return supervised.ledger('slow-1').invocations['i-1']?.state === 'running';
            } catch {
                return false;
            }
        });
        name(next, 2);
        await until('the rebind', rebound);
        await until('the call to be done', () => supervised.ledger('slow-1').invocations['i-1']?.state === 'done');
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(old.answers.has('slow-1')).toBe(false);
        expect(next.answers.has('slow-1')).toBe(false);
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
    });

    it('delivers the report it already delivered again to the new holder, under the same id', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        old.autoFinish = false;
        const { supervised, name } = bound(old);
        supervised.agentExits(0);
        await until('the report at the old holder', () => old.reports.length === 1);
        name(next, 2);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(next.reports[0]!.id).toBe(old.reports[0]!.id);
    });

    it('keeps the report unacknowledged on its volume at a rebind: the new holder has not taken it', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        old.autoFinish = false;
        next.silent = true;
        const { supervised, name, rebound } = bound(old);
        supervised.agentExits(0);
        await until('the old holder to acknowledge', () => old.reports.length === 1 && supervised.kept().acknowledged);
        name(next, 2);
        await until('the rebind', rebound);
        expect(supervised.kept().acknowledged).toBe(false);
        next.silent = false;
        await supervised.done;
    });

    it('ignores the old holder answering 401 to a request in flight across the rebind', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        const { supervised, name, rebound } = bound(old);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        // A step pull of the old holder is in flight across the rebind and answers 401 after it.
        let release = () => {};
        old.hold = new Promise<void>((resolve) => (release = resolve));
        await until('a step pull held at the old holder', () => old.held > 0);
        name(next, 2);
        await until('the rebind', rebound);
        old.closed = true;
        release();
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(supervised.saw(MAILBOX_FILES.kill)).toBe(false);
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(supervised.report()).toMatchObject({ outcome: 'completed' });
        expect(next.reports).toHaveLength(1);
    });

    it('posts a question still pending to the new holder', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        const { supervised, name } = bound(old);
        supervised.agentAsks('q-1');
        await until('the question at the old holder', () => old.posted.length === 1);
        name(next, 2);
        await until('the question at the new holder', () => next.posted.length === 1);
        expect(next.posted[0]!.id).toBe('q-1');
        supervised.agentExits(0);
        await supervised.done;
    });

    it('follows no holder without a claim sequence of its own', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        const dir = mkdtempSync(join(tmpdir(), 'binding-'));
        dirs.push(dir);
        const file = join(dir, 'binding.json');
        writeFileSync(file, JSON.stringify({ claimSeq: 2, url: next.url, token: next.token }));
        const supervised = run(old, { SUPERVISOR_BINDING_FILE: file });
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        await new Promise((resolve) => setTimeout(resolve, 150));
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
        expect(next.calls).toBe(0);
    });

    it('restarts the orphan bound at a rebind, and keeps it against the new holder', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        old.autoFinish = false;
        const { supervised, name } = bound(old, { SUPERVISOR_ORPHAN_MS: '1000' });
        let finished = false;
        void supervised.done.then(() => (finished = true));
        supervised.agentExits(0);
        await until('the report at the old holder', () => old.reports.length === 1);
        old.silent = true;
        next.silent = true;
        await new Promise((resolve) => setTimeout(resolve, 500));
        name(next, 2);
        // Past the bound counted from the old holder's last word, inside the one counted from the rebind.
        await new Promise((resolve) => setTimeout(resolve, 700));
        expect(finished).toBe(false);
        await supervised.done;
    });

    it('notices a rebind within a second', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
        const { supervised, name } = bound(old);
        await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
        name(next, 2);
        await until('the new holder to be called', () => next.calls > 0, 1_000);
        supervised.agentExits(0);
        await supervised.done;
    });

    describe('waiting for a newer holder (#829 S3)', () => {
        const ORPHAN = { SUPERVISOR_ORPHAN_MS: '300' };
        const TAKEOVER = { ...ORPHAN, SUPERVISOR_TAKEOVER_MS: '3000' };
        const lag = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        it('lets a released group outlive the orphan bound after its agent ends, and follow a holder named within the takeover bound', async () => {
            const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
            old.autoFinish = false;
            const { supervised, name, rebound } = bound(old, TAKEOVER);
            await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
            old.silent = true;
            supervised.agentExits(0);
            let finished = false;
            void supervised.done.then(() => (finished = true));
            await lag(1000);
            expect(finished).toBe(false);
            expect(old.reports).toHaveLength(0);
            name(next, 2);
            await until('the rebind', rebound);
            expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
            expect(next.reports).toHaveLength(1);
            expect(old.reports).toHaveLength(0);
        });

        // Characterization: an unreleased group (no `go` ever ordered) keeps the short bound and is redone.
        it('keeps the orphan bound for a group never released: it exits lost and is redone', async () => {
            const old = await startDriver({ release: false });
            old.silent = true;
            const { supervised } = bound(old, TAKEOVER);
            expect(await supervised.done).toBe(SUPERVISOR_EXIT.lost);
            expect(supervised.saw(MAILBOX_FILES.go)).toBe(false);
        });

        it('finalizes at the takeover bound when no holder comes', async () => {
            const old = await startDriver();
            old.autoFinish = false;
            const { supervised } = bound(old, { ...ORPHAN, SUPERVISOR_TAKEOVER_MS: '1200' });
            await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
            old.silent = true;
            supervised.agentExits(0);
            const ended = Date.now();
            expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
            expect(Date.now() - ended).toBeGreaterThanOrEqual(1100);
            expect(supervised.report()).toMatchObject({ outcome: 'completed', agentExit: 0 });
        });

        // Characterization: without a binding file nothing can name a holder, so the short bound stands.
        it('keeps the orphan bound after the release when no binding file is configured', async () => {
            const old = await startDriver();
            old.autoFinish = false;
            const supervised = run(old, { ...TAKEOVER });
            await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
            old.silent = true;
            supervised.agentExits(0);
            const ended = Date.now();
            expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
            expect(Date.now() - ended).toBeLessThan(2000);
        });

        it('logs the release once, on the first go only', async () => {
            const old = await startDriver();
            const { supervised } = bound(old, TAKEOVER);
            await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
            old.order(ORDER_GO);
            await lag(200);
            supervised.agentExits(0);
            await supervised.done;
            expect(supervised.logs.filter((line) => line === 'supervisor: released the agent')).toHaveLength(1);
        });

        it('never logs a release for a refused go', async () => {
            const old = await startDriver({ release: false });
            old.stop = true;
            const supervised = run(old);
            await until('the stop', () => supervised.saw(MAILBOX_FILES.stop));
            old.order(ORDER_GO);
            await supervised.done;
            expect(supervised.logs).not.toContain('supervisor: released the agent');
        });

        it('never logs a release for an agentless group', async () => {
            const old = await startDriver({ release: false });
            const supervised = run(old, { SUPERVISOR_AGENTLESS: '1' });
            old.order(ORDER_FINISH);
            await supervised.done;
            expect(supervised.logs).not.toContain('supervisor: released the agent');
        });

        const SERVED = 'supervisor: stopped serving the steps';

        it('logs that it stopped serving the steps once, after the driver orders the end', async () => {
            const old = await startDriver();
            old.autoFinish = false;
            const { supervised } = bound(old, TAKEOVER);
            await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
            supervised.agentExits(0);
            await until('the report', () => old.reports.length === 1);
            await lag(200);
            expect(supervised.logs).not.toContain(SERVED);
            old.order(ORDER_FINISH);
            await supervised.done;
            expect(supervised.logs.filter((line) => line === SERVED)).toHaveLength(1);
        });

        it('logs that it stopped serving when the takeover bound passes with no holder', async () => {
            const old = await startDriver();
            old.autoFinish = false;
            const { supervised } = bound(old, { ...ORPHAN, SUPERVISOR_TAKEOVER_MS: '1200' });
            await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
            old.silent = true;
            supervised.agentExits(0);
            await lag(500);
            expect(supervised.logs).not.toContain(SERVED);
            await supervised.done;
            expect(supervised.logs.filter((line) => line === SERVED)).toHaveLength(1);
        });

        it('logs that it stopped serving before the departure report of a kill', async () => {
            const old = await startDriver();
            old.autoFinish = false;
            const { supervised } = bound(old, TAKEOVER);
            await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
            old.kill = true;
            await until('the kill order', () => supervised.saw(MAILBOX_FILES.kill));
            supervised.agentExits(143);
            await supervised.done;
            expect(supervised.logs.filter((line) => line === SERVED)).toHaveLength(1);
        });

        it('does not log it while the steps are served after the agent exits, or before the release', async () => {
            const old = await startDriver({ release: false });
            old.autoFinish = false;
            const { supervised } = bound(old, TAKEOVER);
            await lag(300);
            expect(supervised.logs).not.toContain(SERVED);
            old.order(ORDER_GO);
            await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
            supervised.agentExits(0);
            await until('the report', () => old.reports.length === 1);
            await lag(300);
            expect(supervised.logs).not.toContain(SERVED);
            old.order(ORDER_FINISH);
            await supervised.done;
        });

        it('replays a gate that landed while a second invocation of it waited in the lane: the request is posted once', async () => {
            const driver = await startDriver();
            const supervised = run(driver, GATED);
            const loop = fakeGateLoop(supervised.box.gate, () => ({ exitCode: 0, output: 'passed', holdMs: 400 }));
            driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
            await until('the gate to be taken', () => loop.seen.length === 1);
            driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000, invocation: 'i-2' }));
            await until('both answers', () => driver.answerBodies.length === 3);
            expect(loop.seen).toHaveLength(1);
            // The first body is the release's.
            const [first, second] = driver.answerBodies.slice(1).map((body) => JSON.parse(body) as StepAnswer);
            expect(first).toMatchObject({ invocation: 'i-1', exitCode: 0 });
            expect(second).toMatchObject({ invocation: 'i-2', exitCode: 0, stdout: 'passed', replayed: true });
            expect(supervised.ledger('gate-1').invocations['i-1']?.state).toBe('done');
            supervised.agentExits(0);
            await supervised.done;
        });

        // The first call's settle rewrites the ledger from its own entry: the waiting call's `running` record must survive.
        it('keeps the running record of a gate call that waited in the lane while it runs', async () => {
            const driver = await startDriver();
            const supervised = run(driver, GATED);
            let holds = 0;
            const loop = fakeGateLoop(supervised.box.gate, () => ({
                exitCode: 3,
                output: 'failing',
                holdMs: holds++ === 0 ? 300 : 3_000,
            }));
            driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
            await until('the gate to be taken', () => loop.seen.length === 1);
            driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000, invocation: 'i-2' }));
            await until('the second call to run the gate', () => loop.seen.length === 2);
            expect(supervised.ledger('gate-1').invocations['i-2']).toMatchObject({ state: 'running' });
            supervised.agentExits(0);
            await supervised.done;
        });

        // Characterization: a second invocation after a FAILED first call runs the gate again.
        it('runs the second invocation of a gate whose first call failed', async () => {
            const driver = await startDriver();
            const supervised = run(driver, GATED);
            const loop = fakeGateLoop(supervised.box.gate, () => ({ exitCode: 3, output: 'failing', holdMs: 300 }));
            driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000 }));
            await until('the gate to be taken', () => loop.seen.length === 1);
            driver.order(gateStep('gate-1', 'npm test', { timeoutMs: 60_000, invocation: 'i-2' }));
            await until('both answers', () => driver.answerBodies.length === 3);
            expect(loop.seen).toHaveLength(2);
            supervised.agentExits(0);
            await supervised.done;
        });

        // Characterization: a driver that hangs up (a departed old holder) gives no 401, so the agent is kept.
        it('keeps the agent when the old holder hangs up, and still follows the binding', async () => {
            const [old, next] = [await startDriver(), await startDriver({ token: NEWER_TOKEN })];
            old.autoFinish = false;
            const { supervised, name, rebound } = bound(old, TAKEOVER);
            await until('the agent to be released', () => supervised.saw(MAILBOX_FILES.go));
            old.silent = true;
            await lag(500);
            expect(supervised.saw(MAILBOX_FILES.kill)).toBe(false);
            name(next, 2);
            await until('the rebind', rebound);
            supervised.agentExits(0);
            expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
            expect(next.reports).toHaveLength(1);
        });
    });
});

interface Relayed {
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
}

/** One request to a relay socket; a hang-up (no answer at all) rejects, an answer of any status resolves. */
const viaSocket = (
    socketPath: string,
    method: string,
    url: string,
    {
        body,
        headers = {},
        onRequest,
    }: {
        body?: Buffer | string | undefined;
        headers?: Record<string, string>;
        onRequest?: (request: ClientRequest) => void;
    } = {}
): Promise<Relayed> =>
    new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                socketPath,
                method,
                path: url,
                headers:
                    body === undefined ? headers : { 'content-length': String(Buffer.byteLength(body)), ...headers },
            },
            (response) => {
                const parts: Buffer[] = [];
                response.on('data', (chunk: Buffer) => parts.push(chunk));
                response.on('error', reject);
                response.on('close', () =>
                    response.complete
                        ? resolve({
                              status: response.statusCode ?? 0,
                              headers: response.headers,
                              body: Buffer.concat(parts),
                          })
                        : reject(new Error('the answer was cut off'))
                );
            }
        );
        request.on('error', reject);
        // A refused oversize body (413) closes the socket while the body is still being written: the
        // late EPIPE lands on the socket after the answer settled this promise.
        request.on('socket', (socket) => socket.on('error', () => {}));
        onRequest?.(request);
        request.end(body);
    });

describe('the supervisor run: the agent and export relay (#829 S3c)', () => {
    const SEEN_LATER = 'tok-newer-agent-secret';
    const relayed = (driver: Driver | null, env: Record<string, string> = {}) =>
        run(driver, {
            SUPERVISOR_AGENT_TOKEN: AGENT_TOKEN,
            SUPERVISOR_EXPORT_TOKEN: EXPORT_TOKEN,
            SUPERVISOR_EXPORTS: '1',
            ...env,
        });
    const socketsOf = (supervised: ReturnType<typeof run>) => ({
        agent: join(supervised.agent.out, 'control.sock'),
        export: join(supervised.box.export, 'control.sock'),
    });
    const ready = async (supervised: ReturnType<typeof run>) => {
        await until('the relays', () => Object.values(socketsOf(supervised)).every((socket) => existsSync(socket)));
        return socketsOf(supervised);
    };
    const finish = async (supervised: ReturnType<typeof run>) => {
        supervised.exporterDone();
        supervised.agentExits(0);
        expect(await supervised.done).toBe(SUPERVISOR_EXIT.finalized);
    };
    const named = (driver: Driver, claimSeq: number, file: string) =>
        writeFileSync(
            file,
            bindingBody({
                claimSeq,
                url: driver.url,
                token: driver.token,
                agentToken: driver.agentToken,
                exportToken: driver.exportToken,
            })
        );
    /** A supervisor of claim 1 following a binding file. */
    const bound = (driver: Driver, env: Record<string, string> = {}) => {
        const dir = mkdtempSync(join(tmpdir(), 'binding-'));
        dirs.push(dir);
        const file = join(dir, 'binding.json');
        const supervised = relayed(driver, { SUPERVISOR_CLAIM_SEQ: '1', SUPERVISOR_BINDING_FILE: file, ...env });
        return {
            supervised,
            name: (next: Driver, claimSeq: number) => named(next, claimSeq, file),
            rebound: () => supervised.logs.some((line) => line.startsWith('supervisor: rebound to claim')),
        };
    };

    it.each([
        ['POST', '/publish', '{}'],
        ['POST', '/review', '{"profile":"a"}'],
        ['GET', '/review/key-1', undefined],
    ])('relays the agent route %s %s under the agent token, the answer unchanged', async (method, url, body) => {
        const driver = await startDriver();
        const supervised = relayed(driver);
        const { agent } = await ready(supervised);
        const answer = await viaSocket(agent, method, url, { body });
        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.body.toString())).toMatchObject({ echoed: url, bytes: Buffer.byteLength(body ?? '') });
        expect(driver.seen).toEqual([expect.objectContaining({ method, url, authorization: `Bearer ${AGENT_TOKEN}` })]);
        await finish(supervised);
        const text = [...supervised.logs, answer.body.toString()].join('\n');
        expect(text).not.toContain(AGENT_TOKEN);
        expect(text).not.toContain(EXPORT_TOKEN);
    });

    it('relays the export routes under the export token: a binary chunk past a MiB with its query, the manifest, the state', async () => {
        const driver = await startDriver();
        const supervised = relayed(driver);
        const { export: socket } = await ready(supervised);
        const chunk = Buffer.alloc(3 * 1024 * 1024 + 7, 0xff);
        const query = '/export/chunk?session=s%201&offset=1048576';
        const answer = await viaSocket(socket, 'PUT', query, { body: chunk });
        expect(JSON.parse(answer.body.toString())).toMatchObject({
            echoed: query,
            bytes: chunk.length,
            sha: createHash('sha256').update(chunk).digest('hex'),
        });
        expect((await viaSocket(socket, 'PUT', '/export/manifest', { body: '{"a":1}' })).status).toBe(200);
        expect((await viaSocket(socket, 'POST', '/export/state', { body: '{"b":2}' })).status).toBe(200);
        expect(driver.seen.map((entry) => entry.authorization)).toEqual(new Array(3).fill(`Bearer ${EXPORT_TOKEN}`));
        await finish(supervised);
    });

    it.each([
        ['agent', 'DELETE', '/publish'],
        ['agent', 'GET', '/publish'],
        ['agent', 'POST', '/question'],
        ['agent', 'GET', '/control'],
        ['agent', 'GET', '/step?wait=1'],
        ['agent', 'POST', '/report'],
        ['agent', 'GET', '/review/../control'],
        ['agent', 'PUT', '/export/chunk?session=s&offset=0'],
        ['agent', 'POST', '/review?x=1'],
        ['export', 'POST', '/publish'],
        ['export', 'GET', '/control'],
        ['export', 'GET', '/export/chunk?session=s&offset=0'],
        ['export', 'PUT', '/export/state'],
        ['export', 'PUT', '/export/chunk/../../control'],
        ['export', 'POST', '/report'],
    ] as const)(
        'refuses what the %s role may not call (%s %s) without reaching the driver',
        async (role, method, url) => {
            const driver = await startDriver();
            const supervised = relayed(driver);
            const sockets = await ready(supervised);
            const answer = await viaSocket(sockets[role], method, url, { body: method === 'GET' ? undefined : '{}' });
            expect(answer.status).toBe(404);
            expect(driver.seen).toEqual([]);
            await finish(supervised);
        }
    );

    it('serves each relay on a socket only its owner may use', async () => {
        const driver = await startDriver();
        const supervised = relayed(driver);
        const sockets = await ready(supervised);
        for (const socket of Object.values(sockets)) expect(statSync(socket).mode & 0o777).toBe(0o600);
        await finish(supervised);
    });

    it('serves no relay without the tokens (a reclaimed group), and no agent relay for an agentless one', async () => {
        const reclaim = await startDriver();
        const bare = run(reclaim, { SUPERVISOR_EXPORTS: '1' });
        await until('the agent to be released', () => bare.saw(MAILBOX_FILES.go));
        expect(Object.values(socketsOf(bare)).some((socket) => existsSync(socket))).toBe(false);
        bare.exporterDone();
        bare.agentExits(0);
        await bare.done;
        const agentless = relayed(await startDriver(), { SUPERVISOR_AGENTLESS: '1' });
        await until('the export relay', () => existsSync(socketsOf(agentless).export));
        expect(existsSync(socketsOf(agentless).agent)).toBe(false);
        agentless.exporterDone();
        await agentless.done;
    });

    it('serves no export relay for a run that exports nothing', async () => {
        const driver = await startDriver();
        const supervised = relayed(driver, { SUPERVISOR_EXPORTS: '0' });
        await until('the agent relay', () => existsSync(socketsOf(supervised).agent));
        expect(existsSync(socketsOf(supervised).export)).toBe(false);
        supervised.agentExits(0);
        await supervised.done;
    });

    it('relays to the new holder, under its tokens, after a rebind', async () => {
        const next = await startDriver({ token: 'tok-next', agentToken: SEEN_LATER, exportToken: 'tok-next-export' });
        const old = await startDriver();
        old.autoFinish = false;
        const { supervised, name, rebound } = bound(old);
        const sockets = await ready(supervised);
        await viaSocket(sockets.agent, 'POST', '/publish', { body: '{}' });
        name(next, 2);
        await until('the rebind', rebound);
        await viaSocket(sockets.agent, 'POST', '/publish', { body: '{}' });
        await viaSocket(sockets.export, 'POST', '/export/state', { body: '{}' });
        expect(old.seen).toHaveLength(1);
        expect(next.seen.map((entry) => entry.authorization)).toEqual([
            `Bearer ${SEEN_LATER}`,
            'Bearer tok-next-export',
        ]);
        await finish(supervised);
        expect(supervised.logs.join('\n')).not.toContain(SEEN_LATER);
    });

    it('hangs up on a request in flight across a rebind, never lets the late old answer through, and lands the retry on the new holder', async () => {
        const [old, next] = [await startDriver(), await startDriver({ token: 'tok-next' })];
        old.autoFinish = false;
        let release = () => {};
        const late = new Promise<void>((resolve) => (release = resolve));
        old.relayAnswer = async (response) => {
            await late;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{"from":"old"}');
        };
        const { supervised, name, rebound } = bound(old);
        const sockets = await ready(supervised);
        const inFlight = viaSocket(sockets.agent, 'POST', '/publish', { body: '{}' });
        const outcome = inFlight.then(
            (answer) => answer,
            (error: Error) => error
        );
        await until('the request to reach the old holder', () => old.seen.length === 1);
        name(next, 2);
        await until('the rebind', rebound);
        expect(await outcome).toBeInstanceOf(Error);
        release();
        expect((await viaSocket(sockets.agent, 'POST', '/publish', { body: '{}' })).body.toString()).toContain(
            '"echoed"'
        );
        expect(next.seen).toHaveLength(1);
        await finish(supervised);
    });

    describe('a holder that does not answer', () => {
        it.each([
            [
                'is gone',
                (driver: Driver) => {
                    driver.silent = true;
                },
            ],
            [
                'answers a head and dies mid-body',
                (driver: Driver) => {
                    driver.relayAnswer = (response) => {
                        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
                        response.write('{"half":');
                        setTimeout(() => response.socket?.destroy(), 20);
                    };
                },
            ],
            [
                'never answers (the relay timeout)',
                (driver: Driver) => {
                    driver.relayAnswer = () => new Promise<void>(() => {});
                },
            ],
        ])('hangs up on a holder that %s: no answer is made up, a 502 least of all', async (_what, silence) => {
            const driver = await startDriver();
            const supervised = relayed(driver, { SUPERVISOR_RELAY_TIMEOUT_MS: '300' });
            const sockets = await ready(supervised);
            silence(driver);
            for (const [socket, url] of [
                [sockets.agent, '/publish'],
                [sockets.export, '/export/state'],
            ] as [string, string][]) {
                await expect(viaSocket(socket, 'POST', url, { body: '{}' })).rejects.toBeInstanceOf(Error);
            }
            driver.silent = false;
            driver.relayAnswer = null;
            await finish(supervised);
        });
    });

    it('aborts the upstream request when the client hangs up', async () => {
        const driver = await startDriver();
        driver.relayAnswer = () => new Promise<void>(() => {});
        const supervised = relayed(driver);
        const sockets = await ready(supervised);
        let request: ClientRequest | undefined;
        const gone = viaSocket(sockets.agent, 'POST', '/publish', {
            body: '{}',
            onRequest: (r) => {
                request = r;
            },
        }).catch(() => 'hung up');
        await until('the request to reach the driver', () => driver.seen.length === 1);
        request?.destroy();
        expect(await gone).toBe('hung up');
        await until('the upstream request to close', () => driver.seen[0]?.closed === true);
        driver.relayAnswer = null;
        await finish(supervised);
    });

    it('answers 503 past the in-flight cap and 413 past a body cap, the driver untouched by the refused ones', async () => {
        const driver = await startDriver();
        driver.relayAnswer = () => new Promise<void>(() => {});
        const supervised = relayed(driver);
        const sockets = await ready(supervised);
        const requests = Array.from({ length: 2 }, () =>
            viaSocket(sockets.export, 'POST', '/export/state', { body: '{}' }).catch(() => 0)
        );
        await until('both export slots to be taken', () => driver.seen.length === 2);
        expect((await viaSocket(sockets.export, 'POST', '/export/state', { body: '{}' })).status).toBe(503);
        expect(driver.seen).toHaveLength(2);
        const over = await viaSocket(sockets.agent, 'POST', '/publish', { body: Buffer.alloc(1024 * 1024 + 1) });
        expect(over.status).toBe(413);
        const manifest = await viaSocket(sockets.export, 'PUT', '/export/manifest', { body: Buffer.alloc(4097) });
        expect([413, 503]).toContain(manifest.status);
        expect(driver.seen).toHaveLength(2);
        driver.relayAnswer = null;
        for (const server of servers) server.closeAllConnections();
        await Promise.all(requests);
        await finish(supervised);
    });

    it('does not count a relayed answer as the driver being there: the orphan bound still fires', async () => {
        const driver = await startDriver({ release: false });
        driver.silentControl = true;
        const supervised = relayed(driver, { SUPERVISOR_ORPHAN_MS: '400' });
        const { agent } = await ready(supervised);
        const until400 = Date.now() + 800;
        const outcome = Promise.race([
            supervised.done,
            new Promise<'still serving'>((r) => setTimeout(() => r('still serving'), 3_000)),
        ]);
        while (Date.now() < until400) {
            await viaSocket(agent, 'POST', '/publish', { body: '{}' }).catch(() => null);
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        expect(await outcome).toBe(SUPERVISOR_EXIT.lost);
    });

    it('closes the relays when the run ends', async () => {
        const driver = await startDriver();
        const supervised = relayed(driver);
        const sockets = await ready(supervised);
        await finish(supervised);
        for (const socket of Object.values(sockets)) {
            await expect(viaSocket(socket, 'POST', '/publish', { body: '{}' })).rejects.toMatchObject({
                code: expect.stringMatching(/ENOENT|ECONNREFUSED/),
            });
        }
    });
});
