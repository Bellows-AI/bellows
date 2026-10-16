#!/usr/bin/env node
'use strict';
// The runner's end of AskUserQuestion (issue #226). Plain `claude -p` has no AskUserQuestion tool;
// under `--input-format stream-json --permission-prompt-tool stdio` the CLI asks this process for
// every permission decision as a `control_request`. The bridge answers them: AskUserQuestion goes
// to the driver's control endpoint (BELLOWS_CONTROL_URL, scoped by BELLOWS_CONTROL_TOKEN) and the
// person's answer goes back into the SAME CLI process; every other tool is denied, which is what a
// headless `-p` run did before.
//
// It receives the entrypoint's `"$@"`, which ends `-p <prompt>`, and passes the CLI's stdout
// through unchanged while the progress reader lives — the FIFO contract is the entrypoint's. The
// question text is never written to stderr or stdout by the bridge itself.
const fs = require('node:fs');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const EXIT_USAGE = 64;
const EXIT_NOT_FOUND = 127;
const SIGNAL_EXIT_BASE = 128;
const DEFAULT_POLL_MS = 5000;
const REQUEST_TIMEOUT_MS = 10_000;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;
const ASK_TOOL = 'AskUserQuestion';

const MSG_TOOL_DENIED = "Not pre-approved by the runner's allowlist, and nobody can approve it in this run.";
// The CLI asks about a compound command whose every part is allowlisted when it cannot match the
// whole, so a Bash denial is not a verdict on its parts.
const MSG_BASH_DENIED =
    `${MSG_TOOL_DENIED} A compound command (a \`( … )\` subshell, a heredoc, a \`;\` or \`&&\` chain) is approved ` +
    'only when every part matches the allowlist: run each part once on its own, unwrapped, before treating it as refused.';
const MSG_NOBODY = 'Nobody can answer questions in this run. Continue with your best judgment and state the assumption you made.';
const MSG_STOPPED = 'The task was stopped.';
const MSG_NO_MORE = 'This run cannot ask more questions. Continue with your best judgment and state the assumption you made.';

const url = process.env.BELLOWS_CONTROL_URL;
const token = process.env.BELLOWS_CONTROL_TOKEN;
const marker = process.env.FACTORY_STOP_MARKER;
const configuredPoll = Number(process.env.BELLOWS_CONTROL_POLL_MS);
const pollMs = Number.isFinite(configuredPoll) && configuredPoll > 0 ? configuredPoll : DEFAULT_POLL_MS;

const deny = (message, interrupt) => ({ behavior: 'deny', message, interrupt });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stopped = () => Boolean(marker) && fs.existsSync(marker);

async function http(method, path, body) {
    try {
        const response = await fetch(`${url}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        let json = null;
        try {
            json = await response.json();
        } catch {
            // An empty or non-JSON body carries no state; the status alone decides.
        }
        return { status: response.status, ok: response.ok, json };
    } catch {
        // A network error is not an answer: the caller keeps polling.
        return null;
    }
}

/** The decision for one AskUserQuestion: ask the board, then poll until a person settles it. */
async function ask(request) {
    if (!url || !token) return deny(MSG_NOBODY, false);
    const id = request.tool_use_id;
    const input = request.input ?? {};
    let posted = false;
    for (;;) {
        if (stopped()) return deny(MSG_STOPPED, true);
        if (!posted) {
            const created = await http('POST', '/question', { questionId: id, questions: input.questions });
            if (created) {
                if (created.status === HTTP_UNAUTHORIZED) return deny(MSG_STOPPED, true);
                if (created.status === HTTP_BAD_REQUEST || created.status === HTTP_TOO_MANY_REQUESTS) {
                    return deny(MSG_NO_MORE, false);
                }
                posted = created.ok;
            }
        }
        if (posted) {
            const polled = await http('GET', `/question/${encodeURIComponent(id)}`);
            if (polled) {
                if (polled.status === HTTP_UNAUTHORIZED) return deny(MSG_STOPPED, true);
                const state = polled.status < HTTP_SERVER_ERROR && polled.json ? polled.json.state : undefined;
                if (state === 'answered') {
                    return { behavior: 'allow', updatedInput: { ...input, answers: polled.json.answers } };
                }
                if (state === 'cancelled') return deny(MSG_STOPPED, true);
            }
        }
        await sleep(pollMs);
    }
}

async function decide(request) {
    if (request.tool_name === 'Bash') return deny(MSG_BASH_DENIED, false);
    if (request.tool_name !== ASK_TOOL) return deny(MSG_TOOL_DENIED, false);
    return ask(request);
}

function main() {
    const args = process.argv.slice(2);
    if (args.at(-2) !== '-p') {
        process.stderr.write('claude-bridge: expected "-p <prompt>" as the last two arguments\n');
        process.exit(EXIT_USAGE);
    }
    const prompt = args.at(-1);
    const rest = args.slice(0, -2);

    // TERM and INT go to the CLI; the bridge leaves only when the CLI has. Installed BEFORE the
    // spawn: the entrypoint forwards a TERM as soon as the CLI is up, and one landing between the
    // spawn and a later listener would take Node's default action and kill the bridge, leaving
    // the CLI unsignalled. A handler runs from the event loop, never mid-main, so `cli` is set.
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => cli.kill(signal));

    const cli = spawn(
        'claude',
        ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', ...rest],
        { stdio: ['pipe', 'pipe', 'inherit'] }
    );
    cli.on('error', (error) => {
        process.stderr.write(`claude-bridge: could not start claude: ${error.message}\n`);
        process.exit(EXIT_NOT_FOUND);
    });
    // The CLI can exit before a late write lands; that is the exit handler's to report, not a crash.
    cli.stdin.on('error', () => {});
    // Our stdout is the progress sidecar's FIFO (issue #798): a reader that died costs the live
    // progress, never the run — stop relaying, say so once, and let the CLI's status stand.
    let relaying = true;
    process.stdout.on('error', () => {
        if (!relaying) return;
        relaying = false;
        process.stderr.write('claude-bridge: the progress reader is gone; live progress stops, the run continues\n');
    });

    // A `result` ends a turn, and closing stdin ends the run — but the CLI still runs the turn a
    // background subagent's completion queues, and past end of input that turn's permission
    // requests fail "Stream closed". So stdin stays open while a subagent runs. A background
    // shell does not count: the CLI kills shells at end of input instead of waiting for them.
    let subagentsRunning = false;
    let inputOpen = true;
    const send = (message) => {
        if (inputOpen) cli.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const respond = (requestId, response) =>
        send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

    send({ type: 'control_request', request_id: 'factory-init', request: { subtype: 'initialize', hooks: null } });
    send({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' });

    const reader = readline.createInterface({ input: cli.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
        if (relaying) process.stdout.write(`${line}\n`);
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }
        if (!event || typeof event !== 'object') return;
        if (event.type === 'system' && event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
            subagentsRunning = event.tasks.some((task) => task?.task_type === 'local_agent');
        } else if (event.type === 'result') {
            if (subagentsRunning) return;
            inputOpen = false;
            cli.stdin.end();
        } else if (event.type === 'control_request' && event.request) {
            const requestId = event.request_id;
            if (event.request.subtype === 'can_use_tool') {
                decide(event.request).then((decision) => respond(requestId, decision));
            } else {
                send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: 'unsupported' } });
            }
        }
    });

    cli.on('close', (code, signal) => {
        process.exit(signal ? SIGNAL_EXIT_BASE + (os.constants.signals[signal] ?? 0) : (code ?? 0));
    });
}

main();
