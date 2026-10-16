#!/usr/bin/env node
'use strict';
// The agent container's end of the task supervisor's mailbox. The supervisor (a separate, trusted
// container of the same pod or container group) and this container share two directories and
// nothing else: FACTORY_CTL_IN, which the agent mounts read-only and the supervisor writes (the
// Stop, a kill order, its heartbeat, the answers to questions), and FACTORY_CTL_OUT, the agent's
// own (its heartbeat and exit status, its questions). The agent therefore holds no control
// credential: it can read what the supervisor decided and cannot forge it.
//
// Every FACTORY_CTL_TICK_MS this beats `agent.alive`, copies a Stop into the local stop marker the
// baked PostToolUse hook / OpenCode plugin reads (FACTORY_STOP_MARKER, a path the agent owns),
// and — on a kill order, or when the supervisor's heartbeat stops — sends TERM to its parent, the
// entrypoint, which forwards it to the CLI exactly as a runtime stop would. A sibling of the CLI,
// never its parent: it kills nothing itself. With no mailbox (an image run by hand) it exits.
//
// Deliberate copy: docker/claude-executor/ and docker/opencode-executor/ each hold this file, byte
// for byte (driver/test/executor-images.test.ts), because each image's build context is its own
// directory.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TICK_MS = 1000;
const DEFAULT_SUPERVISOR_LOST_MS = 60_000;

const inDir = process.env.FACTORY_CTL_IN;
const outDir = process.env.FACTORY_CTL_OUT;
const marker = process.env.FACTORY_STOP_MARKER;
const positive = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};
const tickMs = positive('FACTORY_CTL_TICK_MS', DEFAULT_TICK_MS);
const lostMs = positive('FACTORY_SUPERVISOR_LOST_MS', DEFAULT_SUPERVISOR_LOST_MS);

const readText = (file) => {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
};

const beat = () => {
    try {
        const target = path.join(outDir, 'agent.alive');
        fs.writeFileSync(`${target}.tmp`, `${Date.now()}\n`);
        fs.renameSync(`${target}.tmp`, target);
    } catch {
        // An unwritable mailbox costs the supervisor this heartbeat; it reads a stale one as a lost agent.
    }
};

// The entrypoint that started this process: the only pid it ever signals. A reparented process
// (its entrypoint gone) has a new ppid — the container's init — and TERM to that would end the CLI
// of an unrelated run, so it exits without signalling anyone.
const parentPid = process.ppid;

/** TERM to the entrypoint, once: it forwards the signal to the CLI, as `docker stop` would. */
let terminated = false;
const terminate = () => {
    if (terminated) return;
    terminated = true;
    try {
        process.kill(parentPid, 'SIGTERM');
    } catch {
        // The entrypoint is already gone; so is the run.
    }
};

let supervisorSeen = false;
const tick = () => {
    if (process.ppid !== parentPid) process.exit(0);
    beat();
    if (marker && fs.existsSync(path.join(inDir, 'stop'))) {
        try {
            fs.writeFileSync(marker, 'stop\n');
        } catch {
            // The marker is the hook's; an unwritable one leaves the Stop to the supervisor's kill order.
        }
    }
    if (fs.existsSync(path.join(inDir, 'kill'))) terminate();
    const supervisorBeat = Number.parseInt(readText(path.join(inDir, 'supervisor.alive')) ?? '', 10);
    if (Number.isFinite(supervisorBeat)) {
        supervisorSeen = true;
        // No supervisor, no Stop and nobody to answer a question or drain the transcript: end the run.
        if (Date.now() - supervisorBeat > lostMs) terminate();
    } else if (supervisorSeen) {
        terminate();
    }
};

// No mailbox (a driver without one, or an image run by hand): nothing to beat or to watch.
if (inDir && outDir) {
    fs.mkdirSync(path.join(outDir, 'questions'), { recursive: true });
    tick();
    setInterval(tick, tickMs);
}
