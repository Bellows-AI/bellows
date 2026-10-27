#!/usr/bin/env node
'use strict';
/*
 * `factory-gate <name> [--filter <value>]`: run one declared gate on the gate server (issue #1061).
 *
 * The agent's skills call this instead of a `curl` of $BELLOWS_GATE_URL, so the managed allowlist
 * can pre-approve exactly this command (`Bash(factory-gate *)`) without admitting a `curl` whose
 * `*` would take any URL. The destination is fixed here: POST $BELLOWS_GATE_URL/run with the run's
 * bearer; the arguments only choose the gate and its filter, and the JSON is built by an encoder,
 * never by a shell.
 *
 * The answer body reaches stdout unchanged (the 422 and the retryable 503 included). Exit codes: 0
 * a 2xx answer, 22 any other status (curl -f's code, body still printed, status on stderr), 1 no
 * answer at all, 2 a usage error, 3 no gate server in this environment.
 *
 * Kept byte-identical in both executor images (driver/test/executor-images.test.ts).
 */
const http = require('node:http');
const https = require('node:https');

const USAGE = 'usage: factory-gate <name> [--filter <value>]';
const EXIT_TRANSPORT = 1;
const EXIT_USAGE = 2;
const EXIT_NO_GATES = 3;
const EXIT_HTTP = 22;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

const NAME = 'factory-gate';

function fail(code, message) {
    process.stderr.write(`${NAME}: ${message}\n`);
    process.exit(code);
}

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
    const base = process.env.BELLOWS_GATE_URL;
    if (!base) fail(EXIT_NO_GATES, 'BELLOWS_GATE_URL is unset: this environment has no gates');
    let url;
    try {
        url = new URL(`${base.replace(/\/+$/, '')}/run`);
    } catch {
        fail(EXIT_NO_GATES, 'BELLOWS_GATE_URL is not a URL');
    }
    const transport = url.protocol === 'https:' ? https : http;
    const headers = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${process.env.BELLOWS_GATE_TOKEN ?? ''}`,
    };
    // No timeout: a gate runs for minutes and the server answers when it ends.
    const req = transport.request(url, { method: 'POST', headers }, (res) => {
        res.pipe(process.stdout, { end: false });
        res.on('end', () => {
            const status = res.statusCode ?? 0;
            // Let stdout drain before the process ends: the body is the answer.
            if (status >= HTTP_OK_MIN && status <= HTTP_OK_MAX) return;
            process.stderr.write(`${NAME}: HTTP ${status}\n`);
            process.exitCode = EXIT_HTTP;
        });
        res.on('error', (e) => fail(EXIT_TRANSPORT, e.message));
    });
    req.on('error', (e) => fail(EXIT_TRANSPORT, e.message));
    req.end(body);
}

main();
