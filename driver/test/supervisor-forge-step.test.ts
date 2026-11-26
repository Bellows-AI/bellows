import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { gateForgeScript } from '../src/container-scripts.js';
import {
    FORGE_STEP_ENV,
    GATE_TOKEN_PATH,
    MAILBOX_FILES,
    MAILBOXES,
    SUPERVISOR_ENV,
} from '../src/supervisor-contract.js';
import { bindingBody } from '../src/supervisor-plan.js';
import { liveSupervisors, stopSupervisors, superviseTracked } from './fixtures/supervisor-tracker.js';

/*
 * A supervised step that reaches a GitLab host (`StepRequest.forgeHost`): the real supervisor.cjs in-process opens
 * a mailbox in its own tmpdir for the step's lifetime, writes the forge helper into it, and relays the child's
 * `ask <host>` to a fake driver's `POST /gate-token`. The token never rides the step's env or the task volume, and
 * every token served is redacted from what the ledger keeps and the driver is answered.
 */
process.env.SUPERVISOR_NO_MAIN = '1';
const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
    supervise(env: Record<string, string>, log: (line: string) => void): Promise<number>;
};

const HANG_GUARD_MS = 25_000;
const CONTROL_TOKEN = 'control-secret';
const HOST = 'gitlab.example.com';
const RESERVED = ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'GH_TOKEN', 'GL_TOKEN', 'CI_JOB_TOKEN'];

interface StepAnswer {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    tokenAskUnanswered?: true;
}
type Mint = (n: number) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
    await stopSupervisors();
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => expect(liveSupervisors()).toBe(0));

const readBody = (request: IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
        let text = '';
        request.on('data', (chunk: Buffer) => (text += chunk.toString()));
        request.on('end', () => resolve(text));
    });

/** The driver's endpoint: hands out queued steps, records answers and token asks, and answers each ask with `mint`. */
async function startDriver(mint: Mint) {
    const waiting = new Map<string, { promise: Promise<StepAnswer>; resolve: (answer: StepAnswer) => void }>();
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
        handedOut: [] as string[],
        waiter,
        answerBodies: [] as string[],
        asks: [] as { step: string; host: string }[],
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
                if (next) {
                    driver.handedOut.push(JSON.stringify(next));
                    return send(200, { step: next });
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
                return send(200, {});
            }
            if (request.method === 'POST' && url.startsWith('/step/')) {
                const body = await readBody(request);
                driver.answerBodies.push(body);
                waiter(decodeURIComponent(url.slice('/step/'.length))).resolve(JSON.parse(body) as StepAnswer);
                return send(200, { ok: true });
            }
            if (request.method === 'POST' && url === '/report') {
                await readBody(request);
                return send(200, {});
            }
            if (request.method === 'POST' && url === GATE_TOKEN_PATH) {
                const body = JSON.parse(await readBody(request)) as { step: string; host: string };
                driver.asks.push(body);
                const answer = await mint(driver.asks.length);
                return send(answer.status, answer.body);
            }
            return send(404, {});
        })();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    driver.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return driver;
}

const minted =
    (lifeMs: number): Mint =>
    (n) => ({
        status: 200,
        body: { token: `glpat_mint_${n}`, expiresAt: new Date(Date.now() + lifeMs).toISOString() },
    });

/** A supervisor with no gate, serving the driver's steps over a task volume rooted in a scratch dir. */
function startSupervisor(driver: Awaited<ReturnType<typeof startDriver>>, env: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'forge-step-'));
    dirs.push(root);
    const logs: string[] = [];
    void superviseTracked(
        supervisor,
        {
            FACTORY_CTL_ROOT: root,
            SUPERVISOR_TICK_MS: '10',
            SUPERVISOR_CONTROL_MS: '10',
            SUPERVISOR_AGENTLESS: '1',
            SUPERVISOR_CONTROL_URL: driver.url,
            SUPERVISOR_CONTROL_TOKEN: CONTROL_TOKEN,
            [SUPERVISOR_ENV.forgeHelper]: gateForgeScript,
            ...env,
        },
        (line) => logs.push(line)
    );
    const order = (id: string, script: string, over: Record<string, unknown> = {}) =>
        driver.queue.push({
            id,
            invocation: 'i-1',
            kind: 'sync',
            argv: ['sh', '-c', script],
            cwd: root,
            env: {},
            timeoutMs: 20_000,
            forgeHost: HOST,
            ...over,
        });
    const answerOf = (id: string): Promise<StepAnswer> =>
        new Promise((resolve, reject) => {
            const guard = setTimeout(
                () => reject(new Error(`no answer for ${id}: ${logs.join(' | ')}`)),
                HANG_GUARD_MS
            );
            void driver.waiter(id).promise.then((answer) => {
                clearTimeout(guard);
                resolve(answer);
            });
        });
    const ledger = () => {
        const dir = join(root, MAILBOXES.supervisor.path.split('/').pop()!, MAILBOX_FILES.steps);
        return readdirSync(dir)
            .map((name) => readFileSync(join(dir, name), 'utf8'))
            .join('\n');
    };
    /** Every file's bytes under the task volume root, the ledger included. */
    const volume = () => {
        const texts: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const at = join(dir, name);
                if (statSync(at).isDirectory()) walk(at);
                else texts.push(readFileSync(at, 'utf8'));
            }
        };
        walk(root);
        return texts.join('\n');
    };
    return { root, order, answerOf, ledger, volume, logs };
}

