import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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
const requireCjs = createRequire(import.meta.url);
const supervisor = requireCjs('../src/scripts/supervisor.cjs') as {
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
    vi.restoreAllMocks();
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

describe('a mailbox read that cannot be confirmed is no withdrawn ask', () => {
    /** The supervisor's own `fs`, failing every read of an ask file (`<mailbox>/asks/<pid>`) with `code`. */
    const failAskReads = (code: string) => {
        const fs = requireCjs('node:fs') as typeof import('node:fs');
        const real = fs.readFileSync;
        return vi.spyOn(fs, 'readFileSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
            if (typeof file === 'string' && /\/asks\/\d+$/.test(file)) {
                throw Object.assign(new Error(`${code}: injected`), { code });
            }
            return (real as (...args: unknown[]) => unknown)(file, ...rest);
        }) as typeof fs.readFileSync);
    };

    it.each(['EIO', 'EACCES'])(
        'a %s reading the ask ends the step as a credential wait, never a verdict',
        async (code) => {
            const driver = await startDriver(minted(3_600_000));
            const sup = startSupervisor(driver);
            failAskReads(code);
            sup.order('sync-1', `export FACTORY_GATE_ASK_SECONDS=1; ${fill()}; exit 0`);
            const answer = await sup.answerOf('sync-1');
            expect(answer.tokenAskUnanswered).toBe(true);
            expect(answer.exitCode).toBeNull();
            expect(driver.asks).toEqual([]);
            expect(sup.logs.join('\n')).toContain(code);
        }
    );

    it.each(['EIO', 'EACCES'])('a %s listing the asks ends the step as a credential wait', async (code) => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        const fs = requireCjs('node:fs') as typeof import('node:fs');
        const real = fs.readdirSync;
        vi.spyOn(fs, 'readdirSync').mockImplementation(((dir: unknown, ...rest: unknown[]) => {
            if (typeof dir === 'string' && dir.endsWith('/asks')) throw Object.assign(new Error('injected'), { code });
            return (real as (...args: unknown[]) => unknown)(dir, ...rest);
        }) as typeof fs.readdirSync);
        sup.order('sync-1', `export FACTORY_GATE_ASK_SECONDS=1; ${fill()}; exit 0`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBe(true);
        expect(driver.asks).toEqual([]);
    });

    it('a fault that clears is answered, and the step is no credential wait', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        const spy = failAskReads('EIO');
        sup.order('sync-1', `export FACTORY_GATE_ASK_SECONDS=10; ${fill()}; exit 0`);
        while (!sup.logs.some((line) => line.includes('EIO'))) await new Promise((resolve) => setTimeout(resolve, 10));
        spy.mockRestore();
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBeUndefined();
        expect(answer.exitCode).toBe(0);
        expect(answer.stdout).toContain('password=[redacted]');
    });

    it('an ask that vanishes unanswered (ENOENT) is one the helper gave up on: a credential wait, nothing asked of the driver', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        failAskReads('ENOENT');
        sup.order('sync-1', `export FACTORY_GATE_ASK_SECONDS=1; ${fill()}; echo "status=$?"; exit 0`);
        const answer = await sup.answerOf('sync-1');
        expect(driver.asks).toEqual([]);
        expect(answer.stdout).toContain('status=1');
        expect(answer.tokenAskUnanswered).toBe(true);
    });
});

