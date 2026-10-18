import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT, readRepoFile as read } from './fixtures/repo-files.js';

/*
 * The lane stub executor images (scripts/test-jobs.sh, scripts/test-k8s.sh) only build where a
 * docker daemon lives, so these pins are the bytes that keep them on the task supervisor's agent
 * contract (driver/src/supervisor-contract.ts): node-owned mailbox mount points baked into the
 * image, and every executor stub started through scripts/stub-agent.sh, which beats the heartbeat,
 * honors a kill order and writes agent.exit — the real entrypoints' half of the contract.
 */

const MAILBOX = 'mkdir -p /factory/in /factory/out /factory/export /factory/supervisor && chown -R node:node /factory';
const COPY = 'COPY ctl-agent.cjs stub-agent.sh /usr/local/bin/\n';
// Issue #814: the driver starts every agent container as root, so every stub drops to node behind
// the tool broker, the executor images' own launcher.
const ENTRY = 'ENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh",';
const STAGE =
    'cp docker/claude-executor/ctl-agent.cjs docker/claude-executor/factory-launch.sh docker/claude-executor/factory-tool.cjs \\\n' +
    '    docker/claude-executor/tool-bash.sh scripts/stub-agent.sh scripts/stub-runner.Dockerfile "$work/"';
const BASE = read('scripts/stub-runner.Dockerfile');

/** The one printf line that writes `target`. */
const dockerfile = (script: string, target: string): string => {
    const lines = script.split('\n').filter((l) => l.includes(`>${target}`));
    expect(lines).toHaveLength(1);
    return lines[0] ?? '';
};

describe('the lane stub executor images', () => {
    it('stand on one base that bakes the mailbox, the agent helpers and the tool isolation, and ends as node', () => {
        for (const needle of [
            COPY,
            MAILBOX,
            'chmod 0700 /factory/in /factory/out',
            'COPY factory-launch.sh /usr/local/bin/factory-launch\n',
            'COPY factory-tool.cjs /usr/local/lib/factory-tool/factory-tool.cjs\n',
            'COPY tool-bash.sh /usr/local/libexec/factory-tool/bash\n',
            'adduser -D -u 1001 -G node -h /home/factory-tool -s /bin/bash factory-tool',
            'addgroup -g 1002 factory-agent && addgroup node factory-agent',
            'chmod 2750 /run/factory-tool',
            'ln -s /bin/setpriv /usr/bin/setpriv',
        ]) {
            expect(BASE, needle).toContain(needle);
        }
        expect(BASE.trimEnd().endsWith('USER node')).toBe(true);
    });

    it('test-jobs: every executor stub builds on that base and starts through factory-launch and stub-agent.sh', () => {
        const script = read('scripts/test-jobs.sh');
        expect(script).toContain(STAGE);
        expect(script).toContain('-f "$work/stub-runner.Dockerfile"');
        expect(script.indexOf(STAGE)).toBeLessThan(script.indexOf('-f "$work/stub-runner.Dockerfile"'));
        for (const target of [
            '"$work/Dockerfile.ok"',
            '"$work/Dockerfile.fail"',
            '"$work/run/Dockerfile"',
            '"$work/kill/Dockerfile"',
        ]) {
            expect(dockerfile(script, target)).toContain(ENTRY);
        }
        // The service stub is no agent: no supervisor watches it.
        expect(dockerfile(script, '"$work/svc/Dockerfile"')).not.toContain('stub-agent.sh');
    });

    it('test-k8s: the stub builds on that base and starts through factory-launch and stub-agent.sh', () => {
        const script = read('scripts/test-k8s.sh');
        expect(script).toContain(STAGE);
        const line = dockerfile(script, '"$work/stub.Dockerfile"');
        expect(line).toContain(`${ENTRY}"sh","/stub.sh"]`);
        expect(script.indexOf(STAGE)).toBeLessThan(script.indexOf('-f "$work/stub-runner.Dockerfile"'));
        expect(script.indexOf('-f "$work/stub-runner.Dockerfile"')).toBeLessThan(
            script.indexOf('-f "$work/stub.Dockerfile"')
        );
    });
});

