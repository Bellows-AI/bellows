import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;

/** What an interpolation into a log line may not spell: an error's own words, a tool's output, a token, a repo or branch. */
const BANNED =
    /\.message\b|\.why\b|\.(?:stderr|stdout|output)\b|[tT]oken|\b(?:repo|owner|branch|baseBranch|targetBranch|prUrl|url)\b|\.(?:repo|branch|prUrl)\b/;

/** Driver log seams: the injected `log` functions, the pino components, and `ctx.log` / `rt.log` / `io.log`. */
const CALL =
    /(?:\b(?:rt|ctx|io|deps)\.log|(?<![.\w])log|\blogger\([^)]*\)\.(?:trace|debug|info|warn|error|fatal)|\blog\.\w+\.(?:trace|debug|info|warn|error|fatal))\(/g;

const filesUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === 'scripts' ? [] : filesUnder(path);
        return entry.name.endsWith('.ts') ? [path] : [];
    });

/** The argument text of each call: from its `(` to the matching `)`. */
function callsIn(source: string): string[] {
    return [...source.matchAll(CALL)].map((match) => {
        const from = (match.index ?? 0) + match[0].length;
        let depth = 1;
        let at = from;
        while (at < source.length && depth > 0) {
            if (source[at] === '(') depth++;
            if (source[at] === ')') depth--;
            at++;
        }
        return source.slice(from, at - 1);
    });
}

const interpolations = (call: string): string[] => [...call.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!);

describe('driver log content', () => {
    it('no log call interpolates an error message, tool output, token, repository or branch name', () => {
        const offenders = filesUnder(SRC)
            .filter((file) => !file.endsWith('/log.ts'))
            .flatMap((file) =>
                callsIn(readFileSync(file, 'utf8'))
                    .flatMap(interpolations)
                    .filter((expression) => BANNED.test(expression))
                    .map((expression) => `${file.slice(SRC.length)}: \${${expression}}`)
            );
        expect(offenders).toEqual([]);
    });

    it('finds the call sites it guards', () => {
        const calls = filesUnder(SRC).flatMap((file) => callsIn(readFileSync(file, 'utf8')));
        expect(calls.length).toBeGreaterThan(80);
        expect(interpolations('a ${e.message} b ${x}')).toEqual(['e.message', 'x']);
        expect(BANNED.test('group.leaseToken')).toBe(true);
        expect(BANNED.test('describeError(e)')).toBe(false);
    });
});