describe('mailbox I/O whose outcome is unconfirmed ends the step as a credential wait', () => {
    type Fs = typeof import('node:fs');
    const nodeFs = () => requireCjs('node:fs') as Fs;
    const faultOf = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

    /**
     * Fails the supervisor's own `fs[method]` with `code` for each call whose first argument matches `where`, as many
     * times as `times` says (always when absent); every other call is the real one.
     */
    function fail(
        method: 'writeFileSync' | 'renameSync' | 'rmSync' | 'mkdtempSync',
        where: RegExp,
        code: string,
        times = Infinity
    ) {
        const fs = nodeFs();
        const real = fs[method] as (...args: unknown[]) => unknown;
        let left = times;
        return vi.spyOn(fs, method as 'rmSync').mockImplementation(((file: unknown, ...rest: unknown[]) => {
            if (typeof file === 'string' && where.test(file) && left > 0) {
                left -= 1;
                throw faultOf(code);
            }
            return real(file, ...rest);
        }) as never);
    }

    const ASK_ONE_SECOND = 'export FACTORY_GATE_ASK_SECONDS=1;';
    /** The step's own staged, then renamed, ask: what the helper writes, spelled out so a script can vary the content. */
    const handAsk = (content: string) => `printf '${content}' > "$${FORGE_STEP_ENV.run}/asks/9"; sleep 0.6; echo done`;

    describe.each(['EIO', 'EACCES', 'ENOSPC'])('a %s', (code) => {
        it('writing the answer leaves the ask unresolved: no token reaches the step, and it is a credential wait', async () => {
            const driver = await startDriver(minted(3_600_000));
            const sup = startSupervisor(driver);
            fail('writeFileSync', /\/answers\/\d+\.tmp$/, code);
            sup.order('sync-1', `${ASK_ONE_SECOND} ${fill()}; exit 0`);
            const answer = await sup.answerOf('sync-1');
            expect(answer.tokenAskUnanswered).toBe(true);
            expect(answer.exitCode).toBeNull();
            expect(answer.stderr).not.toContain('refused');
        });

        it('renaming the answer into place leaves the ask unresolved, and a credential wait', async () => {
            const driver = await startDriver(minted(3_600_000));
            const sup = startSupervisor(driver);
            fail('renameSync', /\/answers\/\d+\.tmp$/, code);
            sup.order('sync-1', `${ASK_ONE_SECOND} ${fill()}; exit 0`);
            const answer = await sup.answerOf('sync-1');
            expect(answer.tokenAskUnanswered).toBe(true);
            expect(answer.exitCode).toBeNull();
        });

        it('opening the mailbox is no refusal of the step: it never ran, and it is a credential wait', async () => {
            const driver = await startDriver(minted(3_600_000));
            const sup = startSupervisor(driver);
            fail('mkdtempSync', /factory-forge-/, code);
            sup.order('sync-1', 'echo ran');
            const answer = await sup.answerOf('sync-1');
            expect(answer.tokenAskUnanswered).toBe(true);
            expect(answer.exitCode).toBeNull();
            expect(answer.stdout).toBe('');
        });
    });

    it('a write fault that clears is retried: the token is delivered and the step is no credential wait', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        fail('writeFileSync', /\/answers\/\d+\.tmp$/, 'EIO', 3);
        sup.order('sync-1', `export FACTORY_GATE_ASK_SECONDS=10; ${fill()}; exit 0`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBeUndefined();
        expect(answer.exitCode).toBe(0);
        expect(answer.stdout).toContain('password=[redacted]');
    });

    it('a mailbox whose existence cannot be confirmed still gets its answer', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        const fs = nodeFs();
        const real = fs.existsSync;
        vi.spyOn(fs, 'existsSync').mockImplementation((file) =>
            typeof file === 'string' && /factory-forge-[^/]+$/.test(file) ? false : real(file)
        );
        sup.order('sync-1', `${ASK_ONE_SECOND} ${fill()}; exit 0`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBeUndefined();
        expect(answer.stdout).toContain('password=[redacted]');
    });

    it('a token the step never took (its read of the answer failed) is a credential wait, not a failed step', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        const run = `"$${FORGE_STEP_ENV.run}"`;
        sup.order(
            'sync-1',
            `printf 'ask ${HOST}\n' > ${run}/asks/.9.tmp && mv ${run}/asks/.9.tmp ${run}/asks/9; i=0; while [ ! -f ${run}/answers/9 ] && [ $i -lt 100 ]; do sleep 0.02; i=$((i+1)); done; sleep 0.2; exit 1`
        );
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBe(true);
        expect(answer.exitCode).toBeNull();
        expect(driver.asks).toHaveLength(1);
    });

    it('a token the step took is no wait: the answer was consumed', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order('sync-1', `${fill()}; exit 3`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBeUndefined();
        expect(answer.exitCode).toBe(3);
    });

    it.each([
        ['an empty file', ''],
        ['a malformed one', 'garbage\\n'],
        ['one naming no host', 'ask \\n'],
        ['one with trailing text', 'ask gitlab.example.com extra\\n'],
    ])(
        '%s in the asks directory is no request: the ask stays unresolved, never `none refused`',
        async (_name, content) => {
            const driver = await startDriver(minted(3_600_000));
            const sup = startSupervisor(driver);
            sup.order('sync-1', handAsk(content));
            const answer = await sup.answerOf('sync-1');
            expect(answer.tokenAskUnanswered).toBe(true);
            expect(answer.exitCode).toBeNull();
            expect(driver.asks).toEqual([]);
        }
    );

    it.each([
        ['a foreign host', 'ask evil.example.com\\n'],
        ['a host that is no host name', 'ask Evil_Host/../x\\n'],
    ])('a whole request for %s is a confirmed refusal, and no credential wait', async (_name, content) => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        const run = `"$${FORGE_STEP_ENV.run}"`;
        sup.order(
            'sync-1',
            `printf '${content}' > ${run}/asks/.9.tmp && mv ${run}/asks/.9.tmp ${run}/asks/9; i=0; while [ ! -f ${run}/answers/9 ] && [ $i -lt 200 ]; do sleep 0.02; i=$((i+1)); done; echo "answer=$(cat ${run}/answers/9)"; rm -f ${run}/answers/9 ${run}/asks/9`
        );
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBeUndefined();
        expect(answer.stdout).toContain('answer=none refused');
        expect(driver.asks).toEqual([]);
    });

    it('a stray name in the asks directory is left alone and is evidence: the real ask is still answered, and the step ends as a wait', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order('sync-1', `: > "$${FORGE_STEP_ENV.run}/asks/junk"; ${fill()}; exit 0`);
        const answer = await sup.answerOf('sync-1');
        expect(driver.asks).toHaveLength(1);
        expect(answer.tokenAskUnanswered).toBe(true);
        expect(answer.exitCode).toBeNull();
    });

    it('a mailbox that cannot be removed when the step ends is no failure of the step', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        fail('rmSync', /factory-forge-[^/]+$/, 'EIO', 1);
        sup.order('sync-1', `${fill()}; exit 0`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.exitCode).toBe(0);
        expect(answer.tokenAskUnanswered).toBeUndefined();
    });
});

