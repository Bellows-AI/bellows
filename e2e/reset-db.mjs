/**
 * Empty every table verify:ui is about to reseed and drive, so a local run starts from the same
 * state as CI's new database.
 *
 * The seed is additive (`on conflict do nothing`) and every run generates fresh session ids, so
 * without this the databases accumulate one generator window per run: the "All time" range grows
 * a little every run and the cold first stats fetch eventually outlives the test timeout — a
 * failure that looks like a UI bug and is really six months of stacked synthetic Marches. The
 * config comment promises every run reads exactly what this run's generator produces; the TRUNCATE
 * below is what keeps that promise true. It runs before the seed, which runs before any server.
 *
 * Specs write rows too, and the auth board keeps them: an org's first materialized membership
 * lands `admin`, so a membership left by the previous run turns the next run's sign-in into a
 * `member` and fails a first-member assertion. Hence the whole schema rather than the seed's
 * tables — only the migration ledger survives, so the schema is not re-applied over itself.
 *
 * The same disposable-name rule as the seed's guard, one step earlier — this script deletes, so
 * it refuses louder.
 *
 * DATABASE_URL comes from playwright.config.ts, which names the databases `${E2E_DB_PREFIX}_e2e`
 * and `${E2E_DB_PREFIX}_auth_e2e` — the `_e2e` suffix is what satisfies DISPOSABLE below.
 */
import postgres from 'postgres';

const DISPOSABLE = /_(seed|synthetic|demo|e2e|test)$/;

const url = process.env.DATABASE_URL;
if (!url) {
    console.error('reset-db requires DATABASE_URL');
    process.exit(1);
}
const name = new URL(url).pathname.replace(/^\//, '');
if (!DISPOSABLE.test(name)) {
    console.error(
        `Refusing to reset "${name}": this script TRUNCATES data. Point it at a database whose\n` +
            `name ends in _seed, _synthetic, _demo, _e2e or _test.`
    );
    process.exit(1);
}

const sql = postgres(url, { max: 1 });
try {
    // The disposable-name guard above bounds every deletion to test data. A database that has
    // never been migrated has no tables yet — "nothing to reset" is success, not an error.
    const tables = (
        await sql`
            select tablename from pg_tables
            where schemaname = current_schema() and tablename <> 'schema_migrations'
        `
    ).map((row) => row.tablename);
    if (tables.length) await sql`truncate table ${sql(tables)} restart identity cascade`;
    console.log(`[reset-db] ${name}: ${tables.length} tables truncated`);
} finally {
    await sql.end();
}
