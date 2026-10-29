import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT, readRepoFile as read } from './fixtures/repo-files.js';

/*
 * The runner's half of the cooperative Stop (issue #442): the mailbox agent turns what the task
 * supervisor wrote into the agent's read-only directory into a marker file, and the agent-side
 * mechanism — Claude Code's PostToolUse hook, OpenCode's plugin — reads only that marker. The agent
 * holds no control credential at all. The real binaries are the `test:jobs` lane's business
 * (scripts/test-jobs.sh); what is pinned here is every file the images ship.
 */
const path = (rel: string): string => join(ROOT, rel);

const CLAUDE_AGENT = 'docker/claude-executor/ctl-agent.cjs';
const OPENCODE_AGENT = 'docker/opencode-executor/ctl-agent.cjs';
const CLAUDE_HOOK = 'docker/claude-executor/stop-hook.cjs';
const OPENCODE_PLUGIN = 'docker/opencode-executor/stop-plugin/index.js';

const STOP_PROMPT = [
    'You decide whether an autonomous coding agent may stop. Hook input: $ARGUMENTS',
    'The person who started the task cannot reply to plain text; this run ends when the agent stops.',
    'If stop_hook_active is true, respond {"ok": true}.',
    'If last_assistant_message asks the person to choose between options, confirm something, or answer a question before the work can continue, respond {"ok": false, "reason": "The person cannot reply to plain text and this run ends when you stop. Call the AskUserQuestion tool now with the question and its options."}.',
    'Otherwise respond {"ok": true}.',
].join('\n');

const dirs: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
    // Each child leads its own process group, so the group kill reaps the agent it spawned as well, even
    // once its stand-in entrypoint is gone. Never a pid this test did not spawn.
    for (const child of children.splice(0)) {
        try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
            // The whole group already ended.
        }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'run-control-'));
    dirs.push(dir);
    return dir;
};

const until = async (what: string, ready: () => boolean, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!ready()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
};

/**
 * A mailbox on disk and the agent running in it under a stand-in entrypoint: the agent signals its
 * PARENT, so the parent here is a process that records the TERM it receives — the way the real
 * entrypoint's trap receives it, and the vitest worker never does.
 */
function mailbox(script: string, env: Record<string, string> = {}) {
    const root = scratch();
    const inDir = join(root, 'in');
    const outDir = join(root, 'out');
    mkdirSync(inDir);
    mkdirSync(outDir);
    const marker = join(root, 'factory-stop');
    const termed = join(root, 'termed');
    const parent = `
        const { spawn } = require('node:child_process');
        const fs = require('node:fs');
        process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(termed)}, 'TERM\\n'); });
        const child = spawn(process.execPath, [${JSON.stringify(path(script))}], { stdio: 'ignore', env: process.env });
        child.on('exit', (code) => process.exit(code ?? 0));
        setInterval(() => {}, 1000);
    `;
    const start = (extra: Record<string, string> = {}) => {
        const child = spawn(process.execPath, ['-e', parent], {
            env: {
                PATH: process.env.PATH ?? '',
                FACTORY_CTL_IN: inDir,
                FACTORY_CTL_OUT: outDir,
                FACTORY_STOP_MARKER: marker,
                FACTORY_CTL_TICK_MS: '20',
                ...env,
                ...extra,
            },
            stdio: 'ignore',
            detached: true,
        });
        children.push(child);
        return child;
    };
    return {
        root,
        inDir,
        outDir,
        marker,
        start,
        terms: (): number => (existsSync(termed) ? readFileSync(termed, 'utf8').trim().split('\n').length : 0),
        heartbeat: (): number => Number.parseInt(readFileSync(join(outDir, 'agent.alive'), 'utf8'), 10),
        say: (name: string, body = '1\n') => writeFileSync(join(inDir, name), body),
    };
}

