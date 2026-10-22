import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readRepoFile } from './fixtures/repo-files.js';

/*
 * The real executor entrypoints, run under /bin/sh against fake helpers (issue #829): a helper
 * TERMed in its fork-to-exec window runs the shell's handler and swallows the signal, and a bare
 * `wait` on it held PID 1, and the run, forever. Here ctl-agent swallows its FIRST TERM; the
 * entrypoint must still exit with the CLI's status and write agent.exit within a few seconds.
 * The entrypoints name their helpers by absolute /usr/local/bin path, so each test copies the
 * script and rewrites that prefix: the product carries no override that exists only for tests.
 */
const CLI_STATUS = 6;
// The guard ends a TERM-swallowing helper in about 3 s; the unguarded entrypoint never exits, so the
// margin is for a saturated host, not for the guard.
const EXIT_WITHIN_MS = 20_000;
const CASE_TIMEOUT_MS = 45_000;
const EXECUTABLE_MODE = 0o755;

/** A node helper that idles until killed, and answers the one-shot flags the entrypoints call it with. */
const IDLE_HELPER = `
if (process.argv.some((a) => ['--once', '--prior', '--has-session'].includes(a))) process.exit(0);
setInterval(() => {}, 1000);
`;

/** ctl-agent: records every TERM, swallows the first, and tells the CLI it is up. */
const SWALLOWING_CTL_AGENT = `
const fs = require('node:fs');
const path = require('node:path');
let terms = 0;
process.on('SIGTERM', () => {
    fs.appendFileSync(path.join(process.env.FACTORY_CTL_OUT, 'ctl-terms'), 'term\\n');
    if (++terms > 1) process.exit(143);
});
fs.writeFileSync(path.join(process.env.FACTORY_CTL_OUT, 'ctl-ready'), '');
setInterval(() => {}, 1000);
`;

/** The CLI (or its bridge): waits for ctl-agent to be up, then exits with the status under test. */
const CLI = `
const fs = require('node:fs');
const path = require('node:path');
const ready = path.join(process.env.FACTORY_CTL_OUT, 'ctl-ready');
const timer = setInterval(() => {
    if (!fs.existsSync(ready)) return;
    clearInterval(timer);
    process.exit(${CLI_STATUS});
}, 50);
`;

const roots: string[] = [];
const spawned: ChildProcess[] = [];
const sockets: { close: () => void }[] = [];

afterEach(() => {
    for (const child of spawned.splice(0)) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        try {
            process.kill(-child.pid!, 'SIGKILL');
        } catch {
            // already gone
        }
    }
    for (const socket of sockets.splice(0)) socket.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const write = (path: string, body: string, mode?: number): void => {
    writeFileSync(path, body);
    if (mode !== undefined) chmodSync(path, mode);
};

const stage = async (image: 'claude' | 'opencode') => {
    const root = mkdtempSync(join(tmpdir(), `entrypoint-race-${image}-`));
    roots.push(root);
    const bin = join(root, 'bin');
    const entry = join(root, 'entry');
    const outDir = join(root, 'out');
    for (const dir of [bin, entry, outDir, join(root, 'in'), join(root, 'work')]) mkdirSync(dir);
    const script = readRepoFile(`docker/${image}-executor/entrypoint.sh`);
    expect(script).toContain('/usr/local/bin/');
    write(join(entry, 'entrypoint.sh'), script.replaceAll('/usr/local/bin/', `${bin}/`), EXECUTABLE_MODE);
    for (const helper of ['branch-reporter', 'control-proxy', 'rate-limit-watch']) {
        write(join(bin, `${helper}.cjs`), IDLE_HELPER);
    }
    write(join(bin, 'ctl-agent.cjs'), SWALLOWING_CTL_AGENT);
    write(join(entry, 'github-credential.cjs'), 'process.exit(0);\n');
    if (image === 'claude') {
        write(join(entry, 'claude-bridge.cjs'), CLI);
        write(join(entry, 'claude-progress.cjs'), IDLE_HELPER);
    } else {
        write(join(entry, 'branch-reporter.cjs'), IDLE_HELPER);
        write(join(bin, 'opencode'), `#!/bin/sh\nexec node ${join(root, 'cli.cjs')}\n`, EXECUTABLE_MODE);
        write(join(root, 'cli.cjs'), CLI);
    }
    // The relay socket the supervisor would serve: its presence is what starts the control proxy.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(join(outDir, 'control.sock'), resolve));
    sockets.push({ close: () => server.close() });
    const env: NodeJS.ProcessEnv = {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        CLAUDE_CONFIG_DIR: root,
        XDG_DATA_HOME: join(root, 'data'),
        WORKDIR: join(root, 'work'),
        FACTORY_CTL_IN: join(root, 'in'),
        FACTORY_CTL_OUT: outDir,
        TMPDIR: root,
    };
    write(join(root, 'settings.json'), '{}\n');
    return { root, entry: join(entry, 'entrypoint.sh'), outDir, env };
};

const exitOf = (child: ChildProcess, ms: number): Promise<number | null> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the entrypoint did not exit within ${ms} ms`)), ms);
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });

describe('the executor entrypoints with a helper that swallows its first TERM (issue #829)', () => {
    it.each(['claude', 'opencode'] as const)(
        '%s exits with the CLI status and writes agent.exit within seconds',
        async (image) => {
            const box = await stage(image);
            const started = Date.now();
            const child = spawn('/bin/sh', [box.entry, '-p', 'run'], { env: box.env, stdio: 'ignore', detached: true });
            spawned.push(child);
            expect(await exitOf(child, EXIT_WITHIN_MS)).toBe(CLI_STATUS);
            expect(Date.now() - started).toBeLessThan(EXIT_WITHIN_MS);
            expect(readFileSync(join(box.outDir, 'agent.exit'), 'utf8')).toBe(`${CLI_STATUS}\n`);
            // The swallowed TERM was sent again: the guard is what ended the helper.
            expect(
                readFileSync(join(box.outDir, 'ctl-terms'), 'utf8').trim().split('\n').length
            ).toBeGreaterThanOrEqual(2);
            expect(existsSync(join(box.outDir, 'agent.exit.tmp'))).toBe(false);
        },
        CASE_TIMEOUT_MS
    );
});
