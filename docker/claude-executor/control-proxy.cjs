#!/usr/bin/env node
'use strict';
/*
 * The agent's run-control proxy (issue #814). The agent's tools run as their own uid and never hold
 * the run-control token (BELLOWS_CONTROL_TOKEN): the entrypoint starts this proxy with it and unsets
 * it before the CLI starts. The two routes the baked skills call reach the board through this socket,
 * with the token added here, and nothing else does:
 *
 *   POST /publish        the draft publication (the github skill)
 *   POST /review         a named reviewer (the review skill)
 *   GET  /review/<key>   that review's result
 *
 * Listens on /run/factory-control/control.sock, in a directory of the CLI uid's group, so a tool —
 * group 1000 — reaches it and reads nothing else of the CLI's. Reads BELLOWS_CONTROL_URL and
 * BELLOWS_CONTROL_TOKEN. Status and body come back as the board sent them; the token never does.
 *
 * Kept byte-identical in both executor images (driver/test/control-proxy.test.ts).
 */
const fs = require('node:fs');
const http = require('node:http');

const SOCKET = '/run/factory-control/control.sock';
const SOCKET_MODE = 0o660;
/** `PUBLISH_PATH` and `REVIEW_PATH` of driver/src/control-channel.ts. */
const PUBLISH_PATH = '/publish';
const REVIEW_PATH = '/review';
const REVIEW_KEY = /^[A-Za-z0-9_-]{1,64}$/;
/** Far past any publish or review request; the board bounds its own bodies too. */
const BODY_LIMIT_BYTES = 1024 * 1024;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_LARGE = 413;
const HTTP_BAD_GATEWAY = 502;

/** Whether this method and path is one of the three the skills call. */
function allowed(method, url) {
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

async function forward(deps, req, res) {
    const url = req.url ?? '';
    if (!allowed(req.method, url)) return answer(res, HTTP_NOT_FOUND, '{"error":"not a control route"}\n');
    const body = req.method === 'POST' ? await readBody(req) : null;
    if (req.method === 'POST' && body === null) return answer(res, HTTP_TOO_LARGE, '{"error":"too large"}\n');
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
        const upstream = await deps.fetch(`${deps.url.replace(/\/$/, '')}${url}`, {
            method: req.method,
            headers: {
                authorization: `Bearer ${deps.token}`,
                ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
            },
            ...(body ? { body } : {}),
            signal: abort.signal,
        });
        const type = upstream.headers.get('content-type') ?? 'application/json';
        answer(res, upstream.status, Buffer.from(await upstream.arrayBuffer()), type);
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
    const { BELLOWS_CONTROL_URL: url, BELLOWS_CONTROL_TOKEN: token } = process.env;
    if (!url || !token) {
        process.stderr.write('control-proxy: BELLOWS_CONTROL_URL and BELLOWS_CONTROL_TOKEN are required\n');
        process.exit(2);
    }
    serve({ fs, fetch, socket: SOCKET, url, token }).catch((error) => {
        process.stderr.write(`control-proxy: could not listen: ${error.message}\n`);
        process.exit(1);
    });
}

module.exports = { serve, allowed, SOCKET, PUBLISH_PATH, REVIEW_PATH };
