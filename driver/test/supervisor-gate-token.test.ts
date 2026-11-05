import { spawn } from 'node:child_process';
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
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { gateGithubScript, gateShellScript } from '../src/container-scripts.js';
import { GATE_FILES, GATE_TOKEN_PATH, MAILBOX_FILES, MAILBOXES } from '../src/supervisor-contract.js';
import { liveSupervisors, stopSupervisors, superviseTracked } from './fixtures/supervisor-tracker.js';

/*
 * The whole path of a gate's GitHub token ask (BEL-258): the real supervisor.cjs in-process, a fake
 * driver that mints a token per `POST /gate-token`, and the gate container's loop PLAYED in JS (the
 * real one ends every process of its user): it installs the real helper at `<gate>/bin/gh` and runs
 * each request under the real gate shell. A fake `gh` records the `GH_TOKEN` it was handed.
 */
process.env.SUPERVISOR_NO_MAIN = '1';
const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
    supervise(env: Record<string, string>, log: (line: string) => void): Promise<number>;
};

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
afterEach(async () => {
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterEach(stopSupervisors);
afterAll(() => expect(liveSupervisors()).toBe(0));

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        let text = '';
        request.on('data', (chunk: Buffer) => (text += chunk.toString()));
        request.on('end', () => resolve(text));
    });

