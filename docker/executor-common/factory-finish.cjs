#!/usr/bin/env node
'use strict';
/*
 * `factory-finish`: asks the driver's finish pass whether the agent may stop. The claude Stop hook
 * (`finish-hook.cjs`) and the opencode entrypoint's loop both call it, so the two executors share one
 * contract:
 *
 *   exit 10, the driver's `message` on stdout   a `fail` answer: the agent fixes the gate and finishes again
 *   exit 0, nothing on stdout                    anything else: pass, skip, cap, unavailable, 404 no gates,
 *                                                any other status, a malformed answer, or a give-up
 *
 * It fails open: only a confirmed `fail` blocks the stop, and the close-time verifier judges every run
 * this lets through. A no-usable-answer (the proxy socket missing or refusing, a cut relay's 502, a
 * retryable 503 before the pass opens, an answer cut short or not JSON) is asked again every 5 s until
 * BELLOWS_FINISH_RETRY_MS of wall clock has passed since the first one, then given up: a healthy gate that
 * holds an ask open spends none of the window, so a takeover late in a long gate is still asked again. An
 * unset or malformed window is the default one, never zero. A container with no supervisor relay
 * (FACTORY_CTL_OUT without its control.sock) has nobody to ask and stops at once.
 *
 * One invocation is one stop: it mints one request id and sends it on its first ask and on every retry, so
 * a pass the driver answered but whose answer never arrived (a cut relay, a takeover) is replayed under the
 * same round on the board, never spent again. The next stop is the next invocation, with an id of its own.
 *
 * It never sees the run-control credential: the proxy socket takes none, the supervisor attaches it.
 */
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parsed, post, retryWhy } = require('./control-call.cjs');

const NAME = 'factory-finish';
/** `FINISH_PATH` of driver/src/control-channel.ts. */
const FINISH_PATH = '/gate/finish';
/** The exit that blocks the stop; its stdout is the text the agent is given. */
const EXIT_BLOCK = 10;
/** The pause between asks. */
const RETRY_STEP_MS = 5_000;
/** The driver's own value for a default config (`FINISH_RETRY_ENV`, driver/src/runner-plan.ts). */
const DEFAULT_WINDOW_MS = 640_000;
/** The supervisor's relay socket in the agent's mailbox (`RELAY_SOCKET` of control-proxy.cjs). */
const RELAY_SOCKET = 'control.sock';

/** A positive whole number of milliseconds, or the default. */
function windowMs(value) {
    return /^\d+$/.test(value ?? '') && Number(value) > 0 ? Number(value) : DEFAULT_WINDOW_MS;
}

/** Lets the stop through, saying why on stderr only. */
function letStop(why) {
    process.stderr.write(`${NAME}: ${why}; letting the stop through\n`);
    process.exit(0);
}

function relayExists() {
    const out = process.env.FACTORY_CTL_OUT;
    if (!out) return false;
    try {
        return fs.statSync(path.join(out, RELAY_SOCKET)).isSocket();
    } catch {
        return false;
    }
}

/** The text a `fail` answer blocks with, or undefined for any other answer. */
function blockText(status, json) {
    if (status !== 200 || json === null || typeof json !== 'object' || json.verdict !== 'fail') return undefined;
    return typeof json.message === 'string' && json.message !== '' ? json.message : undefined;
}

async function main() {
    if (!relayExists()) return letStop('no run-control relay in this container');
    const window = windowMs(process.env.BELLOWS_FINISH_RETRY_MS);
    const body = { requestId: randomUUID() };
    let failedAt;
    for (;;) {
        const result = await post({ path: FINISH_PATH, body });
        const json = result.cut === undefined ? parsed(result.text) : undefined;
        const why = result.cut ?? retryWhy(result.status, json, 'finish pass');
        if (why === undefined) {
            const text = blockText(result.status, json);
            if (text === undefined) return letStop(`the finish pass answered HTTP ${result.status} without a failure`);
            process.stdout.write(text, () => process.exit(EXIT_BLOCK));
            return;
        }
        failedAt ??= Date.now();
        const left = window - (Date.now() - failedAt);
        if (left <= 0) return letStop(`no answer from the finish pass (${why}) within ${window} ms`);
        await new Promise((resolve) => setTimeout(resolve, Math.min(RETRY_STEP_MS, left)));
    }
}

main();
