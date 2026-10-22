#!/usr/bin/env node
'use strict';
/*
 * The agent's tool shell (issue #814). The CLI runs as uid 1000 and every command it runs — through
 * its shell — runs as uid 1001 in group 1000, so a tool's `kill -KILL -1`, `kill 0` or a stray parent
 * pid reaches only the tool uid's own processes, never the CLI or its helpers.
 *
 *   node factory-tool.cjs serve        the broker: root with CAP_SETUID and CAP_SETGID and nothing
 *                                      else, started by factory-launch before it drops to the CLI uid
 *   node factory-tool.cjs run ARGS...  the client: the CLI's shell (`tool-bash.sh`), standing in
 *                                      for `bash ARGS...`
 *
 * The client sends its argv, working directory and environment over the broker's socket, which only
 * the CLI uid can reach (group factory-agent); the broker starts `/bin/bash ARGS...` as the tool uid
 * in a process group of its own and streams its output and exit status back. A signal the client
 * receives is forwarded to that group, and a client that goes away before its command ended takes
 * the group with it. The broker holds its two capabilities for the run and no credential: it starts
 * under an empty environment, and a tool's environment never carries the run-control token.
 *
 * Kept byte-identical in both executor images (driver/test/tool-broker.test.ts).
 */
const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

const SOCKET = '/run/factory-tool/broker.sock';
/** Reachable by the CLI uid alone: the directory is root:factory-agent 2750 in the image. */
const SOCKET_MODE = 0o660;
/** `factory-tool` in both images; TOOL_UID of driver/src/claim.ts. */
const TOOL = { uid: 1001, gid: 1000 };
const TOOL_SHELL = '/bin/bash';
const TOOL_HOME = '/home/factory-tool';
/** The kubernetes `out` mailbox is a root-owned 0777 emptyDir; sticky, a tool cannot rename the agent's own. */
const AGENT_OUT_MAILBOX = '/factory/out';
const STICKY_SHARED_MODE = 0o1777;
/** Never passed to a tool: the CLI's own shell override, and the run-control token (control-proxy.cjs). */
const WITHHELD = ['CLAUDE_CODE_SHELL'];
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGKILL'];
/** `sh`'s "cannot execute": the command never started, and nothing ran as the CLI uid instead. */
const REFUSED_EXIT = 126;
/** How long an exited command's output may still drain, from processes it left holding its pipes. */
const DRAIN_GRACE_MS = 500;
/** A frame's type byte and 4-byte big-endian length; no frame of this protocol is near the cap. */
const HEADER_BYTES = 5;
const FRAME_LIMIT = 64 * 1024 * 1024;
const FRAME = {
    request: 'q',
    stdin: 'i',
    stdinEnd: 'e',
    signal: 's',
    stdout: 'o',
    stderr: 'r',
    exit: 'x',
};

function frame(type, payload = '') {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const head = Buffer.alloc(HEADER_BYTES);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(body.length, 1);
    return Buffer.concat([head, body]);
}

/** A stream parser: calls `onFrame(type, payload)` per whole frame; false on a malformed stream. */
function frames(onFrame) {
    let pending = Buffer.alloc(0);
    return (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= HEADER_BYTES) {
            const length = pending.readUInt32BE(1);
            if (length > FRAME_LIMIT) return false;
            if (pending.length < HEADER_BYTES + length) break;
            onFrame(String.fromCharCode(pending[0]), pending.subarray(HEADER_BYTES, HEADER_BYTES + length));
            pending = pending.subarray(HEADER_BYTES + length);
        }
        return true;
    };
}

const isStrings = (list) => Array.isArray(list) && list.every((item) => typeof item === 'string');

/** The request a client sent, or null: argv and env strings only, a working directory. */
function parseRequest(payload) {
    let request;
    try {
        request = JSON.parse(payload.toString('utf8'));
    } catch {
        return null;
    }
    if (!isStrings(request?.argv) || typeof request.cwd !== 'string') return null;
    const env = request.env;
    if (!env || typeof env !== 'object' || !Object.values(env).every((value) => typeof value === 'string')) return null;
    return request;
}

/** The tool's environment: the CLI's, its own HOME and shell, and nothing withheld. */
function toolEnv(env) {
    const out = { ...env, HOME: TOOL_HOME, SHELL: TOOL_SHELL };
    for (const name of WITHHELD) delete out[name];
    return out;
}

/**
 * Signals the tool's process group. Root without CAP_KILL cannot signal another uid, so the signal is
 * sent by a `kill` of the tool uid's own.
 */
