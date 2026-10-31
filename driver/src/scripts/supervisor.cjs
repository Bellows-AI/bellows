// The task supervisor: the trusted container of a run's pod (docker: its container group) that owns
// the attempt's lifecycle — prepare -> setup -> execute -> verify -> publish -> finalize -> report —
// while the agent runs as a separate container it cannot control and the transcript exporter drains
// beside it. The agent's end does not end the supervisor: it drains the exporter, finalizes and
// reports, then exits. It holds the attempt's control credential and has no Kubernetes API access;
// everything it exchanges with the other containers is a file in a directory only the two sides
// mount (driver/src/supervisor-contract.ts names them):
//
//   <root>/in      supervisor writes, the agent reads: `stop`, `kill`, `answers/<id>.json`, `supervisor.alive`
//   <root>/out     the agent writes, the supervisor reads: `questions/<id>.json`, `agent.alive`, `agent.exit`
//   <root>/export  supervisor <-> exporter: `drain.json`, `status.json`, `supervisor.alive`
//   <root>/supervisor  the supervisor's own state: `state.json`, `report.json`, the step ledger; no other container mounts it
//   <root>/gate    supervisor <-> gate container: `requests/`, `running/`, `done/`, `alive` (`GATE_FILES` below)
//   <root>/review  supervisor <-> reviewer container (issue #774): the same layout, served beside the gates
//
// The group lives for the whole attempt, not just the agent's run. The driver submits STEPS to it —
// the startup sync, the tree probe, the review snapshot, the publish steps, the allowlisted helpers
// and the terminal reclaim — and the supervisor pulls them (`GET /step`, a long poll), runs each as
// a child process of its own container over the task volume it mounts, and answers (`POST /step/:id`).
// A `gate` step (the declared gates and setup) is not a child of this container: it is handed to the
// gate container through the gate mailbox, served beside the other steps rather than before them — a
// ten-minute suite never holds a publish behind it — one at a time, bounded by its own deadline, and
// cancelled by the driver through the control poll, never the step queue. A `review` step (one named
// reviewer's run) rides the same machinery to the reviewer container, in a lane of its own.
// Two steps are the group's own orders: `go` releases the agent (the supervisor writes `in/go`, the
// agent's entrypoint waits on it) and `finish` ends the group. A step's id is its effect and its
// `invocation` one call of it, both kept in a ledger under the supervisor's own directory: an effect
// that landed never runs again, a call already taken is answered as it ended and never runs twice,
// and only a new call of an effect that has not landed runs. The step environment (the claim env, a
// publish token) reaches only these child processes; the agent container has no route to the
// endpoint and no copy of it.
//
// Once the agent is over and the exporter drained, the report goes to the driver under one id,
// redelivered until acknowledged and kept on the supervisor's own volume. It says whether the group
// still serves steps: an attempt the supervisor ended itself (a kill, the budget, a full spool) stops
// pulling, reports `serving: false` and finalizes, interrupting a step still running — so nothing
// the driver still asks waits on a group that left.
//
// Stages the driver still performs today (environment setup, the declared gates) and the publish
// ledger are DELEGATED: this machine never records them as done, so a failure or a cancellation
// that enters `finalize` cannot imply a verification or a publication that did not happen — and a
// `publish` step is refused outright once the attempt ended any way but completed.
//
// Environment (the driver sets these; paths, budgets and the attempt's control pair):
//   FACTORY_CTL_ROOT          — the mailbox root (default /factory).
//   SUPERVISOR_CONTROL_URL / SUPERVISOR_CONTROL_TOKEN — the driver's run-control endpoint; absent on
//                               an attempt with none, which then has no Stop, questions or exporter.
//   SUPERVISOR_AGENT_TOKEN    — the agent's token on the driver; the agent relay attaches it (absent: no agent relay).
//   SUPERVISOR_EXPORT_TOKEN   — the exporter's token on the driver; the export relay attaches it (absent: no export relay).
//   SUPERVISOR_RELAY_TIMEOUT_MS — how long one relayed request may take, end to end (default 900000).
//   SUPERVISOR_CONTROL_MS     — the driver poll period (default 5000).
//   SUPERVISOR_TICK_MS        — the mailbox period (default 500).
//   SUPERVISOR_DEADLINE_MS    — the run budget, paused while a question waits; absent = unbounded.
//   SUPERVISOR_DRAIN_MS       — how long the exporter may take to drain (default 300000).
//   SUPERVISOR_AGENT_LOST_MS  — a seen agent heartbeat older than this is a lost agent (default 30000).
//   SUPERVISOR_AGENT_START_MS — how long the agent may take to show a first heartbeat (default 600000).
//                               The driver's reading of the agent container ended (`GET /control` answers `agentEnded`)
//                               with no exit marker is a lost agent at once, inside both windows (#920).
//   SUPERVISOR_EXPORTS        — `1` when an exporter container waits for the drain order.
//   SUPERVISOR_AGENTLESS      — `1` for an attempt with no agent container: no `go` is awaited.
//   SUPERVISOR_ORPHAN_MS      — how long an unanswering driver is served before finalizing (default 90000).
//   SUPERVISOR_TAKEOVER_MS    — the same once the agent was released and a binding file can name a newer holder (default: the orphan bound).
//   SUPERVISOR_STEP_WAIT_MS   — one `GET /step` long poll (default 15000).
//   SUPERVISOR_REPORT_MS      — how long a departure's report is redelivered before finalizing (default 60000).
//   SUPERVISOR_GIT_HARDEN_SCRIPT — scripts/git-harden.cjs by content: the `git` first on every step's PATH, so a step never
//                               runs what the agent-writable checkout's config names (a tree without it uses the file beside this one).
//   SUPERVISOR_CHECKPOINT_SCRIPT / _CHECKOUT / _BRANCH / _BASE / _DIR / _OPENCODE_DB — the checkpoint the finalize stage
//                               takes (issue #775): scripts/checkpoint.cjs by content, the task tree and branch it
//                               works on, the directory it writes in, the OpenCode database to snapshot. Absent
//                               the script, the checkout, the branch or the directory: no checkpoint.
//   SUPERVISOR_CHECKPOINT_MS  — the one wall-clock bound over the checkpoint's script, chunks, retries and manifest (default 120000).
//   SUPERVISOR_GATE           — `1` when a gate container serves the gate mailbox; absent, a gate step is refused.
//   SUPERVISOR_REVIEWER       — `1` when a reviewer container serves the review mailbox; absent, a review step is refused.
//   SUPERVISOR_GATE_LOST_MS   — a gate loop heartbeat older than this is a lost gate container (default 30000).
//   SUPERVISOR_GATE_CANCEL_MS — how long a cancelled gate may take to answer (default 10000).
//
// Exit status: 0 finalized, 124 finalized after the run budget ended the agent, 70 the supervisor
// itself failed, 75 the driver was lost before the agent was released (nothing ran to adopt). The
// agent's own exit code is the kubelet's (or docker's) to report, never ours.
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { pipeline, Transform } = require('node:stream');

const STAGES = ['prepare', 'setup', 'execute', 'verify', 'publish', 'finalize', 'report'];
/** Stages the driver performs until the supervisor takes them over: never recorded as performed here. */
const DELEGATED = ['setup', 'verify', 'publish'];
const TRANSITIONS = {
    prepare: ['setup', 'finalize'],
    setup: ['execute', 'finalize'],
    execute: ['verify', 'finalize'],
    verify: ['publish', 'finalize'],
    publish: ['finalize'],
    finalize: ['report'],
    report: [],
};
/** How an attempt ended; only `completed` may be followed by a driver-side verification. */
const OUTCOMES = ['completed', 'failed', 'cancelled', 'timed_out', 'lost'];

/**
 * The agent's own directory inside `in` and `out` (`AGENT_MAILBOX_DIR` of supervisor-contract.ts),
 * created owner-only before the agent is released: its tools run as their own uid (issue #814).
 */
const AGENT_DIR = 'agent';
const AGENT_DIR_MODE = 0o700;
/** The review mailbox is served by another uid of this group (REVIEWER_UID, issue #774): its directories and requests are group-writable. */
const REVIEW_DIR_MODE = 0o775;
/** A review's env file is its credential: readable by that group, never written. */
const REVIEW_ENV_MODE = 0o640;
/** A gate request's env file: its owner alone. */
const GATE_ENV_MODE = 0o600;

const FILES = {
    stop: 'stop',
    kill: 'kill',
    answers: 'answers',
    questions: 'questions',
    agentAlive: 'agent.alive',
    agentExit: 'agent.exit',
    supervisorAlive: 'supervisor.alive',
    drain: 'drain.json',
    exportStatus: 'status.json',
    state: 'state.json',
    go: 'go',
    steps: 'steps',
    report: 'report.json',
    relay: 'control.sock',
};
/** The supervised steps, by kind; the two last are the group's own orders (`STEP_KINDS` of supervisor-contract.ts). */
const STEP_KINDS = [
    'sync',
    'reclaim',
    'probe',
    'snapshot',
    'publish',
    'helper',
    'gate',
    'review',
    'restart',
    'go',
    'finish',
];
/** The gate mailbox's layout (`GATE_FILES` of supervisor-contract.ts; scripts/gate-loop.sh spells the same). */
const GATE_FILES = {
    staging: 'staging',
    requests: 'requests',
    running: 'running',
    done: 'done',
    alive: 'alive',
    command: 'command',
    cwd: 'cwd',
    env: 'env',
    output: 'output',
    exit: 'exit',
    cancel: 'cancel',
};
/** A name `sh` can export: the gate loop applies the env with `export "$line"`. */
const GATE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** How much of a refused env name its refusal quotes. */
const ENV_NAME_PREVIEW = 64;
/** The step kinds a container other than this one runs, each in a lane of its own: one at a time, answered beside the rest. */
const LANES = ['gate', 'review'];
/** What a gate the driver cancelled answers — discarded by the driver that cancelled it. */
const GATE_CANCELLED_EXIT = 130;
const STEP_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const STEP_OUTPUT_LIMIT = 1_048_576;
/** The exit a step the supervisor refused (or could not start) answers with: `sh`'s "cannot execute". */
const STEP_REFUSED_EXIT = 126;
/** A step writes the tree the tool uid shares through group 1000 (issue #814). */
const STEP_UMASK = 0o002;
const STEP_RESULT_ATTEMPTS = 5;
const EXIT_DEADLINE = 124;
const EXIT_SUPERVISOR_FAILED = 70;
const EXIT_DRIVER_LOST = 75;
const EXIT = { finalized: 0, deadline: EXIT_DEADLINE, failed: EXIT_SUPERVISOR_FAILED, lost: EXIT_DRIVER_LOST };
const CAUSE = {
    killed: 'agent_killed',
    timeout: 'timeout',
    spoolFull: 'artifact_spool_full',
    closed: 'control_closed',
    lost: 'agent_lost',
    orphaned: 'driver_lost',
};
/** Exit statuses that say the agent was killed rather than finishing: SIGKILL and SIGTERM. */
const EXIT_SIGKILL = 137;
const EXIT_SIGTERM = 143;
const KILLED_EXITS = [EXIT_SIGKILL, EXIT_SIGTERM];

