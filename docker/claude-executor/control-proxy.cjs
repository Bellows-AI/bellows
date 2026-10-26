#!/usr/bin/env node
'use strict';
/*
 * The agent's run-control proxy (issue #814). The agent's tools run as their own uid and hold no
 * run-control credential at all: the supervisor serves a relay socket in the agent's own mailbox
 * (`$FACTORY_CTL_OUT/control.sock`, owner-only) that adds the agent's token and follows whichever
 * driver holds the run (issue #829). This proxy, started by the entrypoint only where that socket
 * exists, lets the tools reach it, and the two routes the baked skills call are all that cross:
 *
 *   POST /publish        the draft publication (the github skill)
 *   POST /review         a named reviewer (the review skill)
 *   GET  /review/<key>   that review's result
 *
 * Listens on /run/factory-control/control.sock, in a directory of the CLI uid's group, so a tool —
 * group 1000 — reaches it and reads nothing else of the CLI's. Reads FACTORY_CTL_OUT. Status and
 * body come back as the relay sent them; a relay that is missing or hangs up is a 502.
 *
 * Kept byte-identical in both executor images (driver/test/control-proxy.test.ts).
 */
const fs = require('node:fs');
const http = require('node:http');

const SOCKET = '/run/factory-control/control.sock';
const SOCKET_MODE = 0o660;
/** The supervisor's relay in the agent's mailbox (`MAILBOX_FILES.relay` of driver/src/supervisor-contract.ts). */
const RELAY_SOCKET = 'control.sock';
/** `PUBLISH_PATH` and `REVIEW_PATH` of driver/src/control-channel.ts. */
const PUBLISH_PATH = '/publish';
const REVIEW_PATH = '/review';
/** The supervisor's answer to which lease pair the agent holds now (`relayRequest`, #1045): read by `attempt-pair.cjs`. */
const ATTEMPT_PATH = '/attempt';
const REVIEW_KEY = /^[A-Za-z0-9_-]{1,64}$/;
/** Far past any publish or review request; the board bounds its own bodies too. */
const BODY_LIMIT_BYTES = 1024 * 1024;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_LARGE = 413;
const HTTP_BAD_GATEWAY = 502;

/** Whether this method and path is one of the four the skills and helpers call. */
function allowed(method, url) {
    if (method === 'GET' && url === ATTEMPT_PATH) return true;
    if (method === 'POST' && (url === PUBLISH_PATH || url === REVIEW_PATH)) return true;
    if (method !== 'GET' || !url.startsWith(`${REVIEW_PATH}/`)) return false;
    return REVIEW_KEY.test(url.slice(REVIEW_PATH.length + 1));
}

function answer(res, status, body, type = 'application/json') {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > BODY_LIMIT_BYTES) {
                resolve(null);
                req.destroy();
            } else chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(null));
    });
}

/** One request to the supervisor's relay socket; resolves with its status, content type and body, rejects on any failure. */
function viaRelay(deps, req, body, abort) {
    return new Promise((resolve, reject) => {
        const headers = req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {};
        const upstream = http.request(
            { socketPath: deps.relay, method: req.method, path: req.url, headers, signal: abort.signal },
            (answered) => {
                const chunks = [];
                answered.on('data', (chunk) => chunks.push(chunk));
                answered.on('error', reject);
                answered.on('close', () =>
                    answered.complete
                        ? resolve({
                              status: answered.statusCode,
                              type: answered.headers['content-type'] ?? 'application/json',
                              body: Buffer.concat(chunks),
                          })
                        : reject(new Error('the relay hung up'))
                );
            }
        );
        upstream.on('error', reject);
        upstream.end(body ?? undefined);
    });
}

async function forward(deps, req, res) {
    const url = req.url ?? '';
    if (!allowed(req.method, url)) return answer(res, HTTP_NOT_FOUND, '{"error":"not a control route"}\n');
    const body = req.method === 'POST' ? await readBody(req) : null;
    if (req.method === 'POST' && body === null) return answer(res, HTTP_TOO_LARGE, '{"error":"too large"}\n');
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
        const upstream = await viaRelay(deps, req, body, abort);
        answer(res, upstream.status, upstream.body, upstream.type);
    } catch (error) {
        if (!res.headersSent) answer(res, HTTP_BAD_GATEWAY, `${JSON.stringify({ error: error.message })}\n`);
    }
}

/** Listens on `deps.socket`; resolves with the server once the socket is there. */
function serve(deps) {
    deps.fs.rmSync(deps.socket, { force: true });
    const server = http.createServer((req, res) => {
        forward(deps, req, res).catch(() => {
            if (!res.headersSent) answer(res, HTTP_BAD_GATEWAY, '{"error":"proxy failure"}\n');
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(deps.socket, () => {
            deps.fs.chmodSync(deps.socket, SOCKET_MODE);
            resolve(server);
        });
    });
}

if (require.main === module) {
    const { FACTORY_CTL_OUT: out } = process.env;
    if (!out) {
        process.stderr.write('control-proxy: FACTORY_CTL_OUT is required\n');
        process.exit(2);
    }
    serve({ fs, socket: SOCKET, relay: `${out}/${RELAY_SOCKET}` }).catch((error) => {
        process.stderr.write(`control-proxy: could not listen: ${error.message}\n`);
        process.exit(1);
    });
}

module.exports = { serve, allowed, SOCKET, PUBLISH_PATH, REVIEW_PATH };
