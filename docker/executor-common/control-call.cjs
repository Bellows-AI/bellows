'use strict';
/*
 * The transport and answer rules `factory-gate`, `factory-exec` and `factory-finish` share: one POST of a
 * JSON body to a tool route (POST /tools/call unless the caller names another), or one GET of the tool
 * manifest (GET /tools), on the agent's control socket (`control-proxy.cjs`), whose relay carries it to
 * whichever driver holds the run now.
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
/** `TOOLS_CALL_PATH` of driver/src/control-channel.ts. */
const TOOLS_CALL_PATH = '/tools/call';
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
 * Why an answer is not usable yet — the 75 class — or undefined for one that is: the relay hung up or
 * answered 502, the run is not open yet (a 503 that is not a recorded run's: those carry an executionId),
 * or a 2xx is not JSON. `what` names the run in the text.
 */
function retryWhy(status, json, what) {
    if (status === HTTP_BAD_GATEWAY) return 'the control relay is unavailable';
    if (status === HTTP_UNAVAILABLE && json?.retryable === true && json.executionId === undefined) {
        return `the ${what} is not open yet`;
    }
    if (status >= HTTP_OK_MIN && status <= HTTP_OK_MAX && json === undefined) return 'the answer is not JSON';
    return undefined;
}

/**
 * One POST of `body` to `path` (or a GET, which sends no body), settled once: `{ status, text }` for a whole
 * answer, `{ cut }` (why) when the socket refused, the request failed or the answer was cut short.
 */
function post({ path = TOOLS_CALL_PATH, method = 'POST', body }) {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
        };
        const text = method === 'GET' ? '' : JSON.stringify(body);
        const headers =
            method === 'GET' ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) };
        const req = http.request({ socketPath: SOCKET, path, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            // A hang-up mid-answer ends the response without `complete`: no partial result is ever an answer.
            res.on('error', (e) => settle({ cut: e.message }));
            res.on('close', () => {
                if (!res.complete) return settle({ cut: 'the answer was cut short' });
                settle({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
            });
        });
        req.on('error', (e) => settle({ cut: e.message }));
        req.end(text || undefined);
    });
}

/**
 * POSTs `body` to `path` (GETs it for `method: 'GET'`) and settles the process on the answer. `what` names the
 * run in the retry text, `retryNote` says what a 75 means for it, and `noGates` is the exit-3 text.
 */
function controlCall({ name, path, method, body, what, retryNote, noGates }) {
    /** A transport failure: retryable, and said so in words that cannot be read as a verdict. */
    const retry = (why) => fail(name, EXIT_RETRYABLE, `no answer from the ${what} (${why}); ${retryNote}: retry`);

    /** Settles the process on the whole answer: printed unchanged, then the exit its status asks for. */
    const answer = (status, text) => {
        const json = parsed(text);
        if (status === HTTP_NOT_FOUND && json?.error === NO_GATES_ERROR) fail(name, EXIT_NO_GATES, noGates);
        const why = retryWhy(status, json, what);
        if (why) return retry(why);
        process.stdout.write(text, () => {
            if (status >= HTTP_OK_MIN && status <= HTTP_OK_MAX) return;
            process.stderr.write(`${name}: HTTP ${status}\n`);
            process.exit(EXIT_HTTP);
        });
    };

    post({ path, method, body }).then((result) => (result.cut ? retry(result.cut) : answer(result.status, result.text)));
}

module.exports = { BODY_LIMIT, EXIT_USAGE, controlCall, fail, parsed, post, retryWhy };
