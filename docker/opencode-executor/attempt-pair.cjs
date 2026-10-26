#!/usr/bin/env node
'use strict';
/**
 * The attempt pair a runner presents to the board (issue #1045): `x-factory-job-id` and
 * `x-factory-job-lease-token`. A claim that adopts a surviving runner rotates the lease, but the
 * container's env was fixed at creation, so the supervisor answers the lease it follows now on
 * `GET /attempt` of the agent's control socket (`relayRequest` of driver/src/scripts/supervisor.cjs).
 *
 * Only a 200 carrying a valid token counts; anything else — 404, an error, a hang-up, a cut-off or
 * malformed body, a missing socket, the deadline — is no answer, and the env pair stands. This
 * never decides that an attempt has no pair. The pair is read on every call and never cached.
 *
 * As a command it prints the pair as a curl config on stdout (`node attempt-pair.cjs | curl -K - …`),
 * so the lease rides neither argv nor stderr.
 *
 * Kept byte-identical in both executor images (driver/test/executor-images.test.ts).
 */
const http = require('node:http');

/** The agent's control socket (`control-proxy.cjs`); FACTORY_CONTROL_SOCKET replaces it for the tests' scratch socket. */
const SOCKET = '/run/factory-control/control.sock';
/** One deadline for connecting and reading the body: a helper never waits longer on this. */
const DEADLINE_MS = 2000;
const BODY_LIMIT_BYTES = 1024;
const HTTP_OK = 200;
/** `BINDING_TOKEN` of driver/src/supervisor-plan.ts. */
const TOKEN = /^\S{1,256}$/;

/** The relayed lease, or null for anything but a 200 with a valid token. */
function relayedLease(socketPath, deadlineMs) {
    return new Promise((resolve) => {
        let request;
        const settle = (lease) => {
            request?.destroy();
            resolve(lease);
        };
        try {
            request = http.request({
                socketPath,
                path: '/attempt',
                method: 'GET',
                signal: AbortSignal.timeout(deadlineMs),
            });
        } catch {
            return resolve(null);
        }
        request.on('error', () => settle(null));
        request.on('response', (response) => {
            if (response.statusCode !== HTTP_OK) return settle(null);
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > BODY_LIMIT_BYTES) return settle(null);
                chunks.push(chunk);
            });
            response.on('error', () => settle(null));
            response.on('close', () => {
                if (!response.complete) return settle(null);
                try {
                    const { leaseToken } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    settle(typeof leaseToken === 'string' && TOKEN.test(leaseToken) ? leaseToken : null);
                } catch {
                    settle(null);
                }
            });
        });
        request.end();
    });
}

/** The pair to present now: the env's job id, and the relayed lease where the supervisor names one. */
async function currentPair(env, options = {}) {
    const jobId = (env.RUNNER_JOB_ID ?? '').trim();
    const envLease = (env.RUNNER_LEASE_TOKEN ?? '').trim();
    if (!jobId) return { jobId, leaseToken: envLease };
    const relayed = await relayedLease(options.socket ?? env.FACTORY_CONTROL_SOCKET ?? SOCKET, options.deadlineMs ?? DEADLINE_MS);
    return { jobId, leaseToken: relayed ?? envLease };
}

const quoted = (value) => `"${value.replace(/[\r\n]/g, '').replace(/[\\"]/g, '\\$&')}"`;

if (require.main === module) {
    currentPair(process.env).then(
        ({ jobId, leaseToken }) => {
            process.stdout.write(
                `header = ${quoted(`x-factory-job-id: ${jobId}`)}\nheader = ${quoted(`x-factory-job-lease-token: ${leaseToken}`)}\n`
            );
        },
        () => {
            process.exitCode = 1;
        }
    );
}

module.exports = { currentPair, DEADLINE_MS, SOCKET };
