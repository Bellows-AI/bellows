import postgres from 'postgres';
import { AUTH_DATABASE_URL, E2E_LOGIN } from '../playwright.config.js';

/**
 * Sets the stub member's role on the `auth` board. Test infrastructure: the same direct-SQL idiom as
 * e2e/reset-db.mjs; the role is read per request through the session join, so a reload is all it takes
 * to see. Only the stub member's own memberships: the local organization's seeded admin
 * (db/migrate.ts) is not a spec's to rewrite.
 */
export async function setRole(role: string) {
    const sql = postgres(AUTH_DATABASE_URL, { max: 1 });
    try {
        await sql`update org_membership set role = ${role} where github_login = ${E2E_LOGIN}`;
    } finally {
        await sql.end();
    }
}
