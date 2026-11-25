import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trackedFilesContaining } from './fixtures/tracked-files.js';

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Root reads through any mode bits, so an unreadable file means nothing there.
const asRoot = process.getuid?.() === 0;

describe('trackedFilesContaining', () => {
    it.skipIf(asRoot)('skips a tracked file the user cannot open instead of failing the scan', () => {
        const repo = mkdtempSync(join(tmpdir(), 'tracked-files-'));
        dirs.push(repo);
        writeFileSync(join(repo, 'build.sh'), 'docker build .\n');
        writeFileSync(join(repo, 'device-id'), 'docker build .\n');
        execFileSync('git', ['init', '-q', repo]);
        execFileSync('git', ['-C', repo, 'add', '-A']);
        chmodSync(join(repo, 'device-id'), 0o000);
        expect(trackedFilesContaining(repo, 'docker build')).toEqual(['build.sh']);
    });
});