const QUESTION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const QUESTION_MAX_BYTES = 65_536;
const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAVAILABLE = 503;
const HTTP_SERVER_ERROR = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const REPORT_PREFIX = 'FACTORY_SUPERVISOR_REPORT ';
/** Logged once when the agent is released: the evidence a newer claim reads to take a running agent over (#829). */
const RELEASED_LINE = 'supervisor: released the agent';
/** Logged once when the group stops serving the driver's steps: a newer claim reads its absence as "still serving" (#829). */
const SERVED_LINE = 'supervisor: stopped serving the steps';
const STEP_PATH = '/step';
const REPORT_PATH = '/report';

const DEFAULT_CONTROL_MS = 5000;
const DEFAULT_TICK_MS = 500;
const DEFAULT_DRAIN_MS = 300_000;
const DEFAULT_AGENT_LOST_MS = 30_000;
const DEFAULT_AGENT_START_MS = 600_000;
const DEFAULT_ORPHAN_MS = 90_000;
const DEFAULT_STEP_WAIT_MS = 15_000;
const DEFAULT_REPORT_MS = 60_000;
const DEFAULT_CHECKPOINT_MS = 120_000;
const CHECKPOINT_CHUNK_BYTES = 1_048_576;
const CHECKPOINT_UPLOAD_FAILED = 'upload_failed';
const DEFAULT_GATE_LOST_MS = 30_000;
const DEFAULT_GATE_CANCEL_MS = 10_000;
/** A relayed publish waits for the whole answer (a supervised step allows 600s): this is that and headroom. */
const DEFAULT_RELAY_MS = 900_000;

/** The lifecycle machine: legal transitions only, and a record of what really ran. */
function createMachine(initial = 'prepare') {
    const history = [initial];
    let outcome = null;
    let cause = null;
    return {
        get stage() {
            return history[history.length - 1];
        },
        get outcome() {
            return outcome;
        },
        get cause() {
            return cause;
        },
        history: () => [...history],
        /** Moves to `next`; an illegal move throws, so a bug cannot silently skip a stage. */
        enter(next) {
            const from = history[history.length - 1];
            if (!TRANSITIONS[from].includes(next)) throw new Error(`illegal transition ${from} -> ${next}`);
            history.push(next);
        },
        /** The failure and cancellation path: straight to finalize, naming why, never through verify or publish. */
        abort(why, because) {
            if (!OUTCOMES.includes(why) || why === 'completed') throw new Error(`not an abort outcome: ${why}`);
            outcome = outcome ?? why;
            cause = cause ?? because ?? null;
            if (history[history.length - 1] === 'finalize' || history[history.length - 1] === 'report') return;
            history.push('finalize');
        },
        complete() {
            outcome = outcome ?? 'completed';
        },
        /** The stages this process performed, and the ones the driver still performs for it. */
        performed: () => history.filter((s) => !DELEGATED.includes(s)),
        delegated: () => DELEGATED.filter((s) => history.includes(s)),
    };
}

const positive = (env, name, fallback) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

const readJson = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};

/** Atomic: the reader sees the old file or the whole new one, never half of it. */
const writeAtomic = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
};

// A stop (the optional signal `supervise` takes) wakes the sleep early. Captured at load: fake timers must not freeze it.
const yieldMacrotask = setImmediate;
const sleep = (ms, run) =>
    new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            run.stop.signal.removeEventListener('abort', done);
            resolve();
        }
        // Already stopped: still a macrotask, so a loop that sleeps in a hot cycle cannot starve the event loop.
        if (run.stop.signal.aborted) yieldMacrotask(done);
        else run.stop.signal.addEventListener('abort', done, { once: true });
    });

/** The checkpoint this attempt takes at finalize, or null when the driver configured none. */
function checkpointOf(env) {
    const script = env.SUPERVISOR_CHECKPOINT_SCRIPT;
    const checkout = env.SUPERVISOR_CHECKPOINT_CHECKOUT;
    const branch = env.SUPERVISOR_CHECKPOINT_BRANCH;
    const dir = env.SUPERVISOR_CHECKPOINT_DIR;
    if (!script || !checkout || !branch || !dir) return null;
    return {
        script,
        checkout,
        branch,
        dir,
        base: env.SUPERVISOR_CHECKPOINT_BASE || '',
        opencodeDb: env.SUPERVISOR_CHECKPOINT_OPENCODE_DB || '',
    };
}

function settingsOf(env) {
    const root = env.FACTORY_CTL_ROOT || '/factory';
    return {
        root,
        dirs: {
            in: path.join(root, 'in'),
            out: path.join(root, 'out'),
            export: path.join(root, 'export'),
            own: path.join(root, 'supervisor'),
            gate: path.join(root, 'gate'),
            review: path.join(root, 'review'),
        },
        url: env.SUPERVISOR_CONTROL_URL || null,
        token: env.SUPERVISOR_CONTROL_TOKEN || null,
        // The tokens the relays attach: the agent and the exporter hold none, only this supervisor does.
        agentToken: env.SUPERVISOR_AGENT_TOKEN || null,
        exportToken: env.SUPERVISOR_EXPORT_TOKEN || null,
        relayMs: positive(env, 'SUPERVISOR_RELAY_TIMEOUT_MS', DEFAULT_RELAY_MS),
        // The claim this binding belongs to, and the file a newer holder names itself in; no claim, no following.
        claimSeq: /^\d{1,15}$/.test(env.SUPERVISOR_CLAIM_SEQ ?? '') ? Number(env.SUPERVISOR_CLAIM_SEQ) : null,
        bindingFile: env.SUPERVISOR_BINDING_FILE || null,
        controlMs: positive(env, 'SUPERVISOR_CONTROL_MS', DEFAULT_CONTROL_MS),
        tickMs: positive(env, 'SUPERVISOR_TICK_MS', DEFAULT_TICK_MS),
        deadlineMs: positive(env, 'SUPERVISOR_DEADLINE_MS', 0),
        drainMs: positive(env, 'SUPERVISOR_DRAIN_MS', DEFAULT_DRAIN_MS),
        agentLostMs: positive(env, 'SUPERVISOR_AGENT_LOST_MS', DEFAULT_AGENT_LOST_MS),
        agentStartMs: positive(env, 'SUPERVISOR_AGENT_START_MS', DEFAULT_AGENT_START_MS),
        exports: env.SUPERVISOR_EXPORTS === '1',
        agentless: env.SUPERVISOR_AGENTLESS === '1',
        orphanMs: positive(env, 'SUPERVISOR_ORPHAN_MS', DEFAULT_ORPHAN_MS),
        // How long a RELEASED group waits for a newer holder (#829): its agent is the work to adopt.
        takeoverMs: positive(env, 'SUPERVISOR_TAKEOVER_MS', positive(env, 'SUPERVISOR_ORPHAN_MS', DEFAULT_ORPHAN_MS)),
        stepWaitMs: positive(env, 'SUPERVISOR_STEP_WAIT_MS', DEFAULT_STEP_WAIT_MS),
        reportMs: positive(env, 'SUPERVISOR_REPORT_MS', DEFAULT_REPORT_MS),
        checkpointMs: positive(env, 'SUPERVISOR_CHECKPOINT_MS', DEFAULT_CHECKPOINT_MS),
        checkpoint: checkpointOf(env),
        // The hardened git every step's `git` resolves to (scripts/git-harden.cjs), by content.
        gitHarden: env.SUPERVISOR_GIT_HARDEN_SCRIPT || null,
        gate: env.SUPERVISOR_GATE === '1',
        review: env.SUPERVISOR_REVIEWER === '1',
        gateLostMs: positive(env, 'SUPERVISOR_GATE_LOST_MS', DEFAULT_GATE_LOST_MS),
        gateCancelMs: positive(env, 'SUPERVISOR_GATE_CANCEL_MS', DEFAULT_GATE_CANCEL_MS),
        // A step's children get the image's environment and the step's own: never the supervisor's credential.
        childEnv: Object.fromEntries(
            Object.entries({ ...process.env, ...env }).filter(([name]) => !name.startsWith('SUPERVISOR_'))
        ),
    };
}

/** Where each file of the mailboxes lives, from the settings' directories. */
function filesOf({ dirs }) {
    const agentIn = path.join(dirs.in, AGENT_DIR);
    const agentOut = path.join(dirs.out, AGENT_DIR);
    return {
        agentIn,
        agentOut,
        stop: path.join(agentIn, FILES.stop),
        kill: path.join(agentIn, FILES.kill),
        answers: path.join(agentIn, FILES.answers),
        questions: path.join(agentOut, FILES.questions),
        agentAlive: path.join(agentOut, FILES.agentAlive),
        agentExit: path.join(agentOut, FILES.agentExit),
        alive: [path.join(agentIn, FILES.supervisorAlive), path.join(dirs.export, FILES.supervisorAlive)],
        drain: path.join(dirs.export, FILES.drain),
        exportStatus: path.join(dirs.export, FILES.exportStatus),
        state: path.join(dirs.own, FILES.state),
        go: path.join(agentIn, FILES.go),
        ledger: path.join(dirs.own, FILES.steps),
        report: path.join(dirs.own, FILES.report),
        gate: Object.fromEntries(Object.entries(GATE_FILES).map(([key, name]) => [key, path.join(dirs.gate, name)])),
        review: Object.fromEntries(
            Object.entries(GATE_FILES).map(([key, name]) => [key, path.join(dirs.review, name)])
        ),
    };
}

/**
 * One call to the driver's control endpoint; null is "unreachable", never an answer. A call that
 * returns at all — whatever the status — is the driver being there (`run.contactedAt`), which the
 * orphan bound reads. `holdMs` is the long poll's own wait on top of the usual timeout.
 */
