import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_UID } from '../src/claim.js';
import { REPO_ROOT as ROOT } from './fixtures/repo-files.js';

/**
 * The agent's tool shell (issue #814), shipped in both executor images: the broker that starts each
 * command as the tool uid and the client the CLI runs as its shell. Driven over a real socket in a
 * scratch directory, as this test's own uid — the uid switch itself is the images' to prove
 * (docker/*-executor/test.sh) — with the spawn options the broker passes pinned on the side.
 */
const BROKER = join(ROOT, 'docker/claude-executor/factory-tool.cjs');
const WRAPPER = join(ROOT, 'docker/claude-executor/tool-bash.sh');
/** Far past every pipe and socket buffer between the command and the reader. */
const BIG_OUTPUT = 32 * 1024 * 1024;
/** The client's streams' high-water mark, and what one nobody reads may hold: one read's frames. */
const CLIENT_STREAM_MARK = 1024;
const STALLED_STREAM_BOUND = 64 * 1024;
/** The broker's DRAIN_GRACE_MS, and past it. */
const PAST_DRAIN_GRACE_MS = 1000;

interface Status {
    code: number | null;
    signal: string | null;
}
interface BrokerDeps {
    fs: unknown;
    spawn: typeof spawn;
    socket: string;
    mailbox: string;
    identity: { uid: number; gid: number } | null;
}
const broker = createRequire(import.meta.url)(BROKER) as {
    serve: (deps: BrokerDeps) => Promise<Server>;
    toolEnv: (env: Record<string, string>) => Record<string, string>;
    TOOL: { uid: number; gid: number };
    TOOL_HOME: string;
    REFUSED_EXIT: number;
    run: (
        argv: string[],
        deps: {
            socket: string;
            cwd: string;
            env: Record<string, string>;
            stdin: unknown;
            stdout: unknown;
            stderr: unknown;
        }
    ) => Promise<Status>;
    frame: (type: string, payload?: string | Buffer) => Buffer;
    frames: (onFrame: (type: string, payload: Buffer) => void) => (chunk: Buffer) => boolean;
};

const servers: Server[] = [];
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const server of servers.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-broker-'));
    dirs.push(dir);
    return dir;
};

/** A broker on a scratch socket; `spawned` collects what it asked spawn for. */
async function startBroker(options: Partial<BrokerDeps> = {}) {
    const dir = scratch();
    const spawned: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
    const recording = ((file: string, args: string[], opts: Record<string, unknown>) => {
        spawned.push({ file, args, options: opts });
        return spawn(file, args, opts);
    }) as unknown as typeof spawn;
    const socket = join(dir, 'broker.sock');
    const server = await broker.serve({
        fs,
        spawn: recording,
        socket,
        mailbox: join(dir, 'out'),
        identity: null,
        ...options,
    });
    servers.push(server);
    return { socket, spawned, dir };
}

/** The real client, as a process of its own, against `socket`. */
function client(socket: string, argv: string[], cwd = process.cwd()): ChildProcess {
    const script = `require(${JSON.stringify(BROKER)}).run(${JSON.stringify(argv)}, {
        socket: ${JSON.stringify(socket)}, cwd: ${JSON.stringify(cwd)}, env: process.env,
        stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    }).then((status) => {
        process.stdout.write('', () => status.signal ? process.kill(process.pid, status.signal) : process.exit(status.code));
    })`;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return child;
}

function settled(child: ChildProcess): Promise<{ stdout: Buffer; stderr: string; status: Status }> {
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
    });
    return new Promise((resolve) =>
        child.on('close', (code, signal) => resolve({ stdout: Buffer.concat(out), stderr, status: { code, signal } }))
    );
}

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

