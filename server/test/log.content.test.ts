import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureLogs } from './helpers-log.js';

const SRC = new URL('../src/', import.meta.url).pathname;

/** A repository or branch name, however a call site would reach it: `repo`, `claim.repo`, `targetBranch`, `owner`. */
const NAMES = /\b(?:repo|repos|owner|branch|baseBranch|targetBranch|headBranch)\b|\.(?:repo|targetRepo|branch)\b/;

const filesUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
            ? filesUnder(join(dir, entry.name))
            : entry.name.endsWith('.ts')
              ? [join(dir, entry.name)]
              : []
    );

/** Every `logger('x').level(...)` call in a source file, up to the statement's end. */
const callsIn = (source: string): string[] =>
    [...source.matchAll(/\blogger\([^)]*\)\s*\.(?:trace|debug|info|warn|error|fatal)\(/g)].map((match) => {
        const from = match.index ?? 0;
        const end = source.indexOf(';', from);
        return source.slice(from, end === -1 ? undefined : end);
    });

describe('board log content', () => {
    it('no log call spells a repository or a branch name, in its message or its fields', () => {
        const offenders = filesUnder(SRC).flatMap((file) =>
            callsIn(readFileSync(file, 'utf8'))
                .filter((call) => NAMES.test(call))
                .map((call) => `${file.slice(SRC.length)}: ${call.split('\n')[0]}`)
        );
        expect(offenders).toEqual([]);
    });

    it('finds the call sites it guards', () => {
        const calls = filesUnder(SRC).flatMap((file) => callsIn(readFileSync(file, 'utf8')));
        expect(calls.length).toBeGreaterThan(30);
        expect(NAMES.test('claim.repo')).toBe(true);
    });
});

const REPO_ERROR = 'GET /repos/o-x/n-x/pulls/7 failed with 503';

describe('errors in log records', () => {
    it('never carry the message, stack or cause of an error that names a repository', () => {
        const capture = captureLogs();
        const failure = Object.assign(new Error(REPO_ERROR, { cause: new Error(REPO_ERROR) }), {
            status: 503,
            kind: 'transport',
        });
        capture.logger.error({ err: failure, batchId: 'b' }, 'a read failed');
        capture.logger.error(failure);
        capture.logger.error({ err: failure });
        capture.logger.warn({ err: REPO_ERROR }, 'a thrown string');

        for (const name of ['o-x', 'n-x']) expect(capture.everything()).not.toContain(name);
        expect(capture.records()[0]).toMatchObject({ err: { type: 'Error', kind: 'transport', status: 503 } });
        expect(capture.records().map((r) => r.msg)).toEqual(['a read failed', 'error', 'error', 'a thrown string']);
        capture.stop();
    });

    it('is never spelled into a call: no log call or log seam reads an error message', () => {
        const offenders = filesUnder(SRC)
            .filter((file) => !/-cli\.ts$|\/cli\.ts$/.test(file))
            .flatMap((file) =>
                readFileSync(file, 'utf8')
                    .split('\n')
                    .filter(
                        (line) => /\blog(?:ger\([^)]*\))?\.?\w*\(/.test(line) && /\.message\b|errorMessage\(/.test(line)
                    )
                    .map((line) => `${file.slice(SRC.length)}: ${line.trim()}`)
            );
        expect(offenders).toEqual([]);
    });
});
