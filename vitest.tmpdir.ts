import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * One temp directory per worker process, as `TMPDIR`, which `os.tmpdir()` reads at each call. The
 * suites share fixture jobs whose ids and lease tokens are constants, so a path derived from them
 * (the runner's `factory-env-<job>-<lease>.env`) is one file across every fork: a file's run
 * unlinked it under another fork's run between its write and its `create`, which read as a refused
 * start (exit 125). A setup file runs once per test file; the marker keeps the first directory.
 */
const MARK = Symbol.for('bellows.vitest.tmpdir');
const state = globalThis as { [MARK]?: string };
if (state[MARK] === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-worker-'));
    state[MARK] = dir;
    process.env.TMPDIR = dir;
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}