async function until(what: string, check: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe('the tool broker', () => {
    it('starts the command as /bin/bash with its argv, as the tool uid, in a group of its own', async () => {
        const { socket, spawned } = await startBroker({ identity: broker.TOOL });
        // The uid switch fails unprivileged: the spawn is recorded, and that one command is refused
        // while the broker serves on.
        expect((await settled(client(socket, ['-c', 'true']))).status.code).toBe(broker.REFUSED_EXIT);
        expect((await settled(client(socket, ['-c', 'true']))).status.code).toBe(broker.REFUSED_EXIT);
        // The working directory is entered as the tool uid, by the shell: spawn's own chdir runs as the
        // broker, root without DAC_OVERRIDE, which a directory node and the tool share may shut out.
        expect(spawned[0]).toMatchObject({
            file: '/bin/bash',
            args: ['-c', expect.stringContaining('cd -P -- "$1"'), '/bin/bash', process.cwd(), '-c', 'true'],
            options: { uid: TOOL_UID, gid: 1000, detached: true, cwd: '/' },
        });
        expect(broker.TOOL.uid).toBe(TOOL_UID);
    });

    it('gives the tool its own HOME and shell, and never the run-control token or the CLI’s shell override', () => {
        const env = broker.toolEnv({
            PATH: '/usr/bin',
            HOME: '/home/node',
            SHELL: '/usr/local/libexec/factory-tool/bash',
            CLAUDE_CODE_SHELL: '/usr/local/libexec/factory-tool/bash',
            BELLOWS_CONTROL_TOKEN: 'secret',
            BELLOWS_CONTROL_URL: 'http://driver',
            RUNNER_LEASE_TOKEN: 'lease',
        });
        expect(env).toEqual({
            PATH: '/usr/bin',
            HOME: broker.TOOL_HOME,
            SHELL: '/bin/bash',
            BELLOWS_CONTROL_URL: 'http://driver',
            RUNNER_LEASE_TOKEN: 'lease',
        });
    });

    it('streams stdout, stderr and the exit code back byte for byte', async () => {
        const { socket } = await startBroker();
        const ran = await settled(client(socket, ['-c', 'printf "a\\000b\\n"; printf oops >&2; exit 3']));
        expect(ran.stdout).toEqual(Buffer.from('a\0b\n'));
        expect(ran.stderr).toBe('oops');
        expect(ran.status).toEqual({ code: 3, signal: null });
    });

    it('holds a command that out-writes a reader who stopped reading, and loses none of its output', async () => {
        const { socket, dir } = await startBroker();
        const written = join(dir, 'written');
        const child = client(socket, ['-c', `head -c ${BIG_OUTPUT} /dev/zero; touch '${written}'`]);
        // Nobody reads the client for a second: the command blocks on its pipe, never read into memory.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(existsSync(written)).toBe(false);
        const ran = await settled(child);
        expect(ran.stdout.length).toBe(BIG_OUTPUT);
        expect(ran.status).toEqual({ code: 0, signal: null });
        expect(existsSync(written)).toBe(true);
    });

    it('keeps holding what a finished command left writing in the background', async () => {
        // Node resumes a child's pipes as it exits: the hold must outlast the shell's exit.
        let command: ChildProcess | null = null;
        const { socket } = await startBroker({
            spawn: ((file: string, args: string[], options: object) => {
                command = spawn(file, args, options);
                children.push(command);
                return command;
            }) as unknown as typeof spawn,
        });
        const conn = connect(socket);
        conn.on('error', () => undefined);
        conn.pause();
        const argv = ['-c', `head -c ${BIG_OUTPUT} /dev/zero & sleep 0.2`];
        conn.write(broker.frame('q', JSON.stringify({ argv, cwd: process.cwd(), env: { PATH: process.env.PATH } })));
        await until('the shell to exit', () => (command as ChildProcess | null)?.exitCode === 0);
        await new Promise((resolve) => setTimeout(resolve, PAST_DRAIN_GRACE_MS));
        // A child's pipe is a socket: what the broker has taken from it so far.
        expect(((command as unknown as ChildProcess).stdout as Socket).bytesRead).toBeLessThan(BIG_OUTPUT / 4);
        conn.destroy();
    });

    it('closes the pipes of a command whose client went away while its output was held', async () => {
        let command: ChildProcess | null = null;
        const { socket } = await startBroker({
            spawn: ((file: string, args: string[], options: object) => {
                command = spawn(file, args, options);
                children.push(command);
                return command;
            }) as unknown as typeof spawn,
        });
        const conn = connect(socket);
        conn.on('error', () => undefined);
        conn.pause();
        const argv = ['-c', `head -c ${BIG_OUTPUT} /dev/zero & sleep 0.2`];
        conn.write(broker.frame('q', JSON.stringify({ argv, cwd: process.cwd(), env: { PATH: process.env.PATH } })));
        await until('the shell to exit', () => (command as ChildProcess | null)?.exitCode === 0);
        conn.destroy();
        const pipes = command as unknown as ChildProcess;
        await until('the pipes to close', () => pipes.stdout!.destroyed && pipes.stderr!.destroyed);
    });

    it('sends the exit only after the output it held back, however long past the drain grace', async () => {
        // A command that exits with output still held back for a client that is not reading.
        const stdout = new PassThrough();
        const command = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout,
            stderr: new PassThrough(),
        });
        const { socket } = await startBroker({ spawn: (() => command) as unknown as typeof spawn });
        const conn = connect(socket);
        conn.pause();
        conn.write(broker.frame('q', JSON.stringify({ argv: ['-c', ':'], cwd: process.cwd(), env: {} })));
        let sent = 0;
        while (!stdout.isPaused()) {
            stdout.write(Buffer.alloc(64 * 1024));
            sent += 64 * 1024;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        stdout.end(Buffer.alloc(64 * 1024));
        sent += 64 * 1024;
        command.stderr.end();
        command.emit('exit', 0, null);
        await new Promise((resolve) => setTimeout(resolve, PAST_DRAIN_GRACE_MS));

        let received = 0;
        let status: Status | null = null;
        const parse = broker.frames((type, payload) => {
            if (type === 'o') received += payload.length;
            if (type === 'x') status = JSON.parse(payload.toString());
        });
        conn.on('data', parse);
        await new Promise((resolve) => conn.on('end', resolve).resume());
        expect(received).toBe(sent);
        expect(status).toEqual({ code: 0, signal: null });
    });

    it('feeds the command the client’s stdin, to its end', async () => {
        const { socket } = await startBroker();
        const child = client(socket, ['-c', 'cat; echo done']);
        child.stdin?.end('piped input\n');
        const ran = await settled(child);
        expect(ran.stdout.toString()).toBe('piped input\ndone\n');
    });

    it('forwards a TERM the client gets to the command, and ends as the command did', async () => {
        const { socket } = await startBroker();
        const child = client(socket, ['-c', 'echo started; sleep 30']);
        const ran = settled(child);
        await new Promise((resolve) => child.stdout?.once('data', resolve));
        child.kill('SIGTERM');
        expect((await ran).status.signal).toBe('SIGTERM');
    });

    it('takes the command’s whole group with it when the client is killed outright', async () => {
        const { socket } = await startBroker();
        const child = client(socket, ['-c', 'sleep 30 & echo $!; wait']);
        let pid = 0;
        child.stdout?.on('data', (chunk: Buffer) => {
            pid ||= Number.parseInt(chunk.toString(), 10);
        });
        await until('the background pid', () => pid > 0);
        expect(alive(pid)).toBe(true);
        child.kill('SIGKILL');
        await until('the group to be killed', () => !alive(pid));
    });

    it('leaves what a finished command started in the background running, as a shell would', async () => {
        const { socket } = await startBroker();
        const ran = await settled(client(socket, ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!']));
        const pid = Number.parseInt(ran.stdout.toString(), 10);
        expect(ran.status).toEqual({ code: 0, signal: null });
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(alive(pid)).toBe(true);
        process.kill(pid, 'SIGKILL');
    });

    it('refuses a command whose working directory is gone, and runs nothing', async () => {
        const { socket, dir } = await startBroker();
        const ran = await settled(client(socket, ['-c', `touch ${join(dir, 'ran')}`], join(dir, 'gone')));
        expect(ran.status.code).toBe(broker.REFUSED_EXIT);
        expect(ran.stderr).toBe(
            `factory-tool: the tool uid cannot enter ${join(dir, 'gone')}; the command did not run.\n`
        );
        expect(existsSync(join(dir, 'ran'))).toBe(false);
    });

    it('makes a root-owned shared `out` mailbox sticky before it listens, and leaves the agent’s own alone', async () => {
        const chmods: [string, number][] = [];
        const MAILBOX = '/factory/out';
        const seam = (uid: number) => ({
            ...fs,
            statSync: (path: string) => (path === MAILBOX ? { uid, mode: 0o40777 } : fs.statSync(path)),
            chmodSync: (path: string, mode: number) => {
                chmods.push([path, mode]);
                if (path !== MAILBOX) fs.chmodSync(path, mode);
            },
        });
        const dir = scratch();
        await startBroker({ fs: seam(0), mailbox: MAILBOX, socket: join(dir, 'a.sock') });
        expect(chmods[0]).toEqual([MAILBOX, 0o1777]);
        chmods.length = 0;
        await startBroker({ fs: seam(1000), mailbox: MAILBOX, socket: join(dir, 'b.sock') });
        expect(chmods.map(([path]) => path)).not.toContain('/factory/out');
    });
});

describe('the tool client', () => {
    it('refuses with 126 and runs nothing when the broker does not answer', async () => {
        const dir = scratch();
        const ran = await settled(client(join(dir, 'absent.sock'), ['-c', `touch ${join(dir, 'ran')}`]));
        expect(ran.status.code).toBe(broker.REFUSED_EXIT);
        expect(ran.stderr).toMatch(/the tool broker is unreachable/);
        expect(existsSync(join(dir, 'ran'))).toBe(false);
    });

    it('stops reading the broker while either of its streams is full, until both have drained', async () => {
        // A broker pacing pairs of frames that land in one read, each past its stream's high-water
        // mark: stdout first, drained a tick later, then stderr, never read until the end.
        const dir = scratch();
        const socket = join(dir, 'broker.sock');
        const pair = Buffer.concat([
            broker.frame('o', Buffer.alloc(2 * CLIENT_STREAM_MARK)),
            broker.frame('r', Buffer.alloc(2 * CLIENT_STREAM_MARK)),
        ]);
        let served: Socket | null = null;
        let pacer: NodeJS.Timeout | undefined;
        const server = createServer((conn) => {
            served = conn;
            conn.on('error', () => undefined);
            conn.once('data', () => {
                pacer = setInterval(() => conn.write(pair), 5);
            });
        });
        await new Promise<void>((resolve) => server.listen(socket, resolve));
        servers.push(server);
        let stalled: (() => void) | null = null;
        let reading = false;
        const stdout = new Writable({
            highWaterMark: CLIENT_STREAM_MARK,
            write: (_chunk, _encoding, done) => setImmediate(done),
        });
        const stderr = new Writable({
            highWaterMark: CLIENT_STREAM_MARK,
            write: (_chunk, _encoding, done) => {
                if (reading) done();
                else stalled = done;
            },
        });
        const ran = broker.run(['-c', ':'], {
            socket,
            cwd: process.cwd(),
            env: {},
            stdin: new PassThrough(),
            stdout,
            stderr,
        });

        try {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            expect(stderr.writableLength).toBeLessThanOrEqual(STALLED_STREAM_BOUND);
        } finally {
            clearInterval(pacer);
            reading = true;
            (stalled as (() => void) | null)?.();
            (served as Socket | null)?.end();
            await ran;
        }
    });

    it('is plain bash where no broker was ever started — an image run by hand', () => {
        // The wrapper's socket path is the image's own, which no development host has.
        expect(existsSync('/run/factory-tool/broker.sock')).toBe(false);
        const ran = spawnSync('sh', [WRAPPER, '-c', 'echo "$0 ran"'], { encoding: 'utf8' });
        expect(ran.stdout).toBe('/bin/bash ran\n');
    });
});

describe('the tool shell files', () => {
    it.each(['factory-tool.cjs', 'tool-bash.sh', 'control-proxy.cjs', 'factory-launch.sh'])(
        '%s is byte-identical in both images',
        (name) => {
            expect(readFileSync(join(ROOT, 'docker/opencode-executor', name), 'utf8')).toBe(
                readFileSync(join(ROOT, 'docker/claude-executor', name), 'utf8')
            );
        }
    );
});