async function call(settings, method, route, { body, bytes, holdMs = 0, abort = null, onContact = null } = {}) {
    try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS + holdMs);
        const response = await fetch(`${settings.url}${route}`, {
            method,
            headers: { authorization: `Bearer ${settings.token}` },
            body: bytes ?? (body ? JSON.stringify(body) : undefined),
            signal: abort ? AbortSignal.any([timeout, abort]) : timeout,
        });
        if (onContact) onContact();
        let json = null;
        try {
            json = await response.json();
        } catch {
            // An empty body carries no state; the status alone decides.
        }
        return { status: response.status, json };
    } catch {
        return null;
    }
}

/**
 * One run's state: the settings, the machine, and what the loops below note while the agent runs.
 * `intent` is why the attempt is being ended, noted while the agent still runs — the machine only
 * enters finalize once the agent is gone.
 */
function newRun(settings, now, log) {
    const startedAt = now();
    return {
        settings,
        now,
        log,
        file: filesOf(settings),
        machine: createMachine('prepare'),
        startedAt,
        questions: new Map(), // id -> { posted, settled }
        stopRaised: false,
        killRaised: null,
        agentSeenAt: null,
        agentEnded: false, // the driver read the agent container over (#920); true is sticky, never a verdict on its own
        agentEnd: null, // { exitCode: number | null, how: 'exit' | 'lost' }
        closed: false,
        intent: null,
        lastControlAt: 0,
        budget: settings.deadlineMs,
        budgetStartedAt: startedAt,
        budgetPaused: false,
        // The steps: when the agent was released, whether the driver ordered the end, and the last
        // time the driver answered anything (the orphan bound reads it).
        goAt: null,
        finishRequested: false,
        contactedAt: startedAt,
        // The holder this supervisor answers to: it follows a newer one (`followBinding`), and a request
        // of an older generation never lands (`ask`). `bindingAbort` ends the old holder's requests.
        binding: {
            claimSeq: settings.claimSeq,
            url: settings.url,
            token: settings.token,
            agentToken: settings.agentToken,
            exportToken: settings.exportToken,
            // Known only once a newer holder names it: the first claim's helpers hold their own pair.
            leaseToken: null,
        },
        bindingGen: 0,
        bindingAbort: new AbortController(),
        refusedBinding: null,
        abort: new AbortController(),
        stop: new AbortController(),
        // The relay servers by role, and how many requests each has in flight (`serveRelay`).
        relays: { agent: { server: null, active: 0 }, export: { server: null, active: 0 } },
        // Aborted when the group stops taking steps; `inflight` interrupts the one still running.
        pulling: new AbortController(),
        inflight: null,
        // The gate and review steps, a lane each (`newLane`).
        lanes: { gate: newLane(), review: newLane() },
        // The report once minted, the `serving` the driver acknowledged it with, and its redelivery.
        report: null,
        reportAcked: null,
        reportRefused: false,
        reportTries: 0,
        reportDueAt: 0,
    };
}

/**
 * A call to the current holder on this run's behalf: it ends with the run or with the holder it was
 * made to (or with the external stop, a test-only signal), and an answer counts as contact. An answer that lands after a rebind is dropped as if
 * the call never returned: the old holder neither hands a step nor counts as contact.
 */
async function ask(run, method, route, options = {}) {
    const gen = run.bindingGen;
    const abort = AbortSignal.any([
        run.abort.signal,
        run.bindingAbort.signal,
        run.stop.signal,
        ...(options.abort ? [options.abort] : []),
    ]);
    const answer = await call(run.binding, method, route, {
        ...options,
        abort,
        onContact: () => {
            if (run.bindingGen === gen) run.contactedAt = run.now();
        },
    });
    return run.bindingGen === gen ? answer : null;
}

/**
 * A released group with a binding file to be followed waits for a newer holder (#829): its agent is
 * the work a takeover adopts. A group never released, or one no holder can name itself to, is redone.
 */
const waitsForHolder = (run) => run.goAt !== null && !run.settings.agentless && Boolean(run.settings.bindingFile);

/** The driver stopped answering for longer than the orphan bound (the takeover bound once released): nobody is left to give this group orders. */
const orphaned = (run) =>
    run.stop.signal.aborted ||
    (Boolean(run.binding.url) &&
        run.now() - run.contactedAt > (waitsForHolder(run) ? run.settings.takeoverMs : run.settings.orphanMs));

/** A binding file's text as a binding strictly newer than `claimSeq`; null for anything else. */
function newerBinding(text, claimSeq) {
    let named;
    try {
        named = JSON.parse(text);
    } catch {
        return null;
    }
    if (named === null || typeof named !== 'object' || Array.isArray(named)) return null;
    if (!Number.isSafeInteger(named.claimSeq) || named.claimSeq <= claimSeq) return null;
    // The control token, the two the relays attach and the claim's lease: a holder that names fewer is not followed.
    for (const field of ['token', 'agentToken', 'exportToken', 'leaseToken']) {
        if (typeof named[field] !== 'string' || !/^\S{1,256}$/.test(named[field])) return null;
    }
    try {
        if (!['http:', 'https:'].includes(new URL(named.url).protocol)) return null;
    } catch {
        return null;
    }
    return {
        claimSeq: named.claimSeq,
        url: named.url,
        token: named.token,
        agentToken: named.agentToken,
        exportToken: named.exportToken,
        leaseToken: named.leaseToken,
    };
}

/**
 * Follows a newer holder named in the binding file: a driver that took the task over writes its
 * claim there. Only a strictly newer, well-formed binding moves this supervisor; an unreadable,
 * partial or older one keeps the holder it has (never unbinds, never closes). The old holder's
 * requests are aborted, the report and the pending questions are delivered again to the new one,
 * and its orphan bound starts afresh. Nothing logged names the url or the token.
 */
function followBinding(run) {
    const { bindingFile } = run.settings;
    if (!bindingFile || run.binding.claimSeq === null || !run.binding.url || run.closed) return;
    let text;
    try {
        text = fs.readFileSync(bindingFile, 'utf8');
    } catch {
        return;
    }
    const next = newerBinding(text, run.binding.claimSeq);
    if (!next) {
        if (text !== run.refusedBinding && text !== '')
            run.log('supervisor: ignored a binding that names no newer holder');
        run.refusedBinding = text;
        return;
    }
    run.bindingAbort.abort();
    run.bindingAbort = new AbortController();
    run.bindingGen += 1;
    run.binding = next;
    // The file still names this holder: on the next read it is known, not ignored.
    run.refusedBinding = text;
    run.contactedAt = run.now();
    run.reportAcked = null;
    run.reportRefused = false;
    run.reportTries = 0;
    run.reportDueAt = 0;
    if (run.report) keepReport(run);
    for (const known of run.questions.values()) known.posted = false;
    run.log(`supervisor: rebound to claim ${next.claimSeq}`);
}

const ledgerFile = (run, id) => path.join(run.file.ledger, `${encodeURIComponent(id)}.json`);

/**
 * The tail of a stream whose JSON form fits the step output cap. Escaping can turn one byte into six
 * (a NUL is `\u0000`), and the driver bounds the answer body, not the bytes a command printed.
 */
function fitTail(text) {
    let tail = text;
    for (let size = Buffer.byteLength(JSON.stringify(tail)); size > STEP_OUTPUT_LIMIT; ) {
        tail = tail.slice(Math.ceil((tail.length * (size - STEP_OUTPUT_LIMIT)) / size) + 1);
        size = Buffer.byteLength(JSON.stringify(tail));
    }
    return tail;
}

const stepResult = (exitCode, stdout = '', stderr = '', timedOut = false) => ({
    exitCode,
    stdout: fitTail(stdout),
    stderr: fitTail(stderr),
    timedOut,
});

/** Keeps the tail of a stream at the step output cap, byte-true enough: the cap is a bound, not a format. */
const keepTail = (text) => (text.length <= STEP_OUTPUT_LIMIT ? text : text.slice(text.length - STEP_OUTPUT_LIMIT));

/**
 * Runs one command step as a child process group of this container; its streams and exit are the
 * answer, and `interrupted` says the supervisor killed it on its way out (`run.inflight`).
 */
/**
 * The control endpoint and its bearer, for the steps that ask for them: the checkpoint restore (RESTORE_FEED=1,
 * issue #775) reads the thread's checkpoint through the driver's `/checkpoint/restore` route, and the input fetch
 * (INPUT_FEED=1) reads the task's files through `/input`. A step that sets neither — every publish, helper and
 * other sync — never sees the supervisor's token.
 */
function controlFeed(run, step) {
    if (!step.env || (step.env.RESTORE_FEED !== '1' && step.env.INPUT_FEED !== '1')) return {};
    return { RESTORE_URL: run.settings.url || '', RESTORE_TOKEN: run.settings.token || '' };
}

/** The first `git` executable on `pathList`, or null. */
function findGit(pathList) {
    for (const dir of (pathList || '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, 'git');
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
            // Not here.
        }
    }
    return null;
}

/**
 * The hardened `git` for this supervisor's steps: `scripts/git-harden.cjs` written as an executable
 * `git` into a private directory that goes first on every step's PATH. The checkout is written by the
 * agent's tool uid, so a step's git must not run what the checkout's config names (docs/security.md).
 * Null when there is no `git` to front (nothing to harden); throws when there is one and no script.
 */
function gitShimOf(settings) {
    if (settings.gitShim !== undefined) return settings.gitShim;
    const real = findGit(settings.childEnv.PATH);
    if (!real) {
        settings.gitShim = null;
        return null;
    }
    // The script rides the env; a dev tree or a test has the file beside this one.
    const source = settings.gitHarden ?? fs.readFileSync(path.join(__dirname, 'git-harden.cjs'), 'utf8');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-git-'));
    fs.writeFileSync(path.join(dir, 'git'), `#!${process.execPath}\n${source}`, { mode: 0o755 });
    process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
    settings.gitShim = { dir, real };
    return settings.gitShim;
}

/** A step's environment: the image's, the step's own, and the hardened git first on PATH. */
function stepEnv(run, step) {
    const env = { ...run.settings.childEnv, ...step.env, ...controlFeed(run, step) };
    const shim = gitShimOf(run.settings);
    if (!shim) return env;
    return { ...env, PATH: `${shim.dir}${path.delimiter}${env.PATH ?? ''}`, GIT_HARDEN_REAL: shim.real };
}