/** The driver's run-control endpoint, and a `/gate-token` that mints `ghs_mint_<n>` expiring after `lifeMs`, or never answers. */
async function startDriver({ lifeMs, silentMint = false }: { lifeMs: number; silentMint?: boolean }) {
    const driver = {
        url: '',
        queue: [] as unknown[],
        answers: new Map<string, StepAnswer>(),
        answerBodies: [] as string[],
        asks: [] as { step: string; authorization: string }[],
    };
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
                if (next) return send(200, { step: next });
                await new Promise((resolve) => setTimeout(resolve, 20));
                return send(200, {});
            }
            if (request.method === 'POST' && url.startsWith('/step/')) {
                const body = await readBody(request);
                driver.answerBodies.push(body);
                driver.answers.set(decodeURIComponent(url.slice('/step/'.length)), JSON.parse(body) as StepAnswer);
                return send(200, { ok: true });
            }
            if (request.method === 'POST' && url === '/report') {
                await readBody(request);
                return send(200, {});
            }
            if (request.method === 'POST' && url === GATE_TOKEN_PATH) {
                const body = JSON.parse(await readBody(request)) as { step: string };
                driver.asks.push({ step: body.step, authorization: request.headers.authorization ?? '' });
                if (silentMint) return; // never answered: the connection hangs until the supervisor gives up
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
function startGate(driver: Awaited<ReturnType<typeof startDriver>>, env: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'gate-token-'));
    dirs.push(root);
    const box = Object.fromEntries(
        Object.entries(MAILBOXES).map(([name, mailbox]) => [name, join(root, mailbox.path.split('/').pop()!)])
    ) as Record<keyof typeof MAILBOXES, string>;
    for (const path of Object.values(box)) mkdirSync(path, { recursive: true });
    const gate = box.gate;
    const bin = join(gate, 'bin');
    const fakeReal = join(root, 'real-bin');
    const record = join(root, 'gh-record');
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeReal, { recursive: true });
    // The image's own `gh`: records the token it was handed, and prints it so a leak would show in the output.
    writeFileSync(
        join(fakeReal, 'gh'),
        `#!/bin/sh\nprintf '%s\\n' "$GH_TOKEN" >> '${record}'\nprintf 'gh-sees=%s\\n' "$GH_TOKEN"\n`
    );
    chmodSync(join(fakeReal, 'gh'), 0o755);
    writeFileSync(join(bin, 'gh'), gateGithubScript);
    chmodSync(join(bin, 'gh'), 0o700);
    for (const sub of [GATE_FILES.requests, GATE_FILES.running, GATE_FILES.done])
        mkdirSync(join(gate, sub), { recursive: true });

    const serve = (id: string) => {
        const running = join(gate, GATE_FILES.running, id);
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
            env: {
                PATH: `${bin}:${fakeReal}:${process.env.PATH}`,
                HOME: root,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_TERMINAL_PROMPT: '0',
                ...requestEnv,
                FACTORY_GATE_RUN: running,
                FACTORY_GATE_BIN: bin,
                ...env,
            },
        });
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
        child.on('close', (code) => {
            writeFileSync(join(running, GATE_FILES.output), output);
            writeFileSync(join(running, 'exit.tmp'), `${code ?? 137}\n`);
            renameSync(join(running, 'exit.tmp'), join(running, GATE_FILES.exit));
            renameSync(running, join(gate, GATE_FILES.done, id));
        });
    };
    timers.push(
        setInterval(() => {
            writeFileSync(join(gate, GATE_FILES.alive), '');
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
        (line) => logs.push(line)
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
    const answerOf = async (id: string): Promise<StepAnswer> => {
        const deadline = Date.now() + 15_000;
        while (!driver.answers.has(id)) {
            if (Date.now() > deadline) throw new Error(`no answer for ${id}: ${logs.join(' | ')}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return driver.answers.get(id)!;
    };
    const recorded = () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : []);
    const ledger = () => {
        const dir = join(box.supervisor, MAILBOX_FILES.steps);
        return readdirSync(dir)
            .map((name) => readFileSync(join(dir, name), 'utf8'))
            .join('\n');
    };
    return { order, answerOf, recorded, ledger, done, logs };
}

const GITHUB_FILL = "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill";

describe('a gate asks for its GitHub token through its mailbox', () => {
    it('renews every gh call past the token’s expiry', async () => {
        const driver = await startDriver({ lifeMs: 1_000 });
        const gate = startGate(driver);
        gate.order('gate-1', 'gh; sleep 1.2; gh');
        const answer = await gate.answerOf('gate-1');
        expect(answer.exitCode).toBe(0);
        expect(gate.recorded()).toEqual(['ghs_mint_1', 'ghs_mint_2']);
        expect(driver.asks.map((ask) => ask.step)).toEqual(['gate-1', 'gate-1']);
        expect(driver.asks[0]?.authorization).toBe(`Bearer ${CONTROL_TOKEN}`);
    });

    it('answers git’s credential fill with a fresh token', async () => {
        const driver = await startDriver({ lifeMs: 1_000 });
        const gate = startGate(driver);
        gate.order('gate-1', `${GITHUB_FILL}; sleep 1.2; ${GITHUB_FILL}`);
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
        const driver = await startDriver({ lifeMs: 1_000 });
        const gate = startGate(driver);
        gate.order('gate-1', 'gh; sleep 1.2; gh');
        const answer = await gate.answerOf('gate-1');
        expect(answer.stdout).toContain('gh-sees=[redacted]');
        expect(driver.answerBodies.join('')).not.toContain('ghs_mint_');
        expect(gate.ledger()).not.toContain('ghs_mint_');
    });

    it('gives the run no verdict when an ask goes unanswered', async () => {
        const driver = await startDriver({ lifeMs: 1_000, silentMint: true });
        const gate = startGate(driver, { SUPERVISOR_GATE_ASK_MS: '300', FACTORY_GATE_ASK_SECONDS: '2' });
        gate.order('gate-1', 'gh; exit 0');
        const answer = await gate.answerOf('gate-1');
        expect(answer.exitCode).toBeNull();
        expect(answer.tokenAskUnanswered).toBe(true);
        expect(gate.recorded()).toEqual([]);
    });

    it('answers a non-github host nothing', async () => {
        const driver = await startDriver({ lifeMs: 1_000 });
        const gate = startGate(driver);
        gate.order('gate-1', "printf 'protocol=https\\nhost=example.com\\n\\n' | git credential fill; exit 0");
        const answer = await gate.answerOf('gate-1');
        expect(answer.stdout).not.toContain('password=');
        expect(driver.asks).toEqual([]);
    });
});
