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
//
// The group lives for the whole attempt, not just the agent's run. The driver submits STEPS to it —
// the startup sync, the tree probe, the review snapshot, the publish steps, the allowlisted helpers
// and the terminal reclaim — and the supervisor pulls them (`GET /step`, a long poll), runs each as
// a child process of its own container over the task volume it mounts, and answers (`POST /step/:id`).
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
//   SUPERVISOR_CONTROL_MS     — the driver poll period (default 5000).
//   SUPERVISOR_TICK_MS        — the mailbox period (default 500).
//   SUPERVISOR_DEADLINE_MS    — the run budget, paused while a question waits; absent = unbounded.
//   SUPERVISOR_DRAIN_MS       — how long the exporter may take to drain (default 300000).
//   SUPERVISOR_AGENT_LOST_MS  — a seen agent heartbeat older than this is a lost agent (default 30000).
//   SUPERVISOR_AGENT_START_MS — how long the agent may take to show a first heartbeat (default 600000).
//   SUPERVISOR_EXPORTS        — `1` when an exporter container waits for the drain order.
//   SUPERVISOR_AGENTLESS      — `1` for an attempt with no agent container: no `go` is awaited.
//   SUPERVISOR_ORPHAN_MS      — how long an unanswering driver is served before finalizing (default 90000).
//   SUPERVISOR_STEP_WAIT_MS   — one `GET /step` long poll (default 15000).
//   SUPERVISOR_REPORT_MS      — how long a departure's report is redelivered before finalizing (default 60000).
//
// Exit status: 0 finalized, 124 finalized after the run budget ended the agent, 70 the supervisor
// itself failed, 75 the driver was lost before the agent was released (nothing ran to adopt). The
// agent's own exit code is the kubelet's (or docker's) to report, never ours.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

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
};
/** The supervised steps, by kind; the two last are the group's own orders (`STEP_KINDS` of supervisor-contract.ts). */
const STEP_KINDS = ['sync', 'reclaim', 'probe', 'snapshot', 'publish', 'helper', 'go', 'finish'];
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
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const REPORT_PREFIX = 'FACTORY_SUPERVISOR_REPORT ';
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function settingsOf(env) {
    const root = env.FACTORY_CTL_ROOT || '/factory';
    return {
        root,
        dirs: {
            in: path.join(root, 'in'),
            out: path.join(root, 'out'),
            export: path.join(root, 'export'),
            own: path.join(root, 'supervisor'),
        },
        url: env.SUPERVISOR_CONTROL_URL || null,
        token: env.SUPERVISOR_CONTROL_TOKEN || null,
        controlMs: positive(env, 'SUPERVISOR_CONTROL_MS', DEFAULT_CONTROL_MS),
        tickMs: positive(env, 'SUPERVISOR_TICK_MS', DEFAULT_TICK_MS),
        deadlineMs: positive(env, 'SUPERVISOR_DEADLINE_MS', 0),
        drainMs: positive(env, 'SUPERVISOR_DRAIN_MS', DEFAULT_DRAIN_MS),
        agentLostMs: positive(env, 'SUPERVISOR_AGENT_LOST_MS', DEFAULT_AGENT_LOST_MS),
        agentStartMs: positive(env, 'SUPERVISOR_AGENT_START_MS', DEFAULT_AGENT_START_MS),
        exports: env.SUPERVISOR_EXPORTS === '1',
        agentless: env.SUPERVISOR_AGENTLESS === '1',
        orphanMs: positive(env, 'SUPERVISOR_ORPHAN_MS', DEFAULT_ORPHAN_MS),
        stepWaitMs: positive(env, 'SUPERVISOR_STEP_WAIT_MS', DEFAULT_STEP_WAIT_MS),
        reportMs: positive(env, 'SUPERVISOR_REPORT_MS', DEFAULT_REPORT_MS),
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
    };
}

/**
 * One call to the driver's control endpoint; null is "unreachable", never an answer. A call that
 * returns at all — whatever the status — is the driver being there (`run.contactedAt`), which the
 * orphan bound reads. `holdMs` is the long poll's own wait on top of the usual timeout.
 */