function spawnStep(run, step) {
    return new Promise((resolve) => {
        const [exe, ...args] = step.argv;
        let child;
        let env;
        try {
            env = stepEnv(run, step);
        } catch (error) {
            const why = `no hardened git: ${error?.message ?? error}`;
            resolve({ result: stepResult(STEP_REFUSED_EXIT, '', why), interrupted: false });
            return;
        }
        // The agent's tools run as their own uid in group 1000 (issue #814), so a step writes the
        // tree group-writable. The child takes the umask at its fork; this process keeps its own.
        const umask = process.umask(STEP_UMASK);
        try {
            child = spawn(exe, args, {
                cwd: step.cwd || undefined,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true,
            });
        } catch (error) {
            resolve({ result: stepResult(STEP_REFUSED_EXIT, '', String(error?.message ?? error)), interrupted: false });
            return;
        } finally {
            process.umask(umask);
        }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let interrupted = false;
        let settled = false;
        const settle = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            run.stop.signal.removeEventListener('abort', interrupt);
            run.inflight = null;
            resolve({ result, interrupted });
        };
        const killGroup = () => {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                // The group is already gone.
            }
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup();
        }, step.timeoutMs);
        const interrupt = () => {
            interrupted = true;
            killGroup();
        };
        run.inflight = { interrupt };
        // The external stop (tests; production passes none) reaches a child spawned after the one-shot
        // `run.inflight?.interrupt()` of the teardown, such as the checkpoint's.
        if (run.stop.signal.aborted) interrupt();
        else run.stop.signal.addEventListener('abort', interrupt, { once: true });
        child.stdout.on('data', (chunk) => {
            stdout = keepTail(stdout + chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr = keepTail(stderr + chunk);
        });
        child.on('error', (error) => settle(stepResult(STEP_REFUSED_EXIT, stdout, `${stderr}${error.message}`)));
        child.on('close', (code) => settle(stepResult(code, stdout, stderr, timedOut)));
    });
}

/**
 * One lane's state: its steps one at a time (`turn`), each call joined by a redelivery of it while it
 * runs (`calls`), the ones the driver cancelled (`cancels`, read off the control poll), their
 * answers still being delivered (`answers`), and the order to stop them all.
 */
function newLane() {
    return {
        turn: Promise.resolve(),
        calls: new Map(),
        cancels: new Set(),
        answers: new Set(),
        inFlight: 0,
        stopped: false,
    };
}

