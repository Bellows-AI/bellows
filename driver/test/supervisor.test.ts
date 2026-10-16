import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoFile as read } from './fixtures/repo-files.js';
import { MAILBOX_FILES, MAILBOXES, SUPERVISOR_EXIT } from '../src/supervisor-contract.js';

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

interface Driver {
    url: string;
    stop: boolean;
    kill: boolean;
    posted: { id: string; body: unknown }[];
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        let text = '';
        request.on('data', (chunk: Buffer) => (text += chunk.toString()));
        request.on('end', () => resolve(text));
    });

/** The driver's run-control endpoint as the supervisor sees it: `/control`, and the question routes. */
async function startDriver(): Promise<Driver> {
    const driver: Driver = { url: '', stop: false, kill: false, posted: [] };
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
            const send = (status: number, body: unknown) => {
                response.writeHead(status, { 'content-type': 'application/json' });
                response.end(JSON.stringify(body));
            };
            if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, {});
            if (request.method === 'GET' && request.url === '/control') {
                return send(200, { stop: driver.stop, kill: driver.kill });
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
    };
}

describe('the supervisor run: agent exit with the supervisor alive', () => {
    it('stays alive after the agent exits, finalizes once the exporter has drained, then reports', async () => {
        const driver = await startDriver();
        const supervised = run(driver, { SUPERVISOR_EXPORTS: '1' });
        await until('the supervisor to start', () => supervised.saw(MAILBOX_FILES.supervisorAlive));

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
        driver.stop = true;
        const supervised = run(driver);
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
        await until('the supervisor to start', () => supervised.saw(MAILBOX_FILES.supervisorAlive));

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
        supervised.agentExits(143);
        await supervised.done;
        expect(supervised.report()).toMatchObject({ outcome: 'cancelled', cause: 'control_closed' });
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
