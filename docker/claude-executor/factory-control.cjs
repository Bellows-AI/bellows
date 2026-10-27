#!/usr/bin/env node
'use strict';
/*
 * `factory-control <verb> …`: the run-control socket calls the baked skills make (issue #1061).
 *
 *   publish                     POST /publish         the draft publication (the github skill)
 *   review <key> <profile>      POST /review          ask a named reviewer (the review skill)
 *   review-result <key>         GET  /review/<key>    that review's result
 *
 * The skills call this instead of a `curl --unix-socket`, so the managed allowlist can pre-approve
 * exactly this command (`Bash(factory-control *)`) without admitting a `curl` whose `*` would take
 * any URL. The verbs are the whole surface and the socket is fixed (`control-proxy.cjs` serves it);
 * arguments only fill the JSON, which an encoder builds, never a shell.
 *
 * The answer body reaches stdout unchanged. Exit codes: 0 a 2xx answer, 22 any other status (body
 * still printed, status on stderr), 1 no answer or no socket, 2 a usage error.
 *
 * Kept byte-identical in both executor images (driver/test/executor-images.test.ts).
 */
const fs = require('node:fs');
const http = require('node:http');

/** The agent's control socket (`control-proxy.cjs`); FACTORY_CONTROL_SOCKET replaces it for the tests' scratch socket. */
const SOCKET = process.env.FACTORY_CONTROL_SOCKET || '/run/factory-control/control.sock';
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const EXIT_TRANSPORT = 1;
const EXIT_USAGE = 2;
const EXIT_HTTP = 22;
const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;

const VERBS = {
    publish: { usage: 'publish', arity: 0, request: () => ({ method: 'POST', path: '/publish' }) },
    review: {
        usage: 'review <key> <profile>',
        arity: 2,
        request: ([key, profile]) => ({
            method: 'POST',
            path: '/review',
            body: JSON.stringify({ key, profile }),
        }),
    },
    'review-result': {
        usage: 'review-result <key>',
        arity: 1,
        request: ([key]) => ({ method: 'GET', path: `/review/${key}` }),
    },
};

const NAME = 'factory-control';

function fail(code, message) {
    process.stderr.write(`${NAME}: ${message}\n`);
    process.exit(code);
}

function requestOf(argv) {
    const [verb, ...args] = argv;
    const spec = Object.hasOwn(VERBS, verb ?? '') ? VERBS[verb] : null;
    if (!spec || args.length !== spec.arity) {
        fail(EXIT_USAGE, `usage: factory-control ${Object.values(VERBS).map((v) => v.usage).join(' | ')}`);
    }
    if (verb !== 'publish' && !KEY.test(args[0])) fail(EXIT_USAGE, 'a review key is letters, digits, _ and -, up to 64');
    return spec.request(args);
}

function main() {
    const { method, path, body } = requestOf(process.argv.slice(2));
    if (!fs.existsSync(SOCKET)) fail(EXIT_TRANSPORT, `${SOCKET} does not exist: this environment has no run control`);
    const headers = body === undefined ? {} : { 'content-length': Buffer.byteLength(body) };
    const req = http.request({ socketPath: SOCKET, path, method, headers }, (res) => {
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