/** A word a shell reads back as one argument: single-quoted, a quote inside closed and reopened. */
const shellQuote = (word) => `'${word.replace(/'/g, `'\\''`)}'`;

/** What a lane's container runs for a step: a gate's one command, or a review's argv as one quoted line. */
const laneCommand = (step) => (step.kind === 'review' ? step.argv.map(shellQuote).join(' ') : step.argv[0]);

/** Why a lane's step carries no usable command, or null: a gate's one command, a review's argv. */
function commandRefusal(step) {
    if (step.kind === 'gate') {
        const oneCommand = step.argv.length === 1 && typeof step.argv[0] === 'string' && step.argv[0] !== '';
        return oneCommand ? null : 'a gate step carries exactly one command';
    }
    const words = step.argv.length > 0 && step.argv.every((word) => typeof word === 'string' && !/\0/.test(word));
    return words ? null : 'a review step carries its command as argv';
}

/** Why a gate or review step cannot be handed to its container, or null: what the loop could not run as asked. */
function gateRefusal(run, step) {
    const lane = step.kind;
    if (!run.settings[lane]) {
        return lane === 'gate'
            ? 'this group has no gate container: its checkout declares no gates'
            : 'this group has no reviewer container: its claim lists no reviewer profile';
    }
    const unusable = commandRefusal(step);
    if (unusable) return unusable;
    if (typeof step.cwd !== 'string' || !path.isAbsolute(step.cwd) || /[\n\0]/.test(step.cwd)) {
        return `a ${lane} step needs the absolute path of its worktree`;
    }
    for (const [name, value] of Object.entries(step.env ?? {})) {
        if (!GATE_ENV_NAME.test(name)) {
            return `the ${lane} env name "${name.slice(0, ENV_NAME_PREVIEW)}" cannot be exported by sh`;
        }
        if (typeof value !== 'string' || /[\n\0]/.test(value))
            return `the ${lane} env value of ${name} holds a newline`;
    }
    return null;
}

/** The last `STEP_OUTPUT_LIMIT` bytes of a file: what a suite printed, its tail kept. */
function readTail(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, STEP_OUTPUT_LIMIT);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        return buffer.toString('utf8');
    } catch {
        return '';
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

/** The answer of a finished request (`done/<id>`), read and removed; null while it is not done. */
function takeGateAnswer(run, lane, name) {
    const done = path.join(run.file[lane].done, name);
    if (!fs.existsSync(done)) return null;
    let code = Number.NaN;
    try {
        code = Number.parseInt(fs.readFileSync(path.join(done, GATE_FILES.exit), 'utf8').trim(), 10);
    } catch {
        // No exit: the loop restarted while it held the request, and its answer is gone.
    }
    const answer = {
        exitCode: Number.isFinite(code) ? code : null,
        output: readTail(path.join(done, GATE_FILES.output)),
    };
    fs.rmSync(done, { recursive: true, force: true });
    return answer;
}

/** How long the gate loop has been silent: since its last heartbeat, or since the request when it never beat. */
function gateSilentMs(run, lane, since) {
    let beat = since;
    try {
        beat = Math.max(since, fs.statSync(run.file[lane].alive).mtimeMs);
    } catch {
        // No heartbeat yet: silent since the request.
    }
    return run.now() - beat;
}

/**
 * Orders the gate stopped: a request the loop has not taken is withdrawn (true — it never ran), a
 * taken one gets `cancel`, which the loop answers by killing it.
 */
function cancelGate(run, lane, name) {
    const withdrawn = path.join(run.file[lane].staging, `${name}.withdrawn`);
    try {
        fs.renameSync(path.join(run.file[lane].requests, name), withdrawn);
        fs.rmSync(withdrawn, { recursive: true, force: true });
        return true;
    } catch {
        try {
            fs.writeFileSync(path.join(run.file[lane].running, name, GATE_FILES.cancel), 'cancel\n');
        } catch {
            // Already answered: the answer is read on the next tick.
        }
        return false;
    }
}

/** The lane mailboxes' directories this supervisor makes, for each container that serves one. */
const gateDirs = (run) =>
    LANES.filter((lane) => run.settings[lane]).flatMap((lane) => {
        const { staging, requests, running, done } = run.file[lane];
        return [staging, requests, running, done];
    });

/** Stages the request whole and renames it into `requests/`: the loop never sees half of one. */
function postGateRequest(run, step, name) {
    const lane = step.kind;
    const staged = path.join(run.file[lane].staging, name);
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged, { recursive: true });
    const reviewing = lane === 'review';
    if (reviewing) fs.chmodSync(staged, REVIEW_DIR_MODE);
    fs.writeFileSync(path.join(staged, GATE_FILES.command), laneCommand(step));
    fs.writeFileSync(path.join(staged, GATE_FILES.cwd), step.cwd);
    const env = Object.entries(step.env ?? {}).map(([n, v]) => `${n}=${v}\n`);
    fs.writeFileSync(path.join(staged, GATE_FILES.env), env.join(''), {
        mode: reviewing ? REVIEW_ENV_MODE : GATE_ENV_MODE,
    });
    fs.renameSync(staged, path.join(run.file[lane].requests, name));
}

/** Why the supervisor stops a gate it handed over, or null: the driver's cancel, the group's end, the deadline. */
function gateStopReason(run, step, startedAt) {
    const lane = run.lanes[step.kind];
    if (lane.cancels.has(step.id)) return 'cancelled';
    if (lane.stopped) return 'interrupted';
    return run.now() - startedAt >= step.timeoutMs ? 'deadline' : null;
}

/** What a stopped gate answers: the deadline is a verdict (124), a cancel is discarded, an interruption is unknown. */
function stoppedGateResult(why, step, output) {
    const what = step.kind;
    if (why === 'deadline') {
        return {
            result: stepResult(EXIT_DEADLINE, output, `the ${what} exceeded its ${step.timeoutMs}ms deadline`, true),
            interrupted: false,
        };
    }
    if (why === 'cancelled')
        return { result: stepResult(GATE_CANCELLED_EXIT, output, `the ${what} was cancelled`), interrupted: false };
    return {
        result: stepResult(null, output, `the ${what} was interrupted: the group stopped serving`),
        interrupted: true,
    };
}

/** The loop's answer to a request: a stopped gate's (its own output kept), or the gate's own exit. */
function answeredGateResult(why, step, answer) {
    if (why) return stoppedGateResult(why, step, answer.output);
    const lost =
        answer.exitCode === null ? `the ${step.kind} container lost the request mid-run: it answered no exit` : '';
    return { result: stepResult(answer.exitCode, answer.output, lost), interrupted: false };
}

/** A gate loop gone silent: no exit — never a verdict — whether it never took the request or went quiet on it. */
function lostGateResult(run, step) {
    const lost = cancelGate(run, step.kind, step.id)
        ? `the ${step.kind} container never took the request: its loop is not running`
        : `the ${step.kind} container was lost mid-run: its loop stopped answering`;
    return { result: stepResult(null, '', lost), interrupted: false };
}

/**
 * One tick of a gate in flight (`flight`: when it was posted, why it is being stopped and since
 * when): its answer, a stopped gate's past the cancel grace, a lost loop's, or null to wait on.
 */
function gateTick(run, step, flight) {
    const answer = takeGateAnswer(run, step.kind, step.id);
    if (answer) return answeredGateResult(flight.why, step, answer);
    if (!flight.why) {
        flight.why = gateStopReason(run, step, flight.startedAt);
        flight.stoppedAt = run.now();
        // Withdrawn before the loop took it: it never ran, and answers at once.
        if (flight.why && cancelGate(run, step.kind, step.id)) return stoppedGateResult(flight.why, step, '');
    }
    if (flight.why && run.now() - flight.stoppedAt >= run.settings.gateCancelMs) {
        return stoppedGateResult(flight.why, step, '');
    }
    return gateSilentMs(run, step.kind, flight.startedAt) > run.settings.gateLostMs ? lostGateResult(run, step) : null;
}

/**
 * One gate, through the gate mailbox: the request posted, then read every tick until the loop
 * answers. A stop (the driver's cancel, the group's end, the deadline) cancels it and waits at most
 * `gateCancelMs` for the loop's answer. A loop silent past `gateLostMs` is a lost gate container.
 */
async function execGate(run, step) {
    postGateRequest(run, step, step.id);
    const flight = { startedAt: run.now(), why: null, stoppedAt: 0 };
    for (;;) {
        const settled = gateTick(run, step, flight) ?? (run.stop.signal.aborted ? lostGateResult(run, step) : null);
        if (settled) return settled;
        await sleep(run.settings.tickMs, run);
    }
}

/**
 * A gate or review in its turn: one at a time per lane, whatever the driver sends. The turn re-reads
 * the ledger and settles the call inside itself: the call ahead of this one in the lane may have
 * landed the effect, and the next turn must see it.
 */
function runGate(run, step, entry) {
    const lane = run.lanes[step.kind];
    const turn = lane.turn.then(async () => {
        Object.assign(entry, ledgerOf(run, step));
        // The re-read is the disk's: a call ahead in the lane rewrote it from its own entry, without this call's record.
        if (!entry.effect) recordCall(run, entry, step.invocation, { state: 'running' });
        const outcome = entry.effect
            ? { result: { ...entry.effect, replayed: true }, interrupted: false }
            : await execGate(run, step);
        return settleCall(run, entry, step, outcome);
    });
    lane.turn = turn.catch(() => undefined);
    lane.inFlight += 1;
    return turn.finally(() => {
        lane.inFlight -= 1;
        lane.cancels.delete(step.id);
    });
}

/** The `go` order: releases the agent once, unless the attempt is already being ended. */
function orderGo(run, step) {
    if (run.goAt !== null) return stepResult(0);
    if (run.stopRaised || run.killRaised || run.intent) {
        return stepResult(STEP_REFUSED_EXIT, '', 'the attempt is being ended: the agent is not released');
    }
    run.goAt = run.now();
    run.budgetStartedAt = run.goAt;
    // The budget the driver knew only after the sync and the environment setup: what is left of the run's.
    const budget = Number(step.env?.BUDGET_MS);
    if (Number.isFinite(budget) && budget > 0) run.budget = budget;
    writeAtomic(run.file.go, `${run.goAt}\n`);
    run.log(RELEASED_LINE);
    return stepResult(0);
}

/** One step's ledger entry: the result of the call that landed its effect, and every call's own state. */
function ledgerOf(run, step) {
    const entry = readJson(ledgerFile(run, step.id));
    if (entry && typeof entry.invocations === 'object' && entry.invocations !== null) return entry;
    return { id: step.id, kind: step.kind, effect: null, invocations: {} };
}

function recordCall(run, entry, invocation, call) {
    entry.invocations[invocation] = call;
    writeAtomic(ledgerFile(run, entry.id), JSON.stringify(entry));
}

/** The answer to a call that was taken and never answered: the caller reconciles before it calls again. */
const unknownResult = (id) =>
    stepResult(null, '', `step ${id} was interrupted before it answered: whether its effect landed is unknown`);

/** What the ledger answers a call with — an effect that landed, a call already taken — or null: it runs. */
function replayOf(entry, step) {
    if (entry.effect) return { ...entry.effect, replayed: true };
    const prior = entry.invocations[step.invocation];
    if (prior?.state === 'done') return { ...prior.result, replayed: true };
    return prior ? unknownResult(step.id) : null;
}

/** What one step answers with; a refused step never starts. */
async function performStep(run, step) {
    const kind = STEP_KINDS.includes(step?.kind) ? step.kind : null;
    const named =
        STEP_ID.test(String(step?.id)) && typeof step?.invocation === 'string' && STEP_ID.test(step.invocation);
    if (!kind || !named || !Array.isArray(step.argv) || !(step.timeoutMs > 0)) {
        return stepResult(STEP_REFUSED_EXIT, '', 'malformed step');
    }
    if (kind === 'go') return orderGo(run, step);
    if (kind === 'finish') {
        run.finishRequested = true;
        return stepResult(0);
    }
    const gateRefused = LANES.includes(kind) && gateRefusal(run, step);
    if (gateRefused) return stepResult(STEP_REFUSED_EXIT, '', gateRefused);
    // An effect that landed is never run again, whoever asks: that is the harm the ledger prevents. A
    // call already taken is answered as it ended — a failure or a timeout too, which may have half
    // landed — and one taken but never answered is unknown; either way it never runs twice. Only a
    // new call — the caller reconciled against the remote, or a refusal worth retrying was fixed — runs.
    const entry = ledgerOf(run, step);
    const replayed = replayOf(entry, step);
    if (replayed) return replayed;
    // An attempt that ended any way but completed publishes nothing: the machine already went to finalize.
    if (kind === 'publish' && run.machine.outcome !== null && run.machine.outcome !== 'completed') {
        return stepResult(STEP_REFUSED_EXIT, '', `refusing to publish: the attempt ended ${run.machine.outcome}`);
    }
    if (step.argv.length === 0) return stepResult(STEP_REFUSED_EXIT, '', 'a command step needs a command');
    return runCall(run, entry, step);
}

/** Runs a new call — a child of this container, or a gate the gate container runs — its ledger kept as it goes. */
async function runCall(run, entry, step) {
    recordCall(run, entry, step.invocation, { state: 'running' });
    if (LANES.includes(step.kind)) return runGate(run, step, entry);
    return settleCall(run, entry, step, await spawnStep(run, step));
}

/**
 * A gate or review step's output with its injected GitHub token values replaced: the command may echo them,
 * and what the ledger keeps and the driver is answered must never hold one. The one choke point of both executors.
 */
function redactedResult(step, result) {
    if (!LANES.includes(step.kind)) return result;
    const secrets = ['GITHUB_TOKEN', 'GH_TOKEN'].map((name) => step.env?.[name]).filter((value) => value);
    if (secrets.length === 0) return result;
    const redact = (text) => secrets.reduce((kept, secret) => kept.split(secret).join('[redacted]'), text);
    return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
}

/** Records how a call ended: an effect that landed, a call done, or one interrupted. */
function settleCall(run, entry, step, outcome) {
    const { interrupted } = outcome;
    const result = redactedResult(step, outcome.result);
    if (interrupted) {
        recordCall(run, entry, step.invocation, { state: 'interrupted', result });
        return result;
    }
    if (result.exitCode === 0 && !result.timedOut) entry.effect = result;
    recordCall(run, entry, step.invocation, { state: 'done', result });
    return result;
}

/** Posts a call's answer until the driver acknowledges it (or says the attempt is over). */
async function postStepResult(run, step, result, gen) {
    let body = { invocation: step.invocation, ...result };
    // `gen` is the holder the step came from: after a rebind its result stays in the ledger, the new holder redoes the step.
    for (
        let attempt = 1;
        attempt <= STEP_RESULT_ATTEMPTS && !run.abort.signal.aborted && run.bindingGen === gen;
        attempt += 1
    ) {
        const answer = await ask(run, 'POST', `${STEP_PATH}/${encodeURIComponent(step.id)}`, { body });
        if (answer?.status === HTTP_PAYLOAD_TOO_LARGE) {
            // Refused, not taken: the verdict still goes back, without the streams the driver would not hold.
            body = { ...body, stdout: '', stderr: 'the step output was too large to deliver' };
            continue;
        }
        if (answer && answer.status < HTTP_SERVER_ERROR) {
            if (answer.status === HTTP_UNAUTHORIZED) run.closed = true;
            return;
        }
        await sleep(run.settings.tickMs * attempt, run);
    }
}

/**
 * Answers one step. A gate is answered beside the steps that follow it, never before them: it runs
 * for as long as a suite does, and a step queued behind it would outlive its own deadline. A
 * delivery of a gate call still running joins it rather than running it twice.
 */
async function answerStep(run, step) {
    const gen = run.bindingGen;
    if (!LANES.includes(step.kind)) {
        await postStepResult(run, step, await performStep(run, step), gen);
        return;
    }
    const lane = run.lanes[step.kind];
    const call = `${step.id}\n${step.invocation}`;
    const running = lane.calls.get(call);
    const answering = (running ?? performStep(run, step)).then((result) => postStepResult(run, step, result, gen));
    if (!running) {
        const performing = answering.finally(() => lane.calls.delete(call));
        lane.calls.set(
            call,
            performing.then(() => readLedgerResult(run, step))
        );
    }
    lane.answers.add(answering);
    void answering.finally(() => lane.answers.delete(answering));
}

/** The result a call's ledger entry recorded: what a joined delivery of a gate answers. */
function readLedgerResult(run, step) {
    const recorded = ledgerOf(run, step).invocations[step.invocation];
    return recorded?.result ?? unknownResult(step.id);
}

/** Pulls steps from the driver, one at a time, until the group stops taking them. */
async function serveSteps(run) {
    const { settings } = run;
    if (!run.binding.url) return;
    const pulling = AbortSignal.any([run.abort.signal, run.pulling.signal, run.stop.signal]);
    while (!pulling.aborted) {
        const wait = settings.stepWaitMs;
        const answer = await ask(run, 'GET', `${STEP_PATH}?wait=${wait}`, { holdMs: wait, abort: pulling });
        // A step handed over once the group stopped taking steps is dropped unrun: the driver refuses its waiter.
        if (pulling.aborted) return;
        if (!answer || answer.status >= HTTP_SERVER_ERROR) {
            await sleep(settings.tickMs, run);
            continue;
        }
        if (answer.status === HTTP_UNAUTHORIZED) {
            run.closed = true;
            return;
        }
        const step = answer.json?.step;
        if (!step) continue;
        await answerStep(run, step);
    }
}

const intend = (run, outcome, cause) => {
    run.intent = run.intent ?? { outcome, cause };
};

function persist(run) {
    writeAtomic(
        run.file.state,
        JSON.stringify({
            stage: run.machine.stage,
            history: run.machine.history(),
            outcome: run.machine.outcome,
            cause: run.machine.cause,
            agentEnd: run.agentEnd,
            startedAt: new Date(run.startedAt).toISOString(),
        })
    );
}

function beat(run) {
    for (const target of run.file.alive) writeAtomic(target, `${run.now()}\n`);
}

function settle(run, id, answer) {
    const known = run.questions.get(id);
    if (!known || known.settled) return;
    known.settled = true;
    writeAtomic(path.join(run.file.answers, `${id}.json`), JSON.stringify(answer));
}

function cancelQuestions(run) {
    for (const id of run.questions.keys()) settle(run, id, { state: 'cancelled' });
}

function raiseStop(run) {
    if (run.stopRaised) return;
    run.stopRaised = true;
    writeAtomic(run.file.stop, 'stop\n');
    cancelQuestions(run);
}

function raiseKill(run, cause) {
    if (run.killRaised) return;
    run.killRaised = cause;
    raiseStop(run);
    writeAtomic(run.file.kill, `${JSON.stringify({ cause })}\n`);
}

const pendingQuestions = (run) => [...run.questions.values()].some((q) => !q.settled);

/** New question files in the agent's mailbox: registered once, and refused at once when they cannot be asked. */
function scanQuestions(run) {
    let names = [];
    try {
        names = fs.readdirSync(run.file.questions).filter((n) => n.endsWith('.json'));
    } catch {
        return;
    }
    for (const name of names) {
        const id = name.slice(0, -'.json'.length);
        if (!QUESTION_ID.test(id) || run.questions.has(id)) continue;
        let size = 0;
        try {
            size = fs.statSync(path.join(run.file.questions, name)).size;
        } catch {
            continue;
        }
        run.questions.set(id, { posted: false, settled: false });
        if (size > QUESTION_MAX_BYTES) settle(run, id, { state: 'invalid' });
        else if (run.stopRaised) settle(run, id, { state: 'cancelled' });
        else if (!run.binding.url) settle(run, id, { state: 'refused' });
    }
}

/** What the driver's answer to a question POST means: the state to settle with, or null to go on. */
function refusalOf(status) {
    if (status === HTTP_BAD_REQUEST) return 'invalid';
    if (status === HTTP_TOO_MANY_REQUESTS) return 'refused';
    return null;
}

/** POSTs a question once; true when it is posted and may be polled. */
async function postQuestion(run, id, known) {
    const parsed = readJson(path.join(run.file.questions, `${id}.json`));
    const answer = await ask(run, 'POST', '/question', { body: parsed });
    if (!answer) return false;
    if (answer.status === HTTP_UNAUTHORIZED) {
        run.closed = true;
        settle(run, id, { state: 'gone' });
        return false;
    }
    const refused = refusalOf(answer.status);
    if (refused) {
        settle(run, id, { state: refused });
        return false;
    }
    if (answer.status >= HTTP_SERVER_ERROR) return false;
    known.posted = true;
    return true;
}

/** Polls a posted question until a person (or a Stop) settles it. */
async function pollQuestion(run, id, known) {
    const polled = await ask(run, 'GET', `/question/${encodeURIComponent(id)}`);
    if (!polled) return;
    if (polled.status === HTTP_UNAUTHORIZED) {
        run.closed = true;
        settle(run, id, { state: 'gone' });
    } else if (polled.status === HTTP_NOT_FOUND) {
        known.posted = false; // the driver forgot it: ask again
    } else if (polled.status < HTTP_SERVER_ERROR && polled.json) {
        if (polled.json.state === 'answered') settle(run, id, polled.json);
        else if (polled.json.state === 'cancelled') settle(run, id, { state: 'cancelled' });
    }
}

/** The agent's question files: forwarded once, polled until a person (or a Stop) settles them. */
async function serveQuestions(run) {
    scanQuestions(run);
    if (!run.binding.url) return;
    for (const [id, known] of run.questions) {
        if (known.settled) continue;
        if (!known.posted && !(await postQuestion(run, id, known))) continue;
        await pollQuestion(run, id, known);
    }
}

/** The gate steps the driver cancelled, named on the control poll until their answers settle them. */
function takeCancels(run, cancel) {
    for (const id of Array.isArray(cancel) ? cancel : []) {
        if (typeof id === 'string') for (const lane of LANES) run.lanes[lane].cancels.add(id);
    }
}

async function pollControl(run) {
    followBinding(run);
    const { settings } = run;
    // A gate in flight is polled at the mailbox pace: its cancel is the driver's, and it must not wait.
    const pace = LANES.some((lane) => run.lanes[lane].inFlight > 0) ? settings.tickMs : settings.controlMs;
    if (!run.binding.url || run.now() - run.lastControlAt < pace) return;
    run.lastControlAt = run.now();
    const answer = await ask(run, 'GET', '/control');
    if (!answer) return;
    if (answer.status === HTTP_UNAUTHORIZED) {
        run.closed = true;
        return;
    }
    if (answer.json?.stop === true) raiseStop(run);
    if (answer.json?.agentEnded === true) run.agentEnded = true;
    takeCancels(run, answer.json?.cancel);
    if (answer.json?.kill === true) {
        intend(run, 'cancelled', CAUSE.killed);
        raiseKill(run, CAUSE.killed);
    }
}

/** The agent's heartbeat in ms, or null when it has written none. */
function agentBeatMs(run) {
    try {
        const beatMs = Number.parseInt(fs.readFileSync(run.file.agentAlive, 'utf8'), 10);
        return Number.isFinite(beatMs) ? beatMs : null;
    } catch {
        return null;
    }
}

/** Whether the file is confirmed missing: any other failure to read it is inconclusive, never a no. */
function markerAbsent(file) {
    try {
        fs.accessSync(file);
        return false;
    } catch (e) {
        return e?.code === 'ENOENT';
    }
}

/** The agent ended on its own (an exit marker) or was lost (its heartbeat stopped, or never started). */
function watchAgent(run) {
    if (run.agentEnd) return;
    if (fs.existsSync(run.file.agentExit)) {
        const code = Number.parseInt(fs.readFileSync(run.file.agentExit, 'utf8').trim(), 10);
        run.agentEnd = { exitCode: Number.isFinite(code) ? code : null, how: 'exit' };
        return;
    }
    // The driver read the agent container over (#920) and the marker, written before the container ends, is
    // confirmed absent: the agent died before it could write one. A marker that cannot be read says nothing.
    if (run.agentEnded && markerAbsent(run.file.agentExit)) {
        run.agentEnd = { exitCode: null, how: 'lost' };
        return;
    }
    const beatMs = agentBeatMs(run);
    const { settings } = run;
    if (beatMs !== null) run.agentSeenAt = beatMs;
    const stale = beatMs !== null && run.now() - beatMs > settings.agentLostMs;
    const neverStarted = run.agentSeenAt === null && run.now() - (run.goAt ?? run.startedAt) > settings.agentStartMs;
    if (stale || neverStarted) run.agentEnd = { exitCode: null, how: 'lost' };
}

/** The run budget, paused while a question waits for a person. */
function tickBudget(run) {
    if (!run.budget || run.killRaised || run.agentEnd) return;
    const paused = pendingQuestions(run);
    if (paused !== run.budgetPaused) {
        if (paused) run.budget -= run.now() - run.budgetStartedAt;
        else run.budgetStartedAt = run.now();
        run.budgetPaused = paused;
    }
    if (!run.budgetPaused && run.now() - run.budgetStartedAt >= run.budget) {
        intend(run, 'timed_out', CAUSE.timeout);
        raiseKill(run, CAUSE.timeout);
    }
}

function watchExporter(run) {
    if (!run.settings.exports || run.killRaised || run.agentEnd) return;
    if (readJson(run.file.exportStatus)?.spoolFull === true) {
        intend(run, 'failed', CAUSE.spoolFull);
        raiseKill(run, CAUSE.spoolFull);
    }
}

/** execute: until the agent is gone, whatever ended it. */
async function executeUntilAgentEnds(run) {
    while (!run.agentEnd) {
        beat(run);
        await pollControl(run);
        if (run.closed && !run.killRaised) {
            intend(run, 'cancelled', CAUSE.closed);
            raiseKill(run, CAUSE.closed);
        }
        await serveQuestions(run);
        tickBudget(run);
        watchExporter(run);
        watchAgent(run);
        if (!run.agentEnd && run.stop.signal.aborted) {
            intend(run, 'lost', CAUSE.orphaned);
            raiseKill(run, CAUSE.orphaned);
            run.agentEnd = { exitCode: null, how: 'unlaunched' };
        }
        if (!run.agentEnd) await sleep(run.settings.tickMs, run);
    }
}

/**
 * The agent's end, read without trusting it for more than it says. A kill we raised, or a
 * heartbeat that stopped, says why; a Stop the agent honored by finishing its step is a
 * cancellation with a whole transcript; an exit code of its own is the driver's verdict to read.
 */
function concludeAgentEnd(run) {
    const { machine, agentEnd, intent } = run;
    cancelQuestions(run);
    const killed = KILLED_EXITS.includes(agentEnd.exitCode) ? CAUSE.killed : null;
    if (intent) machine.abort(intent.outcome, intent.cause);
    else if (agentEnd.how === 'lost') machine.abort('lost', CAUSE.lost);
    else if (run.stopRaised) machine.abort('cancelled', killed);
    else if (agentEnd.exitCode !== 0) machine.abort('failed', killed);
    else machine.complete();
    // A completed run leaves verification and publication to the driver (delegated): the machine
    // waits in `publish` while the driver's steps run, and enters finalize on its `finish` order.
    // Anything else is already in finalize and never claims either.
    if (machine.outcome === 'completed') {
        machine.enter('verify');
        machine.enter('publish');
    }
    persist(run);
}

/**
 * One tick of the supervisor's own duties outside the agent's run: the heartbeat, the driver's
 * orders and — once there is one — the report the driver has yet to acknowledge.
 */
async function tickDuties(run) {
    beat(run);
    await pollControl(run);
    if (run.closed && !run.killRaised) {
        intend(run, 'cancelled', CAUSE.closed);
        raiseKill(run, CAUSE.closed);
    }
    await deliverReport(run);
}

/**
 * prepare: until the driver releases the agent (`go`). A Stop, a kill, a closed endpoint or a
 * driver that stopped answering ends the attempt here with the agent never launched: the stop and
 * kill markers are what a waiting agent entrypoint exits on.
 */
async function awaitGo(run) {
    while (run.goAt === null) {
        await tickDuties(run);
        if (run.stopRaised || run.killRaised) {
            intend(run, 'cancelled', run.killRaised ?? CAUSE.killed);
            raiseKill(run, run.killRaised ?? CAUSE.killed);
        } else if (orphaned(run)) {
            intend(run, 'lost', CAUSE.orphaned);
            raiseKill(run, CAUSE.orphaned);
        }
        if (run.intent) {
            run.agentEnd = { exitCode: null, how: 'unlaunched' };
            return;
        }
        await sleep(run.settings.tickMs, run);
    }
}

/** The report — the agent is over and the exporter drained — minted once: one id however often it is delivered. */
function mintReport(run, drained) {
    const { machine, agentEnd } = run;
    run.report = {
        id: randomUUID(),
        outcome: machine.outcome,
        cause: machine.cause,
        agentExit: agentEnd.exitCode,
        agentEnd: agentEnd.how,
        drained,
    };
    keepReport(run);
}

/** Whether the group serves the driver's steps until `finish`: false once the attempt was ended here, never true again. */
const serving = (run) => run.intent === null;

const reportBody = (run) => ({ ...run.report, serving: serving(run) });

/** Whether the driver has yet to acknowledge the report as it stands now — a departure is a new word to deliver. */
const reportOwed = (run) =>
    Boolean(run.binding.url) && run.report !== null && !run.reportRefused && run.reportAcked !== serving(run);

/** The report and whether the driver took it, on the supervisor's own volume: what a later reader finds. */
function keepReport(run) {
    writeAtomic(
        run.file.report,
        JSON.stringify({ report: reportBody(run), acknowledged: run.reportAcked === serving(run) })
    );
}

/**
 * One delivery of the report, when one is owed and due. An acknowledgement settles it; a closed
 * endpoint (a driver that no longer knows the token) or a refusal ends the delivery; anything else —
 * a 5xx, an answer lost — is delivered again under the same id, backing off to the control pace.
 */
async function deliverReport(run) {
    if (!reportOwed(run) || run.now() < run.reportDueAt) return;
    const body = reportBody(run);
    const answer = await ask(run, 'POST', REPORT_PATH, { body });
    run.reportTries += 1;
    if (answer && answer.status >= HTTP_OK && answer.status < HTTP_MULTIPLE_CHOICES) run.reportAcked = body.serving;
    else if (answer?.status === HTTP_UNAUTHORIZED) run.closed = true;
    else if (answer && answer.status < HTTP_SERVER_ERROR) run.reportRefused = true;
    else run.reportDueAt = run.now() + Math.min(run.settings.tickMs * run.reportTries, run.settings.controlMs);
    keepReport(run);
}

/**
 * publish/finalize: serve the driver's steps, the report delivered meanwhile, until it orders the
 * end, closes the endpoint or stops answering — or orders a kill, which ends the attempt here.
 */
async function serveUntilFinish(run) {
    const over = () => run.finishRequested || run.closed || !serving(run) || orphaned(run);
    while (!over()) {
        await tickDuties(run);
        if (!over()) await sleep(run.settings.tickMs, run);
    }
}

/**
 * An attempt ended here (a kill, the budget, a full spool) leaves: the group stops taking steps,
 * then tells the driver so — the report with `serving: false` — until it is acknowledged, the
 * endpoint closes or stops answering, or the report bound passes, whatever the other routes answer.
 */
async function depart(run) {
    run.pulling.abort();
    const until = run.now() + run.settings.reportMs;
    while (reportOwed(run) && !run.closed && !orphaned(run) && run.now() < until) {
        await tickDuties(run);
        if (reportOwed(run)) await sleep(run.settings.tickMs, run);
    }
}

/**
 * finalize: the exporter closes every session's manifest, partial when the agent did not end by
 * itself. A driver lost meanwhile ends the wait at the orphan bound: the exporter cannot reach it
 * either, and what it holds stays on the volume for the next claim.
 */
async function drainExporter(run) {
    const { settings, file, machine } = run;
    if (!settings.exports) return true;
    // Whole unless the agent was cut short: a plain failure or a cooperative Stop wrote everything.
    const { cause } = machine;
    writeAtomic(file.drain, JSON.stringify({ state: cause === null ? 'complete' : 'partial', cause }));
    const waitUntil = run.now() + settings.drainMs;
    while (run.now() < waitUntil && !orphaned(run)) {
        beat(run);
        followBinding(run);
        if (readJson(file.exportStatus)?.done === true) return true;
        await sleep(settings.tickMs, run);
    }
    return false;
}

/** The review mailbox is served by another uid of this group: its directories are group-writable. */
function openReviewMailbox(run) {
    if (!run.settings.review) return;
    const { requests, running, done } = run.file.review;
    for (const dir of [run.settings.dirs.review, requests, running, done]) {
        // A kubernetes emptyDir root belongs to root and is already 0777: only its owner may chmod it.
        if ((fs.statSync(dir).mode & 0o020) === 0) fs.chmodSync(dir, REVIEW_DIR_MODE);
    }
}

/**
 * The relays (#829): the supervisor is the one place a run's holder is named, so the agent's proxy and
 * the exporter reach it through an owner-only unix socket each and hold no token. A relay forwards only
 * its role's routes to the CURRENT holder under that role's token; anything the holder does not
 * answer in full — unreachable, rebound mid-request, timed out, cut off — is hung up on, never
 * answered 502, so a client reads a lost holder as a lost holder. A relayed answer is not contact:
 * `run.contactedAt` is the supervisor's own polls alone.
 */
const KIB = 1024;
const MIB = KIB * KIB;
const CHUNK_MIB = 65;
const JSON_KIB = 4;
const CONTENT_HEADER = /^content-(type|length)$/;
const RELAY_MODE = 0o600;
/** `REVIEW_KEY` of the agent's proxy (docker/*-executor/control-proxy.cjs): the one key shape a review is named by. */
const REVIEW_KEY = /^\/review\/[A-Za-z0-9_-]{1,64}$/;
const RELAYS = {
    agent: {
        token: 'agentToken',
        inflight: 4,
        routes: [
            { method: 'POST', match: (p) => p === '/publish', cap: MIB },
            { method: 'POST', match: (p) => p === '/review', cap: MIB },
            { method: 'POST', match: (p) => p === '/connection', cap: KIB },
            { method: 'GET', match: (p) => REVIEW_KEY.test(p), cap: MIB },
        ],
    },
    export: {
        token: 'exportToken',
        inflight: 2,
        routes: [
            { method: 'PUT', match: (p) => p === '/export/chunk', query: true, cap: CHUNK_MIB * MIB },
            { method: 'PUT', match: (p) => p === '/export/manifest', query: true, cap: JSON_KIB * KIB },
            { method: 'POST', match: (p) => p === '/export/state', query: true, cap: JSON_KIB * KIB },
        ],
    },
};

/** The relay route a request is, or null; a query rides only where the route takes one. */
function relayRouteOf(spec, request) {
    const [pathname, ...query] = (request.url ?? '').split('?');
    return (
        spec.routes.find(
            (route) => route.method === request.method && route.match(pathname) && (query.length === 0 || route.query)
        ) ?? null
    );
}

/** Refuses a body past `cap` by erroring the stream: the relay then hangs up on both sides. */
const capped = (cap) => {
    let seen = 0;
    return new Transform({
        transform(chunk, _encoding, done) {
            seen += chunk.length;
            done(seen > cap ? new Error('body past its cap') : null, chunk);
        },
    });
};

/** A refusal answered by its status alone; what the client still sends is drained (its length is declared), so it reads the answer, not a broken pipe. */
const refuse = (request, response, status) => {
    request.resume();
    response.writeHead(status);
    response.end();
};

/**
 * The one agent route answered here, never forwarded (#1045): the lease of the holder this supervisor follows,
 * for helpers whose env still names the claim the container started under. No lease known yet is a 404.
 */
function answerAttempt(run, request, response) {
    const { leaseToken } = run.binding;
    if (!leaseToken) return refuse(request, response, HTTP_NOT_FOUND);
    response.writeHead(HTTP_OK, { 'cache-control': 'no-store' });
    response.end(JSON.stringify({ leaseToken }));
}

/** One relayed request: streamed through, fenced by the binding generation it started under. */
function relayRequest(run, role, request, response) {
    if (role === 'agent' && request.method === 'GET' && request.url === '/attempt')
        return answerAttempt(run, request, response);
    const spec = RELAYS[role];
    const state = run.relays[role];
    const route = relayRouteOf(spec, request);
    if (!route) return refuse(request, response, HTTP_NOT_FOUND);
    const declared = Number(request.headers['content-length'] ?? 0);
    if (declared > route.cap) return refuse(request, response, HTTP_PAYLOAD_TOO_LARGE);
    const { binding } = run;
    const token = binding[spec.token];
    if (!binding.url || !token || state.active >= spec.inflight) {
        if (binding.url && token) return refuse(request, response, HTTP_UNAVAILABLE);
        return void response.destroy();
    }
    const gen = run.bindingGen;
    const gone = new AbortController();
    const signal = AbortSignal.any([
        run.abort.signal,
        run.bindingAbort.signal,
        run.stop.signal,
        gone.signal,
        AbortSignal.timeout(run.settings.relayMs),
    ]);
    const headers = { authorization: `Bearer ${token}` };
    for (const [name, value] of Object.entries(request.headers)) {
        if (CONTENT_HEADER.test(name)) headers[name] = value;
    }
    const lib = binding.url.startsWith('https:') ? https : http;
    state.active += 1;
    let settled = false;
    let upstream = null;
    const settle = (hangUp) => {
        if (settled) return;
        settled = true;
        state.active -= 1;
        if (!hangUp) return;
        request.destroy();
        response.destroy();
        upstream?.destroy();
    };
    response.once('close', () => {
        if (!response.writableFinished) gone.abort();
        settle(!response.writableFinished);
    });
    try {
        upstream = lib.request(`${binding.url}${request.url}`, { method: request.method, headers, signal });
    } catch {
        return settle(true);
    }
    upstream.on('error', () => settle(true));
    upstream.on('response', (answer) => {
        // The holder this started with is gone, or the run is over: whatever it says is no answer.
        if (signal.aborted || run.bindingGen !== gen) return settle(true);
        response.writeHead(
            answer.statusCode ?? 0,
            Object.fromEntries(Object.entries(answer.headers).filter(([name]) => CONTENT_HEADER.test(name)))
        );
        pipeline(answer, response, (error) => settle(Boolean(error)));
    });
    pipeline(request, capped(route.cap), upstream, (error) => {
        if (error) settle(true);
    });
}

/** Starts one role's relay on its socket; a listen that fails leaves that role without one, said in fixed words. */
function serveRelay(run, role) {
    const socket = path.join(role === 'agent' ? run.file.agentOut : run.settings.dirs.export, FILES.relay);
    return new Promise((resolve) => {
        fs.rmSync(socket, { force: true });
        const server = http.createServer((request, response) => relayRequest(run, role, request, response));
        server.on('clientError', (_error, connection) => connection.destroy());
        server.once('error', () => {
            run.log(`supervisor: could not serve the ${role} relay`);
            resolve();
        });
        server.listen(socket, () => {
            try {
                fs.chmodSync(socket, RELAY_MODE);
            } catch {
                server.close();
                run.log(`supervisor: could not serve the ${role} relay`);
                return resolve();
            }
            run.relays[role].server = server;
            resolve();
        });
    });
}

/** The relays this run needs: the agent's where an agent runs, the exporter's where one waits; none without the token. */
async function openRelays(run) {
    const { settings, binding } = run;
    if (!binding.url) return;
    if (!settings.agentless && binding.agentToken) await serveRelay(run, 'agent');
    if (settings.exports && binding.exportToken) await serveRelay(run, 'export');
}

function closeRelays(run) {
    for (const { server } of Object.values(run.relays)) {
        server?.close();
        server?.closeAllConnections();
    }
}

/**
 * One checkpoint call, repeated while the driver cannot take it (no answer, a 5xx: the board was out
 * of reach) until `abort` — the stage's absolute deadline, or the end of the run — fires. Any other
 * answer is final: the board said what it thinks of these bytes.
 */
async function putCheckpoint(run, route, options, abort) {
    for (let tries = 1; ; tries += 1) {
        const answer = await ask(run, 'PUT', route, { ...options, abort });
        if (answer && answer.status < HTTP_SERVER_ERROR) return answer;
        if (abort.aborted || orphaned(run)) return answer;
        await sleep(Math.min(run.settings.tickMs * tries, run.settings.controlMs), run);
    }
}

/** The header line, then each part's bytes, as the stream's consecutive chunks. */
function* checkpointChunks(headerFile, parts) {
    const line = Buffer.from(`${JSON.stringify(JSON.parse(fs.readFileSync(headerFile, 'utf8')))}\n`);
    yield line;
    for (const part of parts) {
        const fd = fs.openSync(part.path, 'r');
        try {
            for (;;) {
                const buffer = Buffer.allocUnsafe(CHECKPOINT_CHUNK_BYTES);
                const read = fs.readSync(fd, buffer, 0, CHECKPOINT_CHUNK_BYTES, null);
                if (read === 0) break;
                yield buffer.subarray(0, read);
            }
        } finally {
            fs.closeSync(fd);
        }
    }
}

/** Puts the stream's chunks in order; how it ended: the cause it stopped short for, or null when every chunk is stored. */
async function uploadCheckpoint(run, verdict, abort) {
    let offset = 0;
    for (const bytes of checkpointChunks(verdict.headerFile, verdict.parts)) {
        beat(run);
        const answer = await putCheckpoint(run, `/checkpoint/chunk?offset=${offset}`, { bytes }, abort);
        if (answer && answer.status === HTTP_PAYLOAD_TOO_LARGE) {
            const cause = answer.json && typeof answer.json.cause === 'string' ? answer.json.cause : null;
            return { state: 'truncated', cause: cause ?? CHECKPOINT_UPLOAD_FAILED };
        }
        if (!answer || answer.status !== HTTP_OK) return { state: 'partial', cause: CHECKPOINT_UPLOAD_FAILED };
        offset += bytes.length;
    }
    // Nothing missing but what the script cut itself: above its cap no bytes are uploaded at all.
    return verdict.state === 'truncated'
        ? { state: 'truncated', cause: verdict.cause }
        : { state: 'complete', cause: null };
}

/**
 * finalize, after the publish and before the report is final (issue #775): commits the whole task
 * tree through `scripts/checkpoint.cjs`, uploads what it made through the driver's checkpoint routes
 * and closes the stream. Every step is bounded by ONE wall-clock deadline and by the end of the run;
 * nothing here changes the attempt's outcome — a checkpoint that could not be taken or uploaded
 * leaves the stream without a `complete` manifest, which is what a reader and the volume's
 * retention rule look at. The directory it wrote in is removed whatever happened.
 */
async function checkpointStage(run) {
    const { checkpoint, checkpointMs, url } = run.settings;
    if (!checkpoint || !url || orphaned(run)) return;
    const abort = AbortSignal.any([run.abort.signal, AbortSignal.timeout(checkpointMs)]);
    const startedAt = new Date(run.now()).toISOString();
    try {
        const made = await spawnStep(run, {
            argv: ['node', '-e', checkpoint.script],
            env: {
                CHECKOUT: checkpoint.checkout,
                BRANCH: checkpoint.branch,
                ...(checkpoint.base ? { BASE: checkpoint.base } : {}),
                OUT_DIR: checkpoint.dir,
                ...(checkpoint.opencodeDb ? { OPENCODE_DB: checkpoint.opencodeDb } : {}),
            },
            timeoutMs: checkpointMs,
        });
        const verdict = lastJson(made.result.stdout);
        if (!verdict || verdict.ok !== true) {
            run.log(`checkpoint: not taken: ${verdict?.reason ?? `the script ended ${made.result.exitCode}`}`);
            return;
        }
        if (verdict.state === 'none') return;
        const ended = await uploadCheckpoint(run, verdict, abort);
        const manifest = {
            state: ended.state,
            terminalCause: ended.cause,
            startedAt,
            finishedAt: new Date(run.now()).toISOString(),
        };
        const closed = await putCheckpoint(run, '/checkpoint/manifest', { body: manifest }, abort);
        run.log(
            `checkpoint: ${ended.state}${ended.cause ? ` (${ended.cause})` : ''}, manifest ${closed ? closed.status : 'unanswered'}`
        );
    } catch (error) {
        run.log(`checkpoint: failed: ${error?.message ?? error}`);
    } finally {
        fs.rmSync(checkpoint.dir, { recursive: true, force: true });
    }
}

/** The last line of `text` that is a JSON object, or null. */
function lastJson(text) {
    for (const line of text.trim().split('\n').reverse()) {
        try {
            const value = JSON.parse(line);
            if (value && typeof value === 'object') return value;
        } catch {
            // Not the verdict: noise before it.
        }
    }
    return null;
}

/** Wires the optional external stop to the run: aborting it stops the sleeps and the step pull. */
function haltOn(run, stop) {
    const halt = () => {
        run.stop.abort();
        run.pulling.abort();
    };
    if (stop?.aborted) halt();
    else stop?.addEventListener('abort', halt, { once: true });
}

/**
 * Runs the supervisor to its report. Returns the exit status; `now` and `log` are test seams.
 * Never throws for the attempt's own failures: those are the outcome. A bug throws, and the
 * caller exits 70, which the driver reads as a lost supervisor — an infrastructure loss.
 * `stop` is optional (tests): aborting it ends the run like a lost driver, waking every sleep and the step pull.
 */
async function supervise(env = process.env, log = (line) => process.stdout.write(`${line}\n`), now = Date.now, stop) {
    const run = newRun(settingsOf(env), now, log);
    haltOn(run, stop);
    // prepare: the mailbox exists before anything reads it.
    const { dirs } = run.settings;
    for (const dir of [dirs.in, dirs.out, dirs.export, dirs.own, run.file.agentIn, run.file.agentOut]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // Set, not created with: a mode on mkdir passes through the umask, and an adopted group's
    // directory already exists.
    for (const dir of [run.file.agentIn, run.file.agentOut]) fs.chmodSync(dir, AGENT_DIR_MODE);
    for (const dir of [run.file.answers, run.file.questions, ...gateDirs(run)]) fs.mkdirSync(dir, { recursive: true });
    openReviewMailbox(run);
    await openRelays(run);
    beat(run);
    run.machine.enter('setup'); // delegated: the gate environment's setup is the driver's
    persist(run);
    const stepping = serveSteps(run);

    // The group exists from the attempt's first step: the agent is released by `go`, after the sync.
    if (run.settings.agentless) {
        run.goAt = run.now();
        run.agentEnd = { exitCode: 0, how: 'none' };
    } else {
        await awaitGo(run);
    }
    if (!run.agentEnd) {
        run.machine.enter('execute');
        persist(run);
        await executeUntilAgentEnds(run);
    }
    if (run.settings.agentless && !run.intent) run.machine.enter('execute');
    concludeAgentEnd(run);
    // The exporter drains as the agent ends — the driver reads the transcript before it verifies.
    const drained = await drainExporter(run);
    persist(run);
    mintReport(run, drained);
    // The group serves the driver's steps until `finish`, unless the attempt was ended here — before
    // the report or while it serves: then it leaves, saying so.
    if (serving(run)) await serveUntilFinish(run);
    run.log(SERVED_LINE);
    if (!serving(run)) await depart(run);
    // Whatever ended the serving — the order to finish, the departure, a closed endpoint, a lost
    // driver — nothing more is taken, and a step still running is interrupted rather than waited out:
    // its ledger says its effect may have landed.
    run.pulling.abort();
    run.inflight?.interrupt();
    for (const lane of LANES) run.lanes[lane].stopped = true;
    if (run.machine.stage === 'publish') run.machine.enter('finalize');
    await checkpointStage(run);
    run.abort.abort();
    closeRelays(run);
    await stepping;
    await Promise.all(LANES.flatMap((lane) => [...run.lanes[lane].answers]));
    run.machine.enter('report');
    persist(run);
    const { machine, agentEnd } = run;
    const report = {
        outcome: machine.outcome,
        cause: machine.cause,
        agentExit: agentEnd.exitCode,
        agentEnd: agentEnd.how,
        drained,
        performed: machine.performed(),
        delegated: machine.delegated(),
        // The volume's record of the ack goes with the pod: the log line is what outlives it.
        acknowledged: run.reportAcked === serving(run),
    };
    log(`${REPORT_PREFIX}${JSON.stringify(report)}`);
    if (machine.outcome === 'timed_out') return EXIT.deadline;
    // Never released, so nothing ran: a completed Job here would be adopted as a finished run.
    return agentEnd.how === 'unlaunched' && machine.cause === CAUSE.orphaned ? EXIT.lost : EXIT.finalized;
}

module.exports = {
    AGENT_DIR,
    STAGES,
    DELEGATED,
    TRANSITIONS,
    OUTCOMES,
    FILES,
    EXIT,
    CAUSE,
    REPORT_PREFIX,
    RELEASED_LINE,
    SERVED_LINE,
    REPORT_MS: DEFAULT_REPORT_MS,
    STEP_KINDS,
    GATE_FILES,
    GATE_LOST_MS: DEFAULT_GATE_LOST_MS,
    GATE_CANCEL_MS: DEFAULT_GATE_CANCEL_MS,
    createMachine,
    settingsOf,
    spawnStep,
    supervise,
};

if (process.env.SUPERVISOR_NO_MAIN !== '1') {
    supervise().then(
        (code) => process.exit(code),
        (error) => {
            process.stderr.write(`supervisor: ${error?.stack ?? error}\n`);
            process.exit(EXIT.failed);
        }
    );
}
