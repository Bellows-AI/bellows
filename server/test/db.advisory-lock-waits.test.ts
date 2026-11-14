import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * The two places a blocking advisory-lock wait may be spelled: the helper that lifts the pool's statement timeout
 * around it, and the migration runner, whose whole transaction runs without one.
 */
const ALLOWED = new Set(['db/pool.ts', 'db/migrate.ts']);
/** A blocking wait; the `pg_try_` forms answer at once and are not waits. */
const BLOCKING_WAIT = /(?<!try_)pg_advisory_(xact_)?lock\(/;

const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return entry.name.endsWith('.ts') ? [path] : [];
    });

describe('advisory-lock waits', () => {
    it('go through waitAdvisoryXactLock, so the statement timeout never cancels a wait for a lock', () => {
        const offenders = sources(SRC)
            .map((path) => relative(SRC, path))
            .filter((path) => !ALLOWED.has(path) && BLOCKING_WAIT.test(readFileSync(join(SRC, path), 'utf8')));
        expect(offenders).toEqual([]);
    });
});
