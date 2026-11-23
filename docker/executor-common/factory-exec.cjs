#!/usr/bin/env node
'use strict';
/*
 * `factory-exec '<command>'`: run one command in the task's environment image, in the attempt's own gate
 * container, in the task worktree.
 *
 * Like `factory-gate`, so the managed allowlist can pre-approve exactly this command
 * (`Bash(factory-exec *)`): the destination is fixed, POST /tools/call on the agent's control socket with
 * `{"tool": "exec", "input": {"command": "<command>"}}`, built by an encoder. The command is ONE argument, run by the gate container's
 * `sh -c`; the driver runs it unrecorded, with no GitHub token, under a 10-minute cap, one at a time with
 * the task's gates, and never runs the environment's pending setup first.
 *
 * Exit codes are `factory-gate`'s (`control-call.cjs`): 0 a 2xx answer, whose JSON carries the command's own
 * `exitCode` and `output`; 22 any other status; 2 a usage error or a request over 4096 bytes; 3 there is no
 * environment image here; 75 no usable answer, after which the command may or may not have run.
 *
 * One file, built into both executor images (driver/test/factory-wrappers.test.ts).
 */
const { BODY_LIMIT, EXIT_USAGE, controlCall, fail: failAs } = require('./control-call.cjs');

const USAGE = "usage: factory-exec '<command>' (one quoted argument)";
const NAME = 'factory-exec';

const fail = (code, message) => failAs(NAME, code, message);

/** The request body for argv: exactly one non-blank command, small enough for the driver to take. */
function bodyOf(args) {
    if (args.length !== 1 || !args[0].trim()) fail(EXIT_USAGE, USAGE);
    const body = { tool: 'exec', input: { command: args[0] } };
    if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT) {
        fail(EXIT_USAGE, `command too long: the request must fit ${BODY_LIMIT} bytes; write a script and run it`);
    }
    return body;
}

function main() {
    controlCall({
        name: NAME,
        body: bodyOf(process.argv.slice(2)),
        what: 'exec run',
        retryNote: 'the command may or may not have run',
        noGates: 'there is no environment image here (exit 3): run the command in your own shell instead',
    });
}

main();
