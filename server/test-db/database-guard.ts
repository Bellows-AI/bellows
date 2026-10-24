// Kept free of vitest imports: the global setup and the config load this outside a test run.

/**
 * These suites truncate their tables, so pointing them at the database the dashboard actually
 * uses destroys real history — including anything imported by `npm run backfill`. Requiring a
 * `_test` database name is the guard, because the failure is silent: the tests pass and the
 * data is simply gone.
 */
export function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(
            `Refusing to run: this suite truncates its tables, and "${name}" is not a test database.\n` +
                `Create one and point DATABASE_URL at it:\n` +
                `  docker compose exec postgres psql -U factory -d postgres -c 'create database factory_test'\n` +
                `  DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_test npm run test:db`
        );
    }
}
