#!/usr/bin/env node
'use strict';
// Claude Code's gate Stop hook, beside the prose-question prompt hook in settings.json. It runs the
// shared finish helper (`factory-finish.cjs`, beside it in /usr/local/bin) and, when the helper exits
// 10, blocks the stop with the helper's text: the agent fixes the red gate and finishes again. Any
// other outcome — the helper missing, killed or exiting otherwise — lets the stop through, and the
// close-time verifier judges the run. The hook input's "already continuing from a stop hook" flag is
// ignored on purpose: the driver's round counter is the only bound on the loop. The helper's stderr is
// passed through; the control credential never reaches this process.
const { spawn } = require('node:child_process');
const path = require('node:path');

const EXIT_BLOCK = 10;

// The hook input is not needed; it is drained so Claude Code's write of it never meets a full pipe.
process.stdin.on('error', () => {});
process.stdin.resume();

const helper = spawn(process.execPath, [path.join(__dirname, 'factory-finish.cjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
});
let text = '';
helper.stdout.setEncoding('utf8');
helper.stdout.on('data', (chunk) => (text += chunk));
helper.on('error', () => process.exit(0));
helper.on('close', (code) => {
    if (code !== EXIT_BLOCK || text === '') process.exit(0);
    process.stdout.write(`${JSON.stringify({ decision: 'block', reason: text })}\n`, () => process.exit(0));
});
// Claude Code cancels a hook that reaches its timeout; the helper's ask goes with it.
process.on('SIGTERM', () => {
    helper.kill('SIGTERM');
    process.exit(0);
});