function signalGroup(deps, pid, signal) {
    if (!SIGNALS.includes(signal)) return;
    try {
        const argv = ['-c', 'kill -s "$1" -- "-$2" 2>/dev/null', 'kill', signal.slice(3), `${pid}`];
        deps.spawn('/bin/sh', argv, { ...(deps.identity ?? {}), stdio: 'ignore' }).on('error', () => undefined);
    } catch {
        // Nothing to signal with: the command's group outlives this one request, never the broker.
    }
}

/**
 * The tool shell's first step: enter the client's working directory, then exec the command's own
 * shell. spawn's own chdir runs before its uid switch, as the broker — root without DAC_OVERRIDE —
 * whom a directory the CLI and the tool share (0770) shuts out; the tool uid enters it as itself.
 */
const ENTER_CWD = `cd -P -- "$1" 2>/dev/null || { printf 'factory-tool: the tool uid cannot enter %s; the command did not run.\\n' "$1" >&2; exit ${REFUSED_EXIT}; }; shift; exec "$0" "$@"`;

/** One client connection: one command, from its request to its exit status. */
function serveConnection(deps, conn) {
    let child = null;
    let ended = false;
    const send = (type, payload) => {
        if (!conn.destroyed) conn.write(frame(type, payload));
    };
    const finish = (status) => {
        if (ended) return;
        ended = true;
        if (!conn.destroyed) conn.end(frame(FRAME.exit, JSON.stringify(status)));
    };
    const refuse = (reason) => {
        send(FRAME.stderr, `factory-tool: ${reason}; the command did not run.\n`);
        finish({ code: REFUSED_EXIT, signal: null });
    };
    const start = (payload) => {
        const request = parseRequest(payload);
        if (!request) return refuse('a malformed request');
        try {
            child = deps.spawn(TOOL_SHELL, ['-c', ENTER_CWD, TOOL_SHELL, request.cwd, ...request.argv], {
                cwd: '/',
                env: toolEnv(request.env),
                ...(deps.identity ?? {}),
                detached: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            // A refused uid switch throws here rather than emitting: one command fails, never the broker.
            return refuse(`the tool shell could not start (${error.code ?? error.message})`);
        }
        child.on('error', (error) => refuse(`the tool shell could not start (${error.code ?? error.message})`));
        child.stdin.on('error', () => undefined);
        const open = new Set(['stdout', 'stderr']);
        let exit = null;
        const settle = () => {
            if (exit && open.size === 0) finish(exit);
        };
        // Backpressure: output a slow client has not taken waits in the command's own pipes, so a
        // command can block on its writes but never grow this process. Paused again on every full
        // write: Node resumes a child's pipes as it exits, and a background writer outlives it.
        let held = false;
        const hold = () => {
            child.stdout.pause();
            child.stderr.pause();
            if (held) return;
            held = true;
            conn.once('drain', () => {
                held = false;
                child.stdout.resume();
                child.stderr.resume();
            });
        };
        for (const [name, type] of [
            ['stdout', FRAME.stdout],
            ['stderr', FRAME.stderr],
        ]) {
            child[name].on('data', (chunk) => {
                if (!conn.destroyed && !ended && !conn.write(frame(type, chunk))) hold();
            });
            child[name].on('close', () => {
                open.delete(name);
                settle();
            });
        }
        // The grace is for a background child still holding the pipes, never for output held back.
        const expire = () => {
            if (held) conn.once('drain', () => setTimeout(expire, DRAIN_GRACE_MS).unref());
            else finish(exit);
        };
        child.on('exit', (code, signal) => {
            exit = { code, signal };
            settle();
            setTimeout(expire, DRAIN_GRACE_MS).unref();
        });
    };
    const parse = frames((type, payload) => {
        if (type === FRAME.request && !child && !ended) start(payload);
        else if (type === FRAME.stdin && child) child.stdin.write(payload);
        else if (type === FRAME.stdinEnd && child) child.stdin.end();
        else if (type === FRAME.signal && child?.pid) signalGroup(deps, child.pid, payload.toString());
    });
    conn.on('data', (chunk) => {
        if (!parse(chunk)) conn.destroy();
    });
    conn.on('error', () => undefined);
    // A client gone before its command ended — killed by a timeout, say — takes the command with it,
    // and nobody reads what is left: the pipes close with the client, held or not.
    conn.on('close', () => {
        if (child?.pid && !ended) signalGroup(deps, child.pid, 'SIGKILL');
        for (const stream of [child?.stdin, child?.stdout, child?.stderr]) stream?.destroy();
    });
}

/** Makes a root-owned shared `out` mailbox sticky; a mailbox the image made the agent's is left alone. */
function protectMailbox(deps) {
    let stat;
    try {
        stat = deps.fs.statSync(deps.mailbox);
    } catch {
        return;
    }
    if (stat.uid === 0 && (stat.mode & STICKY_SHARED_MODE) !== STICKY_SHARED_MODE) {
        deps.fs.chmodSync(deps.mailbox, STICKY_SHARED_MODE);
    }
}

/** The broker. Resolves once listening; a failure throws, and factory-launch never starts the CLI. */
function serve(deps) {
    protectMailbox(deps);
    deps.fs.rmSync(deps.socket, { force: true });
    const server = net.createServer((conn) => serveConnection(deps, conn));
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.socket, () => {
            deps.fs.chmodSync(deps.socket, SOCKET_MODE);
            resolve(server);
        });
    });
}

