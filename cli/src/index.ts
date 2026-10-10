#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { run } from './run.js';

// A local interrupt aborts the in-flight request; the command then ends `interrupted`, which is
// not a remote cancellation — the task on the board is untouched.
const interrupt = new AbortController();
process.once('SIGINT', () => interrupt.abort());
process.once('SIGTERM', () => interrupt.abort());

process.exitCode = await run(process.argv.slice(2), {
    env: process.env,
    signal: interrupt.signal,
    readFile: (path) => readFile(path, 'utf8'),
    readStdin: () => text(process.stdin),
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
});