describe('a helper that cannot get its ask written reports the transport fault', () => {
    const WRITE = `printf 'ask %s\\n' "$1"`;
    const RENAME = '/bin/mv -f "$box/asks/.$me.tmp"';
    /** The shipped helper with one step of its ask replaced by a failing command: only that I/O is faulted. */
    const faulted = (step: string) => {
        const script = gateForgeScript.replace(step, step === WRITE ? 'false' : '/bin/false');
        expect(script).not.toBe(gateForgeScript);
        return script;
    };
    /** The same fault with storage that refuses every new file: any allocation in the fault path fails too. */
    const starved = (step: string) =>
        faulted(step)
            .replaceAll('/bin/mkdir', '/bin/false')
            .replaceAll('/bin/mv', '/bin/false')
            .replaceAll('/bin/touch', '/bin/false');
    const FAULTS = [
        ['write', WRITE],
        ['rename', RENAME],
    ] as const;
    const run = `"$${FORGE_STEP_ENV.run}"`;

    it.each(FAULTS)(
        'a failed ask %s is a credential wait, never git’s auth failure as the verdict',
        async (_name, step) => {
            const driver = await startDriver(minted(3_600_000));
            const sup = startSupervisor(driver, { [SUPERVISOR_ENV.forgeHelper]: faulted(step) });
            sup.order('sync-1', `${fill()}; exit 128`);
            const answer = await sup.answerOf('sync-1');
            expect(answer.tokenAskUnanswered).toBe(true);
            expect(answer.exitCode).toBeNull();
            expect(driver.asks).toEqual([]);
        }
    );

    it.each(FAULTS)(
        'a storage fault that refuses the ask %s and every new file is still a wait: the signal allocates nothing',
        async (_name, step) => {
            const driver = await startDriver(minted(3_600_000));
            const sup = startSupervisor(driver, { [SUPERVISOR_ENV.forgeHelper]: starved(step) });
            sup.order('sync-1', `${fill()}; exit 128`);
            const answer = await sup.answerOf('sync-1');
            expect(answer.tokenAskUnanswered).toBe(true);
            expect(answer.exitCode).toBeNull();
        }
    );

    it('the helper’s fault branch creates nothing: it only removes the pre-made slot', () => {
        const from = gateForgeScript.indexOf('; then', gateForgeScript.indexOf('if ! {'));
        const branch = gateForgeScript
            .slice(from, gateForgeScript.indexOf("reason='could not write the ask'"))
            .replace(/^\s*#.*$/gm, '')
            .replaceAll('2>/dev/null', '');
        expect(branch).toContain('/bin/rm -f "$box/faults/armed"');
        expect(branch).not.toMatch(/mkdir|touch|mktemp|ln |printf|>|\bmv\b|cp /);
    });

    it.each(FAULTS)(
        'a failed ask %s whose fault slot cannot be removed either (a read-only mailbox) is a wait',
        async (_name, step) => {
            const driver = await startDriver(minted(3_600_000));
            const readOnly = faulted(step).replace('/bin/rm -f "$box/faults/armed"', '/bin/false "$box/faults/armed"');
            expect(readOnly).not.toBe(faulted(step));
            const sup = startSupervisor(driver, { [SUPERVISOR_ENV.forgeHelper]: readOnly });
            sup.order('sync-1', `${fill()}; exit 128`);
            const answer = await sup.answerOf('sync-1');
            expect(answer.tokenAskUnanswered).toBe(true);
            expect(answer.exitCode).toBeNull();
        }
    );

    it('an ask the supervisor never saw, its helper having timed out across the supervisor’s stall, is a wait', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver, { SUPERVISOR_TICK_MS: '4000' });
        sup.order('sync-1', `export FACTORY_GATE_ASK_SECONDS=1; ${fill()}; exit 128`);
        const answer = await sup.answerOf('sync-1');
        expect(driver.asks).toEqual([]);
        expect(answer.tokenAskUnanswered).toBe(true);
        expect(answer.exitCode).toBeNull();
    });

    it('a real EACCES on the asks directory is the same wait', async () => {
        if (process.getuid?.() === 0) return; // root writes through a read-only directory
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order('sync-1', `chmod 555 ${run}/asks; ${fill()}; status=$?; chmod 755 ${run}/asks; exit $status`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBe(true);
        expect(answer.exitCode).toBeNull();
    });

    it('a step that forges the marker gets a rerun at most: its pass is never recorded', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order('sync-1', `rm ${run}/faults/armed; exit 0`);
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBe(true);
        expect(answer.exitCode).toBeNull();
    });

    it('a step that fails with no marker keeps its own verdict', async () => {
        const driver = await startDriver(minted(3_600_000));
        const sup = startSupervisor(driver);
        sup.order('sync-1', 'exit 9');
        const answer = await sup.answerOf('sync-1');
        expect(answer.tokenAskUnanswered).toBeUndefined();
        expect(answer.exitCode).toBe(9);
    });
});