async function call(settings, method, route, { body, holdMs = 0, abort = null, onContact = null } = {}) {
    try {
        const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS + holdMs);
        const response = await fetch(`${settings.url}${route}`, {
            method,
            headers: { authorization: `Bearer ${settings.token}` },
            body: body ? JSON.stringify(body) : undefined,
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
        abort: new AbortController(),
        // Aborted when the group stops taking steps; `inflight` interrupts the one still running.
        pulling: new AbortController(),
        inflight: null,
        // The report once minted, the `serving` the driver acknowledged it with, and its redelivery.
        report: null,
        reportAcked: null,
        reportRefused: false,
        reportTries: 0,
        reportDueAt: 0,
    };
}

/** A call to the driver on this run's behalf: it ends with the run, and an answer counts as contact. */
const ask = (run, method, route, options = {}) =>
    call(run.settings, method, route, {
        abort: run.abort.signal,
        onContact: () => {
            run.contactedAt = run.now();
        },
        ...options,
    });

/** The driver stopped answering for longer than the orphan bound: nobody is left to give this group orders. */
const orphaned = (run) => Boolean(run.settings.url) && run.now() - run.contactedAt > run.settings.orphanMs;

const ledgerFile = (run, id) => path.join(run.file.ledger, `${encodeURIComponent(id)}.json`);

const stepResult = (exitCode, stdout = '', stderr = '', timedOut = false) => ({ exitCode, stdout, stderr, timedOut });

/** Keeps the tail of a stream at the step output cap, byte-true enough: the cap is a bound, not a format. */
const keepTail = (text) => (text.length <= STEP_OUTPUT_LIMIT ? text : text.slice(text.length - STEP_OUTPUT_LIMIT));

/**
 * Runs one command step as a child process group of this container; its streams and exit are the
 * answer, and `interrupted` says the supervisor killed it on its way out (`run.inflight`).
 */
function spawnStep(run, step) {
    return new Promise((resolve) => {
        const [exe, ...args] = step.argv;
        let child;
        // The agent's tools run as their own uid in group 1000 (issue #814), so a step writes the
        // tree group-writable. The child takes the umask at its fork; this process keeps its own.
        const umask = process.umask(STEP_UMASK);
        try {
            child = spawn(exe, args, {
                cwd: step.cwd || undefined,
                env: { ...run.settings.childEnv, ...step.env },
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
        run.inflight = {
            interrupt: () => {
                interrupted = true;
                killGroup();
            },
        };
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
    // An effect that landed is never run again, whoever asks: that is the harm the ledger prevents. A
    // call already taken is answered as it ended — a failure or a timeout too, which may have half
    // landed — and one taken but never answered is unknown; either way it never runs twice. Only a
    // new call — the caller reconciled against the remote, or a refusal worth retrying was fixed — runs.
    const entry = ledgerOf(run, step);
    if (entry.effect) return { ...entry.effect, replayed: true };
    const prior = entry.invocations[step.invocation];
    if (prior?.state === 'done') return { ...prior.result, replayed: true };
    if (prior) return unknownResult(step.id);
    // An attempt that ended any way but completed publishes nothing: the machine already went to finalize.
    if (kind === 'publish' && run.machine.outcome !== null && run.machine.outcome !== 'completed') {
        return stepResult(STEP_REFUSED_EXIT, '', `refusing to publish: the attempt ended ${run.machine.outcome}`);
    }
    if (step.argv.length === 0) return stepResult(STEP_REFUSED_EXIT, '', 'a command step needs a command');
    recordCall(run, entry, step.invocation, { state: 'running' });
    const { result, interrupted } = await spawnStep(run, step);
    if (interrupted) {
        recordCall(run, entry, step.invocation, { state: 'interrupted', result });
        return result;
    }
    if (result.exitCode === 0 && !result.timedOut) entry.effect = result;
    recordCall(run, entry, step.invocation, { state: 'done', result });
    return result;
}

/** Posts a call's answer until the driver acknowledges it (or says the attempt is over). */
async function postStepResult(run, step, result) {
    const body = { invocation: step.invocation, ...result };
    for (let attempt = 1; attempt <= STEP_RESULT_ATTEMPTS && !run.abort.signal.aborted; attempt += 1) {
        const answer = await ask(run, 'POST', `${STEP_PATH}/${encodeURIComponent(step.id)}`, { body });
        if (answer && answer.status < HTTP_SERVER_ERROR) {
            if (answer.status === HTTP_UNAUTHORIZED) run.closed = true;
            return;
        }
        await sleep(run.settings.tickMs * attempt);
    }
}

/** Pulls steps from the driver, one at a time, until the group stops taking them. */
async function serveSteps(run) {
    const { settings } = run;
    if (!settings.url) return;
    const pulling = AbortSignal.any([run.abort.signal, run.pulling.signal]);
    while (!pulling.aborted) {
        const wait = settings.stepWaitMs;
        const answer = await ask(run, 'GET', `${STEP_PATH}?wait=${wait}`, { holdMs: wait, abort: pulling });
        // A step handed over once the group stopped taking steps is dropped unrun: the driver refuses its waiter.
        if (pulling.aborted) return;
        if (!answer || answer.status >= HTTP_SERVER_ERROR) {
            await sleep(settings.tickMs);
            continue;
        }
        if (answer.status === HTTP_UNAUTHORIZED) {
            run.closed = true;
            return;
        }
        const step = answer.json?.step;
        if (!step) continue;
        await postStepResult(run, step, await performStep(run, step));
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
        else if (!run.settings.url) settle(run, id, { state: 'refused' });
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
    if (!run.settings.url) return;
    for (const [id, known] of run.questions) {
        if (known.settled) continue;
        if (!known.posted && !(await postQuestion(run, id, known))) continue;
        await pollQuestion(run, id, known);
    }
}

async function pollControl(run) {
    const { settings } = run;
    if (!settings.url || run.now() - run.lastControlAt < settings.controlMs) return;
    run.lastControlAt = run.now();
    const answer = await ask(run, 'GET', '/control');
    if (!answer) return;
    if (answer.status === HTTP_UNAUTHORIZED) {
        run.closed = true;
        return;
    }
    if (answer.json?.stop === true) raiseStop(run);
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

/** The agent ended on its own (an exit marker) or was lost (its heartbeat stopped, or never started). */
function watchAgent(run) {
    if (run.agentEnd) return;
    if (fs.existsSync(run.file.agentExit)) {
        const code = Number.parseInt(fs.readFileSync(run.file.agentExit, 'utf8').trim(), 10);
        run.agentEnd = { exitCode: Number.isFinite(code) ? code : null, how: 'exit' };
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
        if (!run.agentEnd) await sleep(run.settings.tickMs);
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
        await sleep(run.settings.tickMs);
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
    Boolean(run.settings.url) && run.report !== null && !run.reportRefused && run.reportAcked !== serving(run);

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
        if (!over()) await sleep(run.settings.tickMs);
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
        if (reportOwed(run)) await sleep(run.settings.tickMs);
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
        if (readJson(file.exportStatus)?.done === true) return true;
        await sleep(settings.tickMs);
    }
    return false;
}

/**
 * Runs the supervisor to its report. Returns the exit status; `now` and `log` are test seams.
 * Never throws for the attempt's own failures: those are the outcome. A bug throws, and the
 * caller exits 70, which the driver reads as a lost supervisor — an infrastructure loss.
 */
async function supervise(env = process.env, log = (line) => process.stdout.write(`${line}\n`), now = Date.now) {
    const run = newRun(settingsOf(env), now, log);
    // prepare: the mailbox exists before anything reads it.
    const { dirs } = run.settings;
    for (const dir of [dirs.in, dirs.out, dirs.export, dirs.own, run.file.agentIn, run.file.agentOut]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    // Set, not created with: a mode on mkdir passes through the umask, and an adopted group's
    // directory already exists.
    for (const dir of [run.file.agentIn, run.file.agentOut]) fs.chmodSync(dir, AGENT_DIR_MODE);
    for (const dir of [run.file.answers, run.file.questions]) fs.mkdirSync(dir, { recursive: true });
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
    if (!serving(run)) await depart(run);
    // Whatever ended the serving — the order to finish, the departure, a closed endpoint, a lost
    // driver — nothing more is taken, and a step still running is interrupted rather than waited out:
    // its ledger says its effect may have landed.
    run.pulling.abort();
    run.inflight?.interrupt();
    if (run.machine.stage === 'publish') run.machine.enter('finalize');
    run.abort.abort();
    await stepping;
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
    REPORT_MS: DEFAULT_REPORT_MS,
    STEP_KINDS,
    createMachine,
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
