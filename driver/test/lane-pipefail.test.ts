import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, readRepoFile } from './fixtures/repo-files.js';
import { runAsync } from './fixtures/run-async.js';

/*
 * The lane scripts run under `set -o pipefail`. A pipeline that ends in a reader which quits
 * before EOF (`grep -q`, `head`, `awk … exit`) hands the writer a SIGPIPE, and pipefail then scores a
 * check that found its match as failed. The rule is file-wide (heredocs and job-script strings
 * included) so it needs no parser and no allowlist: read to EOF with `grep … >/dev/null`.
 */

const walk = (dir: string): string[] =>
    readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.sh') ? [join(dir, entry.name)] : []
    );

const pipefailFiles = (): string[] => {
    const roots = [...walk('scripts'), ...walk('docker')].filter((file) =>
        /^\s*set\s+-\w*o\s+pipefail/m.test(readRepoFile(file))
    );
    const found = new Set(roots);
    for (const file of roots) {
        for (const match of readRepoFile(file).matchAll(/^\s*\.\s+"\$(REPO|HERE)\/([^"]+)"/gm)) {
            const base = match[1] === 'REPO' ? '' : dirname(file);
            found.add(relative(REPO_ROOT, join(REPO_ROOT, base, match[2] as string)));
        }
    }
    return [...found].sort();
};

const EARLY_READER =
    /(?<![|\\])\|(?!\|)[ \t]*(?:\\?\n[ \t]*)?(grep\b[^|\n]*\s(?:-[A-Za-z]*[qlLm]|--quiet|--silent|--max-count|--files-with)|head\b|read\b|awk\b[^|\n]*\bexit\b|sed\b[^|\n]*[;{ ]q\b)/g;

const hitsIn = (file: string): string[] => {
    const text = readRepoFile(file).replace(/^[ \t]*#.*$/gm, (comment) => ' '.repeat(comment.length));
    return [...text.matchAll(EARLY_READER)].map((match) => {
        const line = text.slice(0, match.index).split('\n').length;
        return `${file}:${line}: ${text.split('\n')[line - 1]?.trim()}`;
    });
};

describe('lane scripts under pipefail', () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('finds every lane script that sets pipefail and every file it sources', () => {
        expect(pipefailFiles()).toEqual(
            expect.arrayContaining([
                'scripts/test-k8s.sh',
                'scripts/test-jobs.sh',
                'scripts/acceptance-lib.sh',
                'docker/claude-executor/test.sh',
                'docker/opencode-executor/test.sh',
                'docker/tool-isolation-checks.sh',
            ])
        );
    });

    it('ends no pipeline in a reader that quits before EOF', () => {
        expect(pipefailFiles().flatMap(hitsIn)).toEqual([]);
    });

    it('a pipefail pipeline into grep -q fails on a writer still writing, and one into grep >/dev/null does not', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'lane-pipefail-'));
        dirs.push(dir);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, 'big.txt');
        writeFileSync(file, 'y\n'.repeat(500_000));
        const run = (pipeline: string) => runAsync('bash', ['-c', `set -o pipefail; ${pipeline}; echo $?`, '_', file]);
        // A finite writer may finish before grep -q exits (it did on Linux CI), so the early exit is
        // proven against a writer that never finishes: it always takes the SIGPIPE.
        expect((await run('yes y | grep -q y')).stdout.trim()).toBe('141');
        expect((await run('cat "$1" | grep y >/dev/null')).stdout.trim()).toBe('0');
    });
});