// Every spawn leads its own process group and is group-killed after its case, so a wrapper, its
// ctl-agent and its command never outlive the case. The ctl-agent is always the wrapper's child, so
// the only pid it can signal is that wrapper.
const spawned: ReturnType<typeof spawn>[] = [];
const dirs: string[] = [];
afterEach(() => {
    for (const child of spawned.splice(0)) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
        try {
            process.kill(-child.pid, 'SIGKILL');
        } catch {
            // The whole group already ended.
        }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CASE_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 5000;
const POLL_MS = 20;

/** A temp copy of the wrapper beside ctl-agent.cjs, as the images lay them out, plus a mailbox. */
const sandbox = () => {
    const root = mkdtempSync(join(tmpdir(), 'lane-stub-'));
    dirs.push(root);
    const bin = join(root, 'bin');
    const inDir = join(root, 'in');
    const outDir = join(root, 'out');
    for (const dir of [bin, inDir, outDir]) mkdirSync(dir);
    copyFileSync(join(ROOT, 'scripts/stub-agent.sh'), join(bin, 'stub-agent.sh'));
    copyFileSync(join(ROOT, 'docker/claude-executor/ctl-agent.cjs'), join(bin, 'ctl-agent.cjs'));
    return { wrapper: join(bin, 'stub-agent.sh'), inDir, outDir };
};

const run = (wrapper: string, args: string[], env: Record<string, string>) => {
    const child = spawn('/bin/sh', [wrapper, ...args], {
        env: { PATH: process.env.PATH ?? '', FACTORY_CTL_TICK_MS: '20', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
    });
    spawned.push(child);
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
    });
    const exited = new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('stub-agent.sh did not exit')), EXIT_TIMEOUT_MS);
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
    return { exited, stdout: () => stdout };
};

const whenFileExists = (path: string): Promise<void> =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + EXIT_TIMEOUT_MS;
        const poll = () => {
            if (existsSync(path)) return resolve();
            if (Date.now() > deadline) return reject(new Error(`${path} never appeared`));
            setTimeout(poll, POLL_MS);
        };
        poll();
    });

describe('scripts/stub-agent.sh, run locally under /bin/sh', () => {
    it(
        "passes the command's output through and writes and re-raises its exit status",
        async () => {
            const box = sandbox();
            const child = run(box.wrapper, ['sh', '-c', 'echo stub-said; exit 3'], {
                FACTORY_CTL_IN: box.inDir,
                FACTORY_CTL_OUT: box.outDir,
            });
            expect(await child.exited).toBe(3);
            expect(child.stdout()).toBe('stub-said\n');
            expect(readFileSync(join(box.outDir, 'agent.exit'), 'utf8')).toBe('3\n');
            expect(existsSync(join(box.outDir, 'agent.exit.tmp'))).toBe(false);
        },
        CASE_TIMEOUT_MS
    );

    it(
        'beats agent.alive and ends the command on a kill order',
        async () => {
            const box = sandbox();
            const started = Date.now();
            const child = run(box.wrapper, ['sleep', '30'], { FACTORY_CTL_IN: box.inDir, FACTORY_CTL_OUT: box.outDir });
            await whenFileExists(join(box.outDir, 'agent.alive'));
            writeFileSync(join(box.inDir, 'kill'), '');
            expect(await child.exited).toBe(143);
            expect(Date.now() - started).toBeLessThan(EXIT_TIMEOUT_MS);
            expect(readFileSync(join(box.outDir, 'agent.exit'), 'utf8')).toBe('143\n');
        },
        CASE_TIMEOUT_MS
    );

    // Issue #771's release: the agent starts only once the supervisor writes `go`, as the real
    // entrypoints do, and a Stop or kill order that lands first means it never starts.
    it(
        'starts the command only once the supervisor writes go',
        async () => {
            const box = sandbox();
            const ran = join(box.outDir, 'ran');
            const go = join(box.inDir, 'go');
            const child = run(box.wrapper, ['sh', '-c', `: > "${ran}"; exit 4`], {
                FACTORY_CTL_IN: box.inDir,
                FACTORY_CTL_OUT: box.outDir,
                FACTORY_CTL_GO: go,
            });
            await new Promise((resolve) => setTimeout(resolve, 600));
            expect(existsSync(ran)).toBe(false);
            writeFileSync(go, '');
            expect(await child.exited).toBe(4);
            expect(existsSync(ran)).toBe(true);
        },
        CASE_TIMEOUT_MS
    );

    it(
        'leaves quietly, running nothing, when a stop lands before go',
        async () => {
            const box = sandbox();
            const ran = join(box.outDir, 'ran');
            const child = run(box.wrapper, ['sh', '-c', `: > "${ran}"`], {
                FACTORY_CTL_IN: box.inDir,
                FACTORY_CTL_OUT: box.outDir,
                FACTORY_CTL_GO: join(box.inDir, 'go'),
            });
            writeFileSync(join(box.inDir, 'stop'), '');
            expect(await child.exited).toBe(0);
            expect(existsSync(ran)).toBe(false);
        },
        CASE_TIMEOUT_MS
    );

    it(
        'runs the command with no mailbox at all and writes nothing',
        async () => {
            const box = sandbox();
            const child = run(box.wrapper, ['sh', '-c', 'echo bare; exit 5'], {});
            expect(await child.exited).toBe(5);
            expect(child.stdout()).toBe('bare\n');
            expect(existsSync(join(box.outDir, 'agent.exit'))).toBe(false);
        },
        CASE_TIMEOUT_MS
    );
});