/** The client: the command's output on this process's streams, its exit status as this one's. */
function run(argv, deps) {
    return new Promise((resolve) => {
        let status = null;
        let connected = false;
        const conn = net.connect(deps.socket);
        const forward = (signal) => () => {
            if (!conn.destroyed) conn.write(frame(FRAME.signal, signal));
        };
        const handlers = SIGNALS.filter((signal) => signal !== 'SIGKILL').map((signal) => [signal, forward(signal)]);
        // Backpressure: a reader that stopped reading stops this one reading the broker, which holds
        // the command in turn, until every stream it filled has drained.
        const full = new Set();
        const write = (stream, payload) => {
            if (stream.write(payload) || full.has(stream)) return;
            full.add(stream);
            conn.pause();
            stream.once('drain', () => {
                full.delete(stream);
                if (full.size === 0) conn.resume();
            });
        };
        const parse = frames((type, payload) => {
            if (type === FRAME.stdout) write(deps.stdout, payload);
            else if (type === FRAME.stderr) write(deps.stderr, payload);
            else if (type === FRAME.exit) status = JSON.parse(payload.toString('utf8'));
        });
        conn.on('connect', () => {
            connected = true;
            for (const [signal, handler] of handlers) process.on(signal, handler);
            conn.write(frame(FRAME.request, JSON.stringify({ argv, cwd: deps.cwd, env: deps.env })));
            deps.stdin.on('data', (chunk) => conn.write(frame(FRAME.stdin, chunk)));
            deps.stdin.on('end', () => conn.write(frame(FRAME.stdinEnd)));
            deps.stdin.on('error', () => conn.write(frame(FRAME.stdinEnd)));
        });
        conn.on('data', (chunk) => {
            if (!parse(chunk)) conn.destroy();
        });
        conn.on('error', (error) => {
            if (!connected) {
                deps.stderr.write(
                    `factory-tool: the tool broker is unreachable (${error.code ?? error.message}); the command did not run.\n`
                );
            }
        });
        conn.on('close', () => {
            for (const [signal, handler] of handlers) process.off(signal, handler);
            deps.stdin.destroy();
            if (connected && !status) {
                deps.stderr.write('factory-tool: the tool broker went away before the command ended.\n');
            }
            resolve(status ?? { code: REFUSED_EXIT, signal: null });
        });
    });
}

/** Ends this process as the command ended: its exit code, or the signal that ended it re-raised. */
function exitAs(status) {
    const done = () => {
        if (status.signal) process.kill(process.pid, status.signal);
        else process.exit(status.code ?? REFUSED_EXIT);
    };
    process.stdout.write('', () => process.stderr.write('', done));
}

if (require.main === module) {
    const [mode, ...argv] = process.argv.slice(2);
    if (mode === 'serve') {
        serve({ fs, spawn, socket: SOCKET, mailbox: AGENT_OUT_MAILBOX, identity: TOOL }).catch((error) => {
            process.stderr.write(`factory-tool: the broker could not start: ${error.message}\n`);
            process.exit(1);
        });
    } else if (mode === 'run') {
        run(argv, {
            socket: SOCKET,
            cwd: process.cwd(),
            env: process.env,
            stdin: process.stdin,
            stdout: process.stdout,
            stderr: process.stderr,
        }).then(exitAs);
    } else {
        process.stderr.write('usage: factory-tool.cjs serve | run ARGS...\n');
        process.exit(2);
    }
}

module.exports = { serve, run, toolEnv, frame, frames, SOCKET, TOOL, TOOL_HOME, WITHHELD, REFUSED_EXIT };
