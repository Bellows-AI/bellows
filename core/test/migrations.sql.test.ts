import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The schema guards that used to live as a comment header copied into every migration (#371).
 * A header asks; this asserts — and `npm run test:db` is not in CI, so an offline suite is the
 * only place a stray `create extension` is caught before it reaches a managed PostgreSQL that
 * has none installed.
 */
const DIR = fileURLToPath(new URL('../../server/migrations/', import.meta.url));
const names = readdirSync(DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
const read = (name: string) => readFileSync(join(DIR, name), 'utf8');

describe('migrations', () => {
    it('reads the real directory, so an empty sweep cannot pass for a clean one', () => {
        expect(names.length).toBeGreaterThan(40);
        expect(names).toContain('001_init.sql');
    });

    it('names no TimescaleDB object anywhere in the schema', () => {
        for (const name of names) {
            expect(read(name), name).not.toMatch(/timescaledb/i);
            expect(read(name), name).not.toMatch(/create_hypertable|time_bucket/);
        }
    });

    it('creates no extension, so the chart runs on RDS, Aurora or any managed PostgreSQL', () => {
        // Comment lines are stripped rather than the match being line-anchored: 005 and 006
        // explain in prose why there is no extension, and an anchor would also miss a real
        // `…; create extension pgcrypto;` sharing a line with the statement before it.
        for (const name of names) {
            const code = read(name)
                .split('\n')
                .filter((line) => !line.trimStart().startsWith('--'))
                .join('\n');
            expect(code, name).not.toMatch(/create\s+extension/i);
        }
    });

    it('can all run inside the one transaction the migration lock holds', () => {
        // server/src/db/migrate.ts applies every pending file in one transaction under an advisory
        // xact lock; these statements refuse to run inside a transaction block.
        for (const name of names) {
            const code = read(name)
                .split('\n')
                .filter((line) => !line.trimStart().startsWith('--'))
                .join('\n');
            expect(code, name).not.toMatch(
                /\bconcurrently\b|\bvacuum\b|alter\s+system|alter\s+type\b[^;]*\badd\s+value/i
            );
            expect(code, name).not.toMatch(/^\s*(begin|commit|rollback)\s*;/im);
        }
    });

    it('range-partitions metric_point on time, covered by a DEFAULT partition', () => {
        const init = read('001_init.sql');
        expect(init).toMatch(/partition by range \(time\)/);
        // Without a covering partition a range-partitioned table rejects every insert — a
        // failure mode the hypertable did not have.
        expect(init).toMatch(/partition of metric_point default/);
    });

    /**
     * Repeatable files leave no ledger row, so an older build knows a database is ahead of it only by
     * a versioned file it does not ship (server/src/db/migrate.ts). A change to a repeatable file
     * therefore ships a no-op marker migration named after the repeatable files' hash, and the newest
     * marker must name the current hash: a released build cannot ship a newer marker than its own, and
     * a revert to an earlier definition needs a new number too. Iterating on a view before merge
     * renames the marker; a dev database that applied the old name reads as ahead (views frozen) until
     * that ledger row is deleted.
     */
    const newestMarkerNames = (all: readonly string[], sha: string): boolean => {
        const markers = all.filter((name) => /^\d+_views_[0-9a-f]{16}\.sql$/.test(name)).sort();
        return markers.at(-1)?.endsWith(`_views_${sha}.sql`) ?? false;
    };

    it('ships a newest versioned marker named after the current repeatable files', () => {
        const hash = createHash('sha256');
        for (const name of names.filter((n) => n.endsWith('.repeatable.sql'))) hash.update(`${name}\0${read(name)}\0`);
        const sha = hash.digest('hex').slice(0, 16);

        expect(
            newestMarkerNames(names, sha),
            `a repeatable file changed: add a no-op versioned migration named <next number>_views_${sha}.sql`
        ).toBe(true);
    });

    it('a revert to an earlier view definition still needs a new marker', () => {
        const a = 'aaaaaaaaaaaaaaaa';
        const b = 'bbbbbbbbbbbbbbbb';
        expect(newestMarkerNames([`090_views_${a}.sql`, `091_views_${b}.sql`], a)).toBe(false);
        expect(newestMarkerNames([`090_views_${a}.sql`, `091_views_${b}.sql`, `092_views_${a}.sql`], a)).toBe(true);
        expect(newestMarkerNames(['001_init.sql'], a)).toBe(false);
    });
});
