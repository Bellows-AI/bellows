import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
