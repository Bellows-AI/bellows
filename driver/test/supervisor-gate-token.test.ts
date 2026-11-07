import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { gateGithubScript, gateShellScript } from '../src/container-scripts.js';
import { GATE_FILES, GATE_TOKEN_PATH, MAILBOX_FILES, MAILBOXES } from '../src/supervisor-contract.js';
import { liveSupervisors, stopSupervisors, superviseTracked } from './fixtures/supervisor-tracker.js';

/*
 * The whole path of a gate's GitHub token ask (BEL-258): the real supervisor.cjs in-process, a fake
 * driver that mints a token per `POST /gate-token`, and the gate container's loop PLAYED in JS (the
 * real one ends every process of its user): it puts the real helper first on the PATH (`FACTORY_GATE_BIN`) and runs
 * each request under the real gate shell. A fake `gh` records the `GH_TOKEN` it was handed.
 */
process.env.SUPERVISOR_NO_MAIN = '1';
const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
    supervise(env: Record<string, string>, log: (line: string) => void): Promise<number>;
};

const HANG_GUARD_MS = 25_000;
const CONTROL_TOKEN = 'control-secret';
const WORKTREE = '/workspaces/org/44444444-4444-4444-8444-444444444444/.worktrees/55555555-5555-4555-8555-555555555555';

interface StepAnswer {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    tokenAskUnanswered?: true;
}
interface Minted {
    token: string;
    expiresAt: string;
}

const servers: Server[] = [];
const dirs: string[] = [];
const timers: NodeJS.Timeout[] = [];
// A gate child is gone once `close` fires: its pipes are shut, so nothing of it writes under a dir this
// file removes. Killing is only the request; the teardown awaits the close before any dir goes.
const closes: Promise<void>[] = [];
const gates: ChildProcess[] = [];
let tearingDown = false;
afterEach(async () => {
    tearingDown = true;
    try {
        await teardown();
    } finally {
        tearingDown = false;
    }
});
async function teardown() {
    for (const timer of timers.splice(0)) clearInterval(timer);
    await stopSupervisors();
    for (const gate of gates.splice(0)) {
        try {
            if (gate.pid !== undefined) process.kill(-gate.pid, 'SIGKILL');
        } catch {
            // already gone with its group
        }
    }
    await Promise.all(closes.splice(0));
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
afterAll(() => expect(liveSupervisors()).toBe(0));

/*
 * The helper and the image's `gh` are written and executed once per file, not per case: the first exec of a
 * freshly written script is the slow step under load (seconds, against 13 ms for the second), and every case
 * paid it before its gate could ask. Each case still has its own record file, handed over as GH_RECORD.
 */
let shared = { root: '', bin: '', fakeReal: '' };
beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'gate-token-stubs-'));
    shared = { root, bin: join(root, 'bin'), fakeReal: join(root, 'real-bin') };
    mkdirSync(shared.bin);
    mkdirSync(shared.fakeReal);
    // The image's own `gh`: records the token it was handed, and prints it so a leak would show in the output.
    writeFileSync(
        join(shared.fakeReal, 'gh'),
        `#!/bin/sh\nprintf '%s\\n' "$GH_TOKEN" >> "$GH_RECORD"\nprintf 'gh-sees=%s\\n' "$GH_TOKEN"\n`
    );
    chmodSync(join(shared.fakeReal, 'gh'), 0o755);
    writeFileSync(join(shared.bin, 'gh'), gateGithubScript);
    chmodSync(join(shared.bin, 'gh'), 0o700);
    // Paid here, under the hook's own bound, instead of inside the first case.
    const warm = { env: { ...process.env, GH_RECORD: '/dev/null' }, stdio: 'ignore' } as const;
    execFileSync(join(shared.fakeReal, 'gh'), warm);
    spawnSync(join(shared.bin, 'gh'), warm); // refuses with no mailbox: the exec is the point
});
afterAll(() => rmSync(shared.root, { recursive: true, force: true }));

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        let text = '';
        request.on('data', (chunk: Buffer) => (text += chunk.toString()));
        request.on('end', () => resolve(text));
    });