describe('the agent’s mailbox helper', () => {
    it.each([CLAUDE_AGENT, OPENCODE_AGENT])('%s beats its heartbeat for the supervisor to read', async (script) => {
        const box = mailbox(script);
        box.start();
        await until('a heartbeat', () => existsSync(join(box.outDir, 'agent.alive')));
        const first = box.heartbeat();
        await until('a later heartbeat', () => box.heartbeat() > first);
        expect(existsSync(join(box.outDir, 'questions'))).toBe(true);
    });

    it.each([CLAUDE_AGENT, OPENCODE_AGENT])(
        '%s copies a Stop into the local marker, and only once one exists',
        async (script) => {
            const box = mailbox(script);
            box.start();
            await until('a heartbeat', () => existsSync(join(box.outDir, 'agent.alive')));
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(existsSync(box.marker)).toBe(false);

            box.say('stop', 'stop\n');
            await until('the marker', () => existsSync(box.marker));
            // A Stop is the step boundary's, not a kill: nothing was signalled.
            expect(box.terms()).toBe(0);
        }
    );

    it('sends TERM to its parent, once, on a kill order — the way a runtime stop reaches the entrypoint', async () => {
        const box = mailbox(CLAUDE_AGENT);
        box.start();
        await until('a heartbeat', () => existsSync(join(box.outDir, 'agent.alive')));
        box.say('kill', '{"cause":"agent_killed"}\n');
        await until('the TERM', () => box.terms() > 0);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(box.terms()).toBe(1);
    });

    // The supervisor is the agent's only way to a Stop, an answer or a drained transcript: an agent
    // whose supervisor stopped beating is ended, not left running unsupervised.
    it('ends the run when the supervisor’s heartbeat, once seen, goes stale', async () => {
        const box = mailbox(CLAUDE_AGENT, { FACTORY_SUPERVISOR_LOST_MS: '3000' });
        box.say('supervisor.alive', `${Date.now() - 120_000}\n`);
        box.start();
        await until('the TERM', () => box.terms() > 0);
    });

    it('leaves a run alone while the supervisor beats, and while it has not started yet', async () => {
        const beating = mailbox(CLAUDE_AGENT, { FACTORY_SUPERVISOR_LOST_MS: '3000' });
        beating.say('supervisor.alive', `${Date.now()}\n`);
        beating.start();
        const waiting = mailbox(CLAUDE_AGENT, { FACTORY_SUPERVISOR_LOST_MS: '3000' });
        waiting.start();
        await until('both heartbeats', () => existsSync(join(waiting.outDir, 'agent.alive')));
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(beating.terms()).toBe(0);
        expect(waiting.terms()).toBe(0);
    });

    // An agent whose entrypoint is gone has a new ppid — the container's init. TERM to that ends an
    // unrelated run's CLI, so a reparented agent exits and signals nobody. `process.kill` is replaced by a
    // recorder here: a regression is caught by the record, never by a signal.
    it('signals nobody once it is orphaned, whatever the mailbox says', async () => {
        const box = mailbox(CLAUDE_AGENT);
        const recorded = join(box.root, 'kills');
        const preload = join(box.root, 'record-kill.cjs');
        writeFileSync(
            preload,
            `process.kill = (pid, signal) => { require('node:fs').appendFileSync(${JSON.stringify(recorded)}, pid + ' ' + signal + '\\n'); };`
        );
        const pidFile = join(box.root, 'agent.pid');
        const parent = `
            const { spawn } = require('node:child_process');
            const child = spawn(process.execPath, ['--require', ${JSON.stringify(preload)}, ${JSON.stringify(path(CLAUDE_AGENT))}], { stdio: 'ignore', env: process.env });
            require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
            // Gone only once the agent runs, so it recorded this process as its parent first.
            setInterval(() => {
                if (require('node:fs').existsSync(${JSON.stringify(join(box.outDir, 'agent.alive'))})) process.exit(0);
            }, 10);
        `;
        const launcher = spawn(process.execPath, ['-e', parent], {
            env: {
                PATH: process.env.PATH ?? '',
                FACTORY_CTL_IN: box.inDir,
                FACTORY_CTL_OUT: box.outDir,
                FACTORY_CTL_TICK_MS: '20',
            },
            stdio: 'ignore',
            detached: true,
        });
        children.push(launcher);
        await new Promise((resolve) => launcher.on('exit', resolve));
        await until('the agent pid', () => existsSync(pidFile));
        const agent = Number.parseInt(readFileSync(pidFile, 'utf8'), 10);
        box.say('kill', '{"cause":"agent_killed"}\n');
        const alive = (): boolean => {
            try {
                process.kill(agent, 0);
                // An exited orphan awaits its new parent's wait(2); a zombie has ended.
                return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${agent}/stat`, 'utf8'));
            } catch {
                return false;
            }
        };
        await until('the orphan to exit', () => !alive());
        expect(existsSync(recorded) ? readFileSync(recorded, 'utf8') : '').toBe('');
    });

    it('does nothing without a mailbox, as an image run by hand', async () => {
        const box = mailbox(CLAUDE_AGENT);
        const child = box.start({ FACTORY_CTL_IN: '', FACTORY_CTL_OUT: '' });
        const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
        expect(code).toBe(0);
        expect(existsSync(join(box.outDir, 'agent.alive'))).toBe(false);
    });

    it('is the same file in both images', () => {
        expect(read(OPENCODE_AGENT)).toBe(read(CLAUDE_AGENT));
    });

    it('holds no control credential: it names no control URL or token, and speaks no HTTP', () => {
        const source = read(CLAUDE_AGENT);
        expect(source).not.toMatch(/BELLOWS_CONTROL|SUPERVISOR_CONTROL|fetch\(|node:http/);
    });
});

describe("Claude Code's PostToolUse stop hook", () => {
    const runHook = (marker: string): string =>
        execFileSync('node', [path(CLAUDE_HOOK)], {
            env: { PATH: process.env.PATH ?? '', FACTORY_STOP_MARKER: marker },
        }).toString();

    it('says nothing without the marker and ends the run with it', () => {
        const marker = join(scratch(), 'stop');
        expect(runHook(marker)).toBe('');

        writeFileSync(marker, 'stop\n');
        expect(JSON.parse(runHook(marker))).toMatchObject({ continue: false });
    });

    it('is registered as the only PostToolUse hook', () => {
        const settings = JSON.parse(read('docker/claude-executor/claude-home/settings.json')) as {
            hooks: Record<string, { hooks: { command: string }[] }[]>;
        };
        expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'Stop', 'UserPromptSubmit']);
        expect(settings.hooks.PostToolUse!.flatMap((entry) => entry.hooks.map((hook) => hook.command))).toEqual([
            'node /usr/local/bin/stop-hook.cjs',
        ]);
    });

    it('registers the prose-question Stop hook as a prompt hook with the exact prompt (issue #226)', () => {
        const settings = JSON.parse(read('docker/claude-executor/claude-home/settings.json')) as {
            hooks: { Stop: unknown[] };
        };
        expect(settings.hooks.Stop).toEqual([
            { hooks: [{ type: 'prompt', model: '__FACTORY_RUN_MODEL__', prompt: STOP_PROMPT }] },
        ]);
    });
});

describe("OpenCode's stop plugin", () => {
    type Hooks = {
        event: (input: { event: unknown }) => Promise<void>;
        'tool.execute.after': (input: { sessionID?: string }) => Promise<void>;
    };
    const load = async (): Promise<(input: { client: unknown }) => Promise<Hooks>> =>
        (await import(pathToFileURL(path(OPENCODE_PLUGIN)).href)).FactoryStopPlugin;

    const withMarker = async (present: boolean) => {
        const marker = join(scratch(), 'stop');
        if (present) writeFileSync(marker, 'stop\n');
        process.env.FACTORY_STOP_MARKER = marker;
        const aborted: unknown[] = [];
        const client = { session: { abort: async (args: unknown) => void aborted.push(args) } };
        return { hooks: await (await load())({ client }), aborted };
    };
    afterEach(() => {
        delete process.env.FACTORY_STOP_MARKER;
    });

    it('aborts the session once at a step boundary when the marker exists', async () => {
        const { hooks, aborted } = await withMarker(true);

        await hooks.event({
            event: { type: 'message.part.updated', properties: { part: { type: 'step-finish', sessionID: 'ses_1' } } },
        });
        await hooks['tool.execute.after']({ sessionID: 'ses_1' });

        expect(aborted).toEqual([{ path: { id: 'ses_1' } }]);
    });

    it('aborts after a tool call too, and leaves a marker-less run alone', async () => {
        const stopped = await withMarker(true);
        await stopped.hooks['tool.execute.after']({ sessionID: 'ses_2' });
        expect(stopped.aborted).toEqual([{ path: { id: 'ses_2' } }]);

        const running = await withMarker(false);
        await running.hooks['tool.execute.after']({ sessionID: 'ses_3' });
        await running.hooks.event({
            event: { type: 'message.part.updated', properties: { part: { type: 'step-finish', sessionID: 'ses_3' } } },
        });
        expect(running.aborted).toEqual([]);
    });

    // The entrypoint reads this record to tell a Stop's abort from a genuine opencode failure.
    it('records the abort beside the marker, and only once the abort succeeded', async () => {
        const stopped = await withMarker(true);
        await stopped.hooks['tool.execute.after']({ sessionID: 'ses_5' });
        expect(existsSync(`${process.env.FACTORY_STOP_MARKER}.aborted`)).toBe(true);

        const marker = join(scratch(), 'stop');
        writeFileSync(marker, 'stop\n');
        process.env.FACTORY_STOP_MARKER = marker;
        const failing = { session: { abort: async () => Promise.reject(new Error('no such session')) } };
        const hooks = await (await load())({ client: failing });
        await hooks['tool.execute.after']({ sessionID: 'ses_6' });
        expect(existsSync(`${marker}.aborted`)).toBe(false);
    });

    it('ignores events that are not a finished step', async () => {
        const { hooks, aborted } = await withMarker(true);
        await hooks.event({
            event: { type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 'ses_4' } } },
        });
        await hooks.event({ event: { type: 'session.idle', properties: {} } });
        expect(aborted).toEqual([]);
    });
});

describe('the images ship the cooperative Stop', () => {
    it('copies the claude pieces to /usr/local/bin and starts the mailbox agent beside the reporter', () => {
        const dockerfile = read('docker/claude-executor/Dockerfile');
        expect(dockerfile).toMatch(/COPY[^\n]*ctl-agent\.cjs \/usr\/local\/bin\/ctl-agent\.cjs/);
        expect(dockerfile).toMatch(/COPY[^\n]*stop-hook\.cjs \/usr\/local\/bin\/stop-hook\.cjs/);
        expect(dockerfile).not.toContain('stop-poller');
        const entrypoint = read('docker/claude-executor/entrypoint.sh');
        expect(entrypoint).toContain('node /usr/local/bin/ctl-agent.cjs >/dev/null 2>&1 &');
        expect(entrypoint).toContain('$CTL_PID');
    });

    it('bakes the opencode plugin root-owned and registers it beside the others', () => {
        const dockerfile = read('docker/opencode-executor/Dockerfile');
        expect(dockerfile).toMatch(/COPY[^\n]*ctl-agent\.cjs \/usr\/local\/bin\/ctl-agent\.cjs/);
        expect(dockerfile).toMatch(/COPY stop-plugin\/ \/usr\/local\/lib\/node_modules\/factory-stop-plugin\//);
        expect(dockerfile).not.toContain('stop-poller');
        const config = JSON.parse(read('docker/opencode-executor/opencode-home/opencode.json')) as { plugin: string[] };
        expect(config.plugin).toContain('/usr/local/lib/node_modules/factory-stop-plugin');
        const entrypoint = read('docker/opencode-executor/entrypoint.sh');
        expect(entrypoint).toContain('node /usr/local/bin/ctl-agent.cjs >/dev/null 2>&1 &');
        expect(entrypoint).toContain('$CTL_PID');
    });

    // #829: a helper TERMed between its fork and exec swallows the signal, so no helper is reaped by
    // a bare `wait` — the behaviour is pinned on the lane stub in lane-stubs.test.ts.
    it.each([
        ['claude', ['REPORTER_PID', 'CTL_PID', 'PROXY_PID', 'PROGRESS_PID']],
        ['opencode', ['REPORTER_PID', 'WATCHER_PID', 'CTL_PID', 'PROXY_PID']],
    ])('the %s entrypoint stops every helper through the TERM-again guard', (name, helpers) => {
        const entrypoint = read(`docker/${name}-executor/entrypoint.sh`);
        expect(entrypoint).toContain('kill -KILL "$1" 2>/dev/null');
        for (const pid of helpers) {
            expect(entrypoint).toContain(`stop_helper "$${pid}"`);
            expect(entrypoint).not.toMatch(new RegExp(`wait "\\$${pid}"`));
        }
    });

    // The supervisor learns the agent is over from this file, written last; the runtime's own exit
    // status stays the verdict.
    it.each(['claude', 'opencode'])(
        'the %s entrypoint writes the agent’s exit status for the supervisor, last',
        (name) => {
            const entrypoint = read(`docker/${name}-executor/entrypoint.sh`);
            expect(entrypoint).toContain('"$FACTORY_CTL_OUT/agent.exit.tmp"');
            expect(entrypoint).toContain('mv "$FACTORY_CTL_OUT/agent.exit.tmp" "$FACTORY_CTL_OUT/agent.exit"');
            expect(entrypoint.lastIndexOf('agent.exit')).toBeLessThan(entrypoint.lastIndexOf('exit "$STATUS"'));
        }
    );

    it.each(['claude', 'opencode'])('the %s image bakes the mailbox mount points node-owned', (name) => {
        const dockerfile = read(`docker/${name}-executor/Dockerfile`);
        expect(dockerfile).toContain(
            'RUN mkdir -p /factory/in /factory/out /factory/export /factory/supervisor /factory/gate /factory/review /factory/binding && chown -R node:node /factory'
        );
    });
});