/** The git credential protocol against the step's helper, as git runs a `credential.helper`. */
const fill = (host = HOST) =>
    `printf 'protocol=https\\nhost=${host}\\n\\n' | FACTORY_GATE_MODE=credential /bin/sh "$${FORGE_STEP_ENV.helper}" get`;

describe('a forge step asks for its token through a mailbox of its own', () => {
    it('answers git’s credential ask with the token, which rides neither the step nor its env', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        const reserved = RESERVED.map((name) => `"\${${name}:-}"`).join('');
        sup.order(
            'sync-1',
            `echo "box=$${FORGE_STEP_ENV.run} hosts=$${FORGE_STEP_ENV.hosts}"; [ -z ${reserved} ] && echo clean; ${fill()}`
        );
        const answer = await sup.answerOf('sync-1');
        expect(answer.exitCode).toBe(0);
        expect(answer.stdout).toContain('username=oauth2\npassword=[redacted]\n');
        expect(answer.stdout).toContain('clean\n');
        expect(answer.stdout).toContain(`hosts=${HOST}`);
        expect(driver.asks).toEqual([{ step: 'sync-1', host: HOST }]);
        expect(driver.handedOut.join('')).not.toContain('glpat_mint_');
        // The mailbox is the supervisor's own tmpdir, never the task volume, and gone with the step.
        const box = /box=(\S+)/.exec(answer.stdout)?.[1] ?? '';
        expect(box.startsWith(tmpdir())).toBe(true);
        expect(box.startsWith(sup.root)).toBe(false);
        expect(existsSync(box)).toBe(false);
    });

    it('redacts an echoed token from stdout and stderr, the answer, the ledger and the whole task volume', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order(
            'sync-1',
            `t=$(${fill()} | sed -n 's/^password=//p'); echo "out=$t"; echo "err=$t" >&2; echo "$t" > leaked.txt; exit 0`
        );
        const answer = await sup.answerOf('sync-1');
        expect(answer.stdout).toContain('out=[redacted]');
        expect(answer.stderr).toContain('err=[redacted]');
        expect(driver.answerBodies.join('')).not.toContain('glpat_mint_');
        expect(sup.ledger()).not.toContain('glpat_mint_');
        expect(sup.ledger()).toContain('[redacted]');
        // The step wrote the token into the tree itself; nothing the supervisor wrote holds one.
        expect(
            sup
                .volume()
                .split('\n')
                .filter((line) => line.includes('glpat_mint_'))
        ).toEqual(['glpat_mint_1']);
    });

    it('redacts every token a rotation served, not only the last', async () => {
        const driver = await startDriver(minted(-1));
        const sup = startSupervisor(driver);
        sup.order('sync-1', `${fill()}; ${fill()}`);
        const answer = await sup.answerOf('sync-1');
        expect(driver.asks).toHaveLength(2);
        expect(answer.stdout.match(/password=\[redacted\]/g)).toHaveLength(2);
        expect(driver.answerBodies.join('')).not.toMatch(/glpat_mint_[12]/);
        expect(sup.ledger()).not.toMatch(/glpat_mint_[12]/);
    });

    it('redacts a token from git-style error text', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order(
            'sync-1',
            `t=$(${fill()} | sed -n 's/^password=//p'); echo "fatal: unable to access 'https://oauth2:$t@${HOST}/group/app.git/': The requested URL returned error: 403" >&2; exit 128`
        );
        const answer = await sup.answerOf('sync-1');
        expect(answer.exitCode).toBe(128);
        expect(answer.stderr).toContain(`https://oauth2:[redacted]@${HOST}/`);
        expect(sup.ledger()).not.toContain('glpat_mint_');
    });

    it('answers a waited-on grant `none unanswered` past its budget, with no verdict', async () => {
        const driver = await startDriver(() => ({
            status: 503,
            body: { error: "the starter's forge grant is waited on", retryable: true, waiting: true },
        }));
        const sup = startSupervisor(driver, { SUPERVISOR_GATE_ASK_MS: '300' });
        sup.order('sync-1', `${fill()}; exit 0`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBe(true);
        expect(answer.exitCode).toBeNull();
        expect(answer.stderr).toContain('gate-forge: no token (unanswered)');
        expect(driver.asks.length).toBeGreaterThan(1);
        // The ledger keeps no exit as the call's: never a failure by exit status alone.
        const recorded = JSON.parse(sup.ledger()) as {
            effect: unknown;
            invocations: Record<string, { result: StepAnswer }>;
        };
        expect(recorded.effect).toBeNull();
        expect(recorded.invocations['i-1']?.result).toMatchObject({ exitCode: null, tokenAskUnanswered: true });
    });

    it('answers a refused ask `none refused`, and the step’s own exit stands', async () => {
        const driver = await startDriver(() => ({
            status: 409,
            body: { error: 'no running step may ask for that host' },
        }));
        const sup = startSupervisor(driver);
        sup.order('sync-1', `${fill()}; echo "status=$?"`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.exitCode).toBe(0);
        expect(answer.tokenAskUnanswered).toBeUndefined();
        expect(answer.stderr).toContain('gate-forge: no token (refused)');
        expect(answer.stdout).toContain('status=1');
    });

    it('never relays a foreign host’s ask to the driver, from the helper or a hand-written ask', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        const handWritten = `printf 'ask evil.example.com\\n' > "$${FORGE_STEP_ENV.run}/asks/.9.tmp" && mv "$${FORGE_STEP_ENV.run}/asks/.9.tmp" "$${FORGE_STEP_ENV.run}/asks/9"; i=0; while [ ! -f "$${FORGE_STEP_ENV.run}/answers/9" ] && [ $i -lt 200 ]; do sleep 0.02; i=$((i+1)); done; echo "answer=$(cat "$${FORGE_STEP_ENV.run}/answers/9")"`;
        sup.order('sync-1', `${fill('evil.example.com')}; ${fill('github.com')}; ${handWritten}`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.stdout).not.toContain('password=');
        expect(answer.stdout).toContain('answer=none refused');
        expect(driver.asks).toEqual([]);
    });

    it('refuses a forge step with a malformed host, or with no helper to write, before it runs', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order('sync-1', 'echo ran', { forgeHost: 'Evil Host/../x' });
        const malformed = await sup.answerOf('sync-1');
        expect(malformed.exitCode).toBe(126);
        expect(malformed.stdout).toBe('');
        const bare = await startDriver(minted(3_600_000));
        const helperless = startSupervisor(bare, { [SUPERVISOR_ENV.forgeHelper]: '' });
        helperless.order('sync-2', 'echo ran');
        const refused = await helperless.answerOf('sync-2');
        expect(refused.exitCode).toBe(126);
        expect(refused.stdout).toBe('');
        expect(refused.stderr).toMatch(/forge helper/);
    });

    it('answers nothing stale to an ask a rebind overtook', async () => {
        let release: () => void = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        const old = await startDriver(async (n) => {
            await held;
            return minted(3_600_000)(n);
        });
        const next = await startDriver(minted(3_600_000));
        const bindingDir = mkdtempSync(join(tmpdir(), 'forge-binding-'));
        dirs.push(bindingDir);
        const bindingFile = join(bindingDir, 'binding.json');
        const sup = startSupervisor(old, { SUPERVISOR_CLAIM_SEQ: '1', SUPERVISOR_BINDING_FILE: bindingFile });
        sup.order('sync-1', `FACTORY_GATE_ASK_SECONDS=1 ${fill()}; exit 0`);
        while (old.asks.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
        writeFileSync(
            bindingFile,
            bindingBody({
                claimSeq: 2,
                url: next.url,
                token: 'control-2',
                agentToken: 'agent-2',
                exportToken: 'export-2',
                leaseToken: 'lease-2',
            })
        );
        while (!sup.logs.some((line) => line.startsWith('supervisor: rebound to claim 2'))) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        release();
        // The old holder never gets the answer: the result stays in the ledger for the new holder.
        let recorded = '';
        while (!/"state":"done"/.test(recorded)) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            try {
                recorded = sup.ledger();
            } catch {
                // No ledger yet.
            }
        }
        expect(recorded).not.toContain('glpat_mint_');
        expect(recorded).not.toMatch(/password=(?!\[redacted\])/);
        expect(JSON.parse(recorded).invocations['i-1'].result.tokenAskUnanswered).toBe(true);
    });
});

describe('a step with no forge host', () => {
    it('passes its output through unchanged, with no mailbox', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order('probe-1', `echo "box=[$\{${FORGE_STEP_ENV.helper}:-}]"; echo plain >&2`, {
            kind: 'probe',
            forgeHost: undefined,
        });
        const answer = await sup.answerOf('probe-1');
        expect(answer.stdout).toBe('box=[]\n');
        expect(answer.stderr).toBe('plain\n');
    });

    it('redacts a token its own env carried from its output', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order('publish-1', 'echo "t=$GITLAB_TOKEN $GITHUB_TOKEN"', {
            kind: 'publish',
            forgeHost: undefined,
            env: { GITLAB_TOKEN: 'glpat_env_value', GITHUB_TOKEN: 'ghs_env_value' },
        });
        const answer = await sup.answerOf('publish-1');
        expect(answer.stdout).toBe('t=[redacted] [redacted]\n');
        expect(sup.ledger()).not.toMatch(/glpat_env_value|ghs_env_value/);
    });
});