/**
 * The driver's run-control endpoint, and a `/gate-token` that mints `ghs_mint_<n>` expiring after `lifeMs` (a
 * negative one is expired when granted: the next call must renew), or, given `unconfirmedMint`, runs it and
 * answers 503: an ask the driver did not confirm.
 */
async function startDriver({ lifeMs, unconfirmedMint }: { lifeMs: number; unconfirmedMint?: () => void }) {
    const waiting = new Map<string, { promise: Promise<StepAnswer>; resolve: (answer: StepAnswer) => void }>();
    /** The answer of a step as an event: resolved by the POST /step/<id> handler, whenever it comes. */
    const waiter = (id: string) => {
        let entry = waiting.get(id);
        if (!entry) {
            let resolve!: (answer: StepAnswer) => void;
            const promise = new Promise<StepAnswer>((done) => (resolve = done));
            entry = { promise, resolve };
            waiting.set(id, entry);
        }
        return entry;
    };
    const driver = {
        url: '',
        queue: [] as unknown[],
        waiter,
        answerBodies: [] as string[],
        asks: [] as { step: string; authorization: string }[],
        timeline: [] as string[],
    };
    const mark = (event: string) => driver.timeline.push(`${Math.round(performance.now())}ms ${event}`);
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        void (async () => {
            const send = (status: number, body: unknown) => {
                response.writeHead(status, { 'content-type': 'application/json' });
                response.end(JSON.stringify(body));
            };
            const url = request.url ?? '';
            if (request.method === 'GET' && url === '/control') return send(200, { stop: false, kill: false });
            if (request.method === 'GET' && url.startsWith('/step?')) {
                const next = driver.queue.shift();
                if (next) {
                    mark('GET /step hands the step out');
                    return send(200, { step: next });
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
                return send(200, {});
            }
            if (request.method === 'POST' && url.startsWith('/step/')) {
                const body = await readBody(request);
                mark('POST /step answered');
                driver.answerBodies.push(body);
                const id = decodeURIComponent(url.slice('/step/'.length));
                const answer = JSON.parse(body) as StepAnswer;
                waiter(id).resolve(answer);
                return send(200, { ok: true });
            }
            if (request.method === 'POST' && url === '/report') {
                await readBody(request);
                return send(200, {});
            }
            if (request.method === 'POST' && url === GATE_TOKEN_PATH) {
                const body = JSON.parse(await readBody(request)) as { step: string };
                mark('POST /gate-token received');
                driver.asks.push({ step: body.step, authorization: request.headers.authorization ?? '' });
                if (unconfirmedMint) {
                    unconfirmedMint();
                    return send(503, {});
                }
                const minted: Minted = {
                    token: `ghs_mint_${driver.asks.length}`,
                    expiresAt: new Date(Date.now() + lifeMs).toISOString(),
                };
                return send(200, minted);
            }
            return send(404, {});
        })();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    driver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return driver;
}

/** A gate wired as the kubernetes sidecar and the docker container wire it, and a supervisor serving it. */
function startGate(
    driver: Awaited<ReturnType<typeof startDriver>>,
    env: Record<string, string> = {},
    now?: () => number
) {
    const root = mkdtempSync(join(tmpdir(), 'gate-token-'));
    dirs.push(root);
    const box = Object.fromEntries(
        Object.entries(MAILBOXES).map(([name, mailbox]) => [name, join(root, mailbox.path.split('/').pop()!)])
    ) as Record<keyof typeof MAILBOXES, string>;
    for (const path of Object.values(box)) mkdirSync(path, { recursive: true });
    const gate = box.gate;
    const { bin, fakeReal } = shared;
    const record = join(root, 'gh-record');
    for (const sub of [GATE_FILES.requests, GATE_FILES.running, GATE_FILES.done])
        mkdirSync(join(gate, sub), { recursive: true });

    const serve = (id: string) => {
        const running = join(gate, GATE_FILES.running, id);
        driver.timeline.push(`${Math.round(performance.now())}ms gate loop serve() starts`);
        const file = (name: string) => readFileSync(join(running, name), 'utf8');
        const requestEnv = Object.fromEntries(
            file(GATE_FILES.env)
                .split('\n')
                .filter(Boolean)
                .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
        );
        rmSync(join(running, GATE_FILES.env));
        const child = spawn('sh', ['-c', gateShellScript, 'gate', file(GATE_FILES.command)], {
            cwd: root,
            detached: true,
            env: {
                PATH: `${bin}:${fakeReal}:${process.env.PATH}`,
                HOME: root,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_TERMINAL_PROMPT: '0',
                GH_RECORD: record,
                ...requestEnv,
                FACTORY_GATE_RUN: running,
                FACTORY_GATE_BIN: bin,
                ...env,
            },
        });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
        gates.push(child);
        closes.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
        child.on('close', (code) => {
            driver.timeline.push(`${Math.round(performance.now())}ms gate child closed (${code})`);
            // A teardown kills the child and removes the dirs after this: there is nobody left to answer.
            if (tearingDown) return;
            writeFileSync(join(running, GATE_FILES.output), output);
            writeFileSync(join(running, 'exit.tmp'), `${code ?? 137}\n`);
            renameSync(join(running, 'exit.tmp'), join(running, GATE_FILES.exit));
            renameSync(running, join(gate, GATE_FILES.done, id));
        });
    };
    const seen = new Set<string>();
    timers.push(
        setInterval(() => {
            writeFileSync(join(gate, GATE_FILES.alive), '');
            for (const kind of ['asks', 'answers']) {
                for (const running of readdirSync(join(gate, GATE_FILES.running))) {
                    let names: string[] = [];
                    try {
                        names = readdirSync(join(gate, GATE_FILES.running, running, kind)).filter(
                            (n) => !n.startsWith('.')
                        );
                    } catch {
                        // the request moved to done under the read
                    }
                    for (const n of names) {
                        const key = `${kind}/${n}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            driver.timeline.push(`${Math.round(performance.now())}ms ${kind} file ${n} appears`);
                        }
                    }
                }
            }
            for (const id of readdirSync(join(gate, GATE_FILES.requests))) {
                renameSync(join(gate, GATE_FILES.requests, id), join(gate, GATE_FILES.running, id));
                serve(id);
            }
        }, 10)
    );
    const logs: string[] = [];
    const done = superviseTracked(
        supervisor,
        {
            FACTORY_CTL_ROOT: root,
            SUPERVISOR_TICK_MS: '10',
            SUPERVISOR_CONTROL_MS: '10',
            SUPERVISOR_AGENTLESS: '1',
            SUPERVISOR_GATE: '1',
            SUPERVISOR_CONTROL_URL: driver.url,
            SUPERVISOR_CONTROL_TOKEN: CONTROL_TOKEN,
            ...env,
        },
        (line) => logs.push(line),
        now ? { now } : {}
    );
    const order = (id: string, command: string) =>
        driver.queue.push({
            id,
            invocation: 'i-1',
            kind: 'gate',
            argv: [command],
            cwd: WORKTREE,
            env: {},
            timeoutMs: 20_000,
        });
    // The answer is the POST /step/<id> event. The guard only turns a hang into a failure that carries the
    // timeline: it sits under vitest's own bound and no case reaches it unless something is stuck.
    const answerOf = (id: string): Promise<StepAnswer> =>
        new Promise((resolve, reject) => {
            const guard = setTimeout(
                () => reject(new Error(`no answer for ${id}: ${logs.join(' | ')}\n${driver.timeline.join('\n')}`)),
                HANG_GUARD_MS
            );
            void driver.waiter(id).promise.then((answer) => {
                clearTimeout(guard);
                resolve(answer);
            });
        });
    const recorded = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : []);
    const ledger = () => {
        const dir = join(box.supervisor, MAILBOX_FILES.steps);
        return readdirSync(dir)
            .map((name) => readFileSync(join(dir, name), 'utf8'))
            .join('\n');
    };
    return { order, answerOf, recorded, ledger, done, logs };
}

/** A token granted already past its expiry: the next call must renew it, with no waiting for the clock. */
const EXPIRED = -1;
/** The supervisor's per-ask budget in this file; its clock is moved past it, never waited out. */
const ASK_BUDGET_MS = 300;
const GITHUB_FILL = "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill";

describe('a gate asks for its GitHub token through its mailbox', () => {
    it('renews every gh call past the token’s expiry', async () => {
        const driver = await startDriver({ lifeMs: EXPIRED });
        const gate = startGate(driver);
        gate.order('gate-1', 'gh; gh');
        const answer = await gate.answerOf('gate-1');
        expect(answer.exitCode).toBe(0);
        expect(gate.recorded()).toEqual(['ghs_mint_1', 'ghs_mint_2']);
        expect(driver.asks.map((ask) => ask.step)).toEqual(['gate-1', 'gate-1']);
        expect(driver.asks[0]?.authorization).toBe(`Bearer ${CONTROL_TOKEN}`);
    });

    it('answers git’s credential fill with a fresh token', async () => {
        const driver = await startDriver({ lifeMs: EXPIRED });
        const gate = startGate(driver);
        gate.order('gate-1', `${GITHUB_FILL}; ${GITHUB_FILL}`);
        const answer = await gate.answerOf('gate-1');
        expect(answer.exitCode).toBe(0);
        const passwords = [...answer.stdout.matchAll(/^password=(.*)$/gm)].map((match) => match[1]);
        // Redacted in the answer, so the order of the fresh tokens is the driver's count of asks.
        expect(passwords).toEqual(['[redacted]', '[redacted]']);
        expect(driver.asks).toHaveLength(2);
        expect(answer.stdout).toContain('username=x-access-token');
    });

    it('serves from cache while the token is not near expiry', async () => {
        const driver = await startDriver({ lifeMs: 3_600_000 });
        const gate = startGate(driver);
        gate.order('gate-1', 'gh; gh');
        await gate.answerOf('gate-1');
        expect(gate.recorded()).toEqual(['ghs_mint_1', 'ghs_mint_1']);
        expect(driver.asks).toHaveLength(1);
    });

    it('redacts every token it handed out from the gate output and the ledger', async () => {
        const driver = await startDriver({ lifeMs: EXPIRED });
        const gate = startGate(driver);
        gate.order('gate-1', 'gh; gh');
        const answer = await gate.answerOf('gate-1');
        expect(answer.stdout).toContain('gh-sees=[redacted]');
        expect(driver.answerBodies.join('')).not.toContain('ghs_mint_');
        expect(gate.ledger()).not.toContain('ghs_mint_');
    });

    it('gives the run no verdict when an ask goes unanswered', async () => {
        // The supervisor's clock is frozen; the driver moves it just past the ask's budget (300 ms), far below the
        // step's own 20 s deadline, so only the ask-budget expiry can end the ask.
        const clock = { at: Date.now() };
        const driver = await startDriver({
            lifeMs: EXPIRED,
            unconfirmedMint: () => (clock.at += ASK_BUDGET_MS + 1),
        });
        const gate = startGate(driver, { SUPERVISOR_GATE_ASK_MS: String(ASK_BUDGET_MS) }, () => clock.at);
        gate.order('gate-1', 'gh; exit 0');
        const answer = await gate.answerOf('gate-1');
        expect(answer.exitCode).toBeNull();
        expect(answer.tokenAskUnanswered).toBe(true);
        // The helper was told `none unanswered` by the supervisor (its own wait is 60 s, never reached).
        expect(`${answer.stdout}${answer.stderr}`).toContain('no GitHub token (unanswered)');
        expect(gate.recorded()).toEqual([]);
    });

    it('answers a non-github host nothing', async () => {
        const driver = await startDriver({ lifeMs: EXPIRED });
        const gate = startGate(driver);
        gate.order('gate-1', "printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill; exit 0");
        const answer = await gate.answerOf('gate-1');
        expect(answer.stdout).not.toContain('password=');
        expect(driver.asks).toEqual([]);
    });
});
