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
//   <root>/supervisor  the supervisor's own state: `state.json`; no other container mounts it
//
// Stages the driver still performs today (environment setup, the declared gates, the publish) are
// DELEGATED: this machine never records them as done, so a failure or a cancellation that enters
// `finalize` cannot imply a verification or a publication that did not happen.
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
//
// Exit status: 0 finalized, 124 finalized after the run budget ended the agent, 70 the supervisor
// itself failed. The agent's own exit code is the kubelet's (or docker's) to report, never ours.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

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
};
const EXIT_DEADLINE = 124;
const EXIT_SUPERVISOR_FAILED = 70;
const EXIT = { finalized: 0, deadline: EXIT_DEADLINE, failed: EXIT_SUPERVISOR_FAILED };
const CAUSE = {
    killed: 'agent_killed',
    timeout: 'timeout',
    spoolFull: 'artifact_spool_full',
    closed: 'control_closed',
    lost: 'agent_lost',
};
/** Exit statuses that say the agent was killed rather than finishing: SIGKILL and SIGTERM. */
const EXIT_SIGKILL = 137;
const EXIT_SIGTERM = 143;
const KILLED_EXITS = [EXIT_SIGKILL, EXIT_SIGTERM];

const QUESTION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const QUESTION_MAX_BYTES = 65_536;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const REPORT_PREFIX = 'FACTORY_SUPERVISOR_REPORT ';

const DEFAULT_CONTROL_MS = 5000;
const DEFAULT_TICK_MS = 500;
const DEFAULT_DRAIN_MS = 300_000;
const DEFAULT_AGENT_LOST_MS = 30_000;
const DEFAULT_AGENT_START_MS = 600_000;

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
    };
}

/** Where each file of the mailboxes lives, from the settings' directories. */
function filesOf({ dirs }) {
    return {
        stop: path.join(dirs.in, FILES.stop),
        kill: path.join(dirs.in, FILES.kill),
        answers: path.join(dirs.in, FILES.answers),
        questions: path.join(dirs.out, FILES.questions),
        agentAlive: path.join(dirs.out, FILES.agentAlive),
        agentExit: path.join(dirs.out, FILES.agentExit),
        alive: [path.join(dirs.in, FILES.supervisorAlive), path.join(dirs.export, FILES.supervisorAlive)],
        drain: path.join(dirs.export, FILES.drain),
        exportStatus: path.join(dirs.export, FILES.exportStatus),
        state: path.join(dirs.own, FILES.state),
    };
}

/** One call to the driver's control endpoint; null is "unreachable", never an answer. */
async function call(settings, method, route, body) {
    try {
        const response = await fetch(`${settings.url}${route}`, {
            method,
            headers: { authorization: `Bearer ${settings.token}` },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
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
    };
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
    const answer = await call(run.settings, 'POST', '/question', parsed);
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
    const polled = await call(run.settings, 'GET', `/question/${encodeURIComponent(id)}`);
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
    const answer = await call(settings, 'GET', '/control');
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
    const neverStarted = run.agentSeenAt === null && run.now() - run.startedAt > settings.agentStartMs;
    if (stale || neverStarted) run.agentEnd = { exitCode: null, how: 'lost' };
}

/** The run budget, paused while a question waits for a person. */
function tickBudget(run) {
    if (!run.settings.deadlineMs || run.killRaised || run.agentEnd) return;
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
    // A completed run leaves verification and publication to the driver (delegated); anything else
    // is already in finalize and never claims either.
    if (machine.outcome === 'completed') {
        machine.enter('verify');
        machine.enter('publish');
        machine.enter('finalize');
    }
    persist(run);
}

/** finalize: the exporter closes every session's manifest, partial when the agent did not end by itself. */
async function drainExporter(run) {
    const { settings, file, machine } = run;
    if (!settings.exports) return true;
    // Whole unless the agent was cut short: a plain failure or a cooperative Stop wrote everything.
    const { cause } = machine;
    writeAtomic(file.drain, JSON.stringify({ state: cause === null ? 'complete' : 'partial', cause }));
    const waitUntil = run.now() + settings.drainMs;
    while (run.now() < waitUntil) {
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
    for (const dir of [dirs.in, dirs.out, dirs.export, dirs.own, run.file.answers, run.file.questions]) {
        fs.mkdirSync(dir, { recursive: true });
    }
    beat(run);
    run.machine.enter('setup'); // delegated: the driver ran environment.setup before this pod existed
    run.machine.enter('execute');
    persist(run);

    await executeUntilAgentEnds(run);
    concludeAgentEnd(run);
    const drained = await drainExporter(run);
    persist(run);
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
    return machine.outcome === 'timed_out' ? EXIT.deadline : EXIT.finalized;
}

module.exports = {
    STAGES,
    DELEGATED,
    TRANSITIONS,
    OUTCOMES,
    FILES,
    EXIT,
    CAUSE,
    REPORT_PREFIX,
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
