#!/usr/bin/env node
'use strict';
/*
 * `factory-gate <name> [--filter <value>]`: run one declared gate on the gate server (issue #1061).
 *
 * The agent's skills call this instead of a hand-built request, so the managed allowlist can
 * pre-approve exactly this command (`Bash(factory-gate *)`) without admitting a `curl` whose `*`
 * would take any URL. The destination is fixed here: POST /gate/run on the agent's control socket
 * (`control-proxy.cjs`, the one `factory-control` and `attempt-pair.cjs` use), which the supervisor's
 * relay carries to whichever driver holds the run now (BEL-88). The agent holds no gate URL and no
 * token; the arguments only choose the gate and its filter, and the JSON is built by an encoder,
 * never by a shell.
 *
 * The driver's answer reaches stdout unchanged, whole or not at all (the 422 and the 503 of a run
 * that was not recorded included). Exit codes: 0 a 2xx answer, 22 any other status (curl -f's code,
 * body still printed, status on stderr), 2 a usage error, 3 the driver's explicit `404 no gates`
 * (the job declares none), 75 no usable answer: the socket is missing or refuses, the relay hung up
 * or answered 502, the gate run is not open yet (a 503 that is not a recorded run's), the answer was
 * cut short or is not JSON. A 75 is retryable and says nothing about the gate: never a pass, never
 * "no gates". No client timeout: a gate runs for minutes and the relay bounds the call.
 *
 * One file, built into both executor images (driver/test/executor-images.test.ts).
 */
const http = require('node:http');

const USAGE = 'usage: factory-gate <name> [--filter <value>]';
const EXIT_USAGE = 2;
const EXIT_NO_GATES = 3;
const EXIT_HTTP = 22;
/** EX_TEMPFAIL: no usable answer, ask again. */
const EXIT_RETRYABLE = 75;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;

/** The agent's control socket (`control-proxy.cjs`); FACTORY_CONTROL_SOCKET replaces it for the tests' scratch socket. */
const SOCKET = process.env.FACTORY_CONTROL_SOCKET || '/run/factory-control/control.sock';
/** `GATE_RUN_PATH` of driver/src/control-channel.ts. */
const GATE_RUN_PATH = '/gate/run';
/** The driver's answer for a job that declares no gates (`404 no gates`, control-channel.ts). */
const NO_GATES_ERROR = 'no gates';

const NAME = 'factory-gate';

function fail(code, message) {
    process.stderr.write(`${NAME}: ${message}\n`);
    process.exit(code);
}

/** A transport failure: retryable, and said so in words that cannot be read as a gate verdict. */
const retry = (why) => fail(EXIT_RETRYABLE, `no answer from the gate run (${why}); this says nothing about the gate: retry`);

const parsed = (text) => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

/** The request body for argv: the gate name, and the filter only when `--filter <value>` was given. */
function bodyOf(args) {
    const [gate, ...rest] = args;
    if (!gate || gate.startsWith('-')) fail(EXIT_USAGE, USAGE);
    if (rest.length === 0) return { gate };
    if (rest.length !== 2 || rest[0] !== '--filter') fail(EXIT_USAGE, USAGE);
    return { gate, filter: rest[1] };
}

function main() {
    const body = JSON.stringify(bodyOf(process.argv.slice(2)));
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    const req = http.request({ socketPath: SOCKET, path: GATE_RUN_PATH, method: 'POST', headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        // A hang-up mid-answer ends the response without `complete`: no partial result reaches stdout.
        res.on('error', (e) => retry(e.message));
        res.on('close', () => {
            if (!res.complete) return retry('the answer was cut short');
            answer(res.statusCode ?? 0, Buffer.concat(chunks).toString('utf8'));
        });
    });
    req.on('error', (e) => retry(e.message));
    req.end(body);
}

/** Settles the process on the whole answer: printed unchanged, then the exit its status asks for. */
function answer(status, text) {
    const json = parsed(text);
    if (status === HTTP_NOT_FOUND && json?.error === NO_GATES_ERROR) fail(EXIT_NO_GATES, 'the job declares no gates');
    if (status === HTTP_BAD_GATEWAY) return retry('the control relay is unavailable');
    // A 503 that is not a recorded run's (those carry an executionId): the driver has no gate run open yet.
    if (status === HTTP_UNAVAILABLE && json?.retryable === true && json.executionId === undefined) {
        return retry('the gate run is not open yet');
    }
    const ok = status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;
    if (ok && json === undefined) return retry('the answer is not JSON');
    process.stdout.write(text, () => {
        if (ok) return;
        process.stderr.write(`${NAME}: HTTP ${status}\n`);
        process.exit(EXIT_HTTP);
    });
}

main();
