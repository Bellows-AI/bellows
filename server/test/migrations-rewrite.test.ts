import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../migrations/', import.meta.url);
/** The first file this rule binds; the ones before it are applied everywhere and frozen by their checksums. */
const FIRST_BOUND = 144;
const read = (file: string) => readFileSync(new URL(file, DIR), 'utf8');
/** The SQL without its `--` comments, so prose naming a statement never matches it. */
const sqlOf = (file: string) => read(file).replace(/--[^\n]*/g, '');

/**
 * Every pending file applies in one transaction under the boot lock (docs/persistence.md), so an
 * `add column` whose default is volatile rewrites the whole table there, every row at once. A new
 * column takes no default in its `add`; the default for new rows is set apart, and existing rows
 * are backfilled in bounded batches.
 */
describe('a migration never rewrites a table through a volatile column default', () => {
    const bound = readdirSync(DIR).filter(
        (file) => /^\d+_.*\.sql$/.test(file) && Number(file.slice(0, 3)) >= FIRST_BOUND
    );

    it.each(bound)('%s adds no column with a volatile default', (file) => {
        expect(sqlOf(file)).not.toMatch(
            /add\s+column[^;]*\bdefault\s+(gen_random_uuid|now|clock_timestamp|random|uuid_generate_v4|statement_timestamp)\b/i
        );
    });
});

describe('144: the per-row ingest token', () => {
    const sql = sqlOf('144_job_ingest_token.sql');

    it('adds the column with no default, then sets the default for new rows apart', () => {
        expect(sql).toMatch(/alter table job add column if not exists ingest_token uuid;/);
        expect(sql).toMatch(/alter table job alter column ingest_token set default gen_random_uuid\(\);/);
    });

    // The boot runs every pending file in one transaction, so a backfill here would hold the add's
    // exclusive lock for its whole length. Existing rows take their token lazily: a claim fills a
    // missing one (job-store-claim.ts, job-store-reviews.ts) and verification never matches a null.
    // walks the unfinished rows in bounded batches.
    it('is metadata only: no backfill, no row touched', () => {
        expect(sql).not.toMatch(/\bupdate\b/i);
        expect(sql).not.toMatch(/\bdo\s+\$\$/i);
        expect(sql.trim().split(/;\s*/).filter(Boolean)).toHaveLength(2);
    });

    // A `set not null` is a contract: it waits a release past the last code that may write a null
    // (docs/persistence.md), so it is not in this file.
    it('does not set the column not null in the release that adds it', () => {
        expect(sql).not.toMatch(/set not null/i);
    });
});
