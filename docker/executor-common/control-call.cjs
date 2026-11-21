'use strict';
/*
 * The transport and answer rules `factory-gate` and `factory-exec` share: one POST of a JSON body to
 * /gate/run on the agent's control socket (`control-proxy.cjs`), whose relay carries it to whichever
 * driver holds the run now.
 *
 * The driver's answer reaches stdout unchanged, whole or not at all. Exit codes: 0 a 2xx answer, 22 any
 * other status (curl -f's code, body still printed, status on stderr), 3 the driver's explicit `404 no
 * gates`, 75 no usable answer: the socket is missing or refuses, the relay hung up or answered 502, the
 * run is not open yet (a 503 that is not a recorded run's), the answer was cut short or is not JSON. A 75
 * is retryable and never a verdict, never "no gates". No client timeout: a run takes minutes and the relay
 * bounds the call. The caller's usage errors exit 2.
 */
const http = require('node:http');

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
/** The driver's answer for a job with no gate environment to run in (`404 no gates`, control-channel.ts). */
const NO_GATES_ERROR = 'no gates';
/** `BODY_LIMIT` of driver/src/gate-request.ts: the driver refuses a longer request. */
const BODY_LIMIT = 4096;

function fail(name, code, message) {
    process.stderr.write(`${name}: ${message}\n`);
    process.exit(code);
}

const parsed = (text) => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

/**
 * POSTs `body` and settles the process on the answer. `what` names the run in the retry text, `retryNote`
 * says what a 75 means for it, and `noGates` is the exit-3 text.
 */
function controlCall({ name, body, what, retryNote, noGates }) {
    /** A transport failure: retryable, and said so in words that cannot be read as a verdict. */
    const retry = (why) => fail(name, EXIT_RETRYABLE, `no answer from the ${what} (${why}); ${retryNote}: retry`);

    /** Settles the process on the whole answer: printed unchanged, then the exit its status asks for. */
    const answer = (status, text) => {
        const json = parsed(text);
        if (status === HTTP_NOT_FOUND && json?.error === NO_GATES_ERROR) fail(name, EXIT_NO_GATES, noGates);
        if (status === HTTP_BAD_GATEWAY) return retry('the control relay is unavailable');
        // A 503 that is not a recorded run's (those carry an executionId): the driver has no gate run open yet.
        if (status === HTTP_UNAVAILABLE && json?.retryable === true && json.executionId === undefined) {
            return retry(`the ${what} is not open yet`);
        }
        const ok = status >= HTTP_OK_MIN && status <= HTTP_OK_MAX;
        if (ok && json === undefined) return retry('the answer is not JSON');
        process.stdout.write(text, () => {
            if (ok) return;
            process.stderr.write(`${name}: HTTP ${status}\n`);
            process.exit(EXIT_HTTP);
        });
    };

    const text = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) };
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
    req.end(text);
}

module.exports = { BODY_LIMIT, EXIT_USAGE, controlCall, fail };
