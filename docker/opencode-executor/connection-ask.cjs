'use strict';
/*
 * The runtime connection ask, the one call a helper makes when its task lacks a connection it
 * needs: `POST /connection {provider, target?}` on the agent's control socket (`control-proxy.cjs`), which the
 * supervisor relays to the driver and the driver to the board. The board decides, and the answer is one of
 *
 *   bound         the task has a usable connection now: read the list again and go on
 *   unavailable   the user chose to continue without it
 *   waiting       the requirement is open: the driver stops the agent and the task resumes here once it closes
 *
 * `target` is what the helper needs of the provider (for Jira, the site): the board counts only a binding or a
 * connection that matches it.
 *
 * `askConnection(provider, { socket, deadlineMs, target })` resolves, never rejects:
 *   { kind: 'answer', answer }   one of the three, from a 200 with exactly such a body
 *   { kind: 'refused' }          401, 403 or 409: this attempt is no longer the board's to answer
 *   { kind: 'absent' }           there is no proxy socket at all (ENOENT, ENOTDIR): nothing to ask
 *   { kind: 'inconclusive' }     anything else - a hang-up, a timeout, a 5xx, a body that is no answer.
 *                                Never a verdict: the caller asks again inside its own deadline.
 *
 * Kept byte-identical in both executor images (driver/test/executor-images.test.ts).
 */
const http = require('node:http');

/** The agent's control socket (`control-proxy.cjs`); FACTORY_CONTROL_SOCKET replaces it for tests' scratch socket. */
const SOCKET = '/run/factory-control/control.sock';
const BODY_LIMIT_BYTES = 4096;
const HTTP_OK = 200;
const ANSWERS = ['bound', 'unavailable', 'waiting'];
const REFUSED = [401, 403, 409];
const NO_SOCKET = ['ENOENT', 'ENOTDIR'];
const INCONCLUSIVE = { kind: 'inconclusive' };

/** One ask. Settles exactly once: on an answer, an error, an abort, or a connection that closed before the body ended. */
function askConnection(provider, options = {}) {
    const socketPath = options.socket ?? process.env.FACTORY_CONTROL_SOCKET ?? SOCKET;
    const deadlineMs = Math.max(1, options.deadlineMs ?? 10_000);
    return new Promise((resolve) => {
        let request;
        let done = false;
        const settle = (result) => {
            if (done) return;
            done = true;
            request?.destroy();
            resolve(result);
        };
        try {
            request = http.request({
                socketPath,
                path: '/connection',
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                signal: AbortSignal.timeout(deadlineMs),
            });
        } catch {
            return resolve(INCONCLUSIVE);
        }
        request.on('error', (error) => settle(NO_SOCKET.includes(error?.code) ? { kind: 'absent' } : INCONCLUSIVE));
        request.on('response', (response) => {
            if (REFUSED.includes(response.statusCode)) return settle({ kind: 'refused' });
            if (response.statusCode !== HTTP_OK) return settle(INCONCLUSIVE);
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > BODY_LIMIT_BYTES) return settle(INCONCLUSIVE);
                chunks.push(chunk);
            });
            response.on('error', () => settle(INCONCLUSIVE));
            response.on('close', () => {
                if (!response.complete) return settle(INCONCLUSIVE);
                try {
                    const { answer } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    settle(ANSWERS.includes(answer) ? { kind: 'answer', answer } : INCONCLUSIVE);
                } catch {
                    settle(INCONCLUSIVE);
                }
            });
        });
        request.end(JSON.stringify(options.target === undefined ? { provider } : { provider, target: options.target }));
    });
}

module.exports = { askConnection, SOCKET };
