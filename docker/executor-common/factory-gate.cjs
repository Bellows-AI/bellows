#!/usr/bin/env node
'use strict';
/*
 * `factory-gate <name> [--filter <value>]`: run one declared gate on the gate server.
 *
 * The agent's skills call this instead of a hand-built request, so the managed allowlist can
 * pre-approve exactly this command (`Bash(factory-gate *)`) without admitting a `curl` whose `*`
 * would take any URL. The destination is fixed here: POST /gate/run on the agent's control socket
 * (`control-proxy.cjs`, the one `factory-control` and `attempt-pair.cjs` use), which the supervisor's
 * relay carries to whichever driver holds the run now. The agent holds no gate URL and no
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
 * The transport and the answer rules live in `control-call.cjs`, shared with `factory-exec`. One file,
 * built into both executor images (driver/test/executor-images.test.ts).
 */
const { EXIT_USAGE, controlCall, fail: failAs } = require('./control-call.cjs');

const USAGE = 'usage: factory-gate <name> [--filter <value>]';
const NAME = 'factory-gate';

const fail = (code, message) => failAs(NAME, code, message);

/** The request body for argv: the gate name, and the filter only when `--filter <value>` was given. */
function bodyOf(args) {
    const [gate, ...rest] = args;
    if (!gate || gate.startsWith('-')) fail(EXIT_USAGE, USAGE);
    if (rest.length === 0) return { gate };
    if (rest.length !== 2 || rest[0] !== '--filter') fail(EXIT_USAGE, USAGE);
    return { gate, filter: rest[1] };
}

function main() {
    controlCall({
        name: NAME,
        body: bodyOf(process.argv.slice(2)),
        what: 'gate run',
        retryNote: 'this says nothing about the gate',
        noGates: 'the job declares no gates',
    });
}

main();
