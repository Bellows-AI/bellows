import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { ADMIN_ROLE, MEMBER_ROLE } from '@factory-ai/core';
import { AUTH_DATABASE_URL, E2E_LOGIN } from '../playwright.config.js';
import { throughSignIn } from './signin.js';
import { ORG_CONNECTION_SCOPE } from '../web/src/api/connections.js';

/**
 * The Jira connection panel on the Organization settings page (#567), read by a member.
 *
 * On the `auth` project: the connection routes need a signed-in caller whose role is real. The
 * offline board cannot reach Atlassian, so a connection is seeded straight into the table (the
 * `setRole` idiom of org-executors.spec.ts). The admin's add dialog and the personal panel are
 * web/test/jira-connections.dom.test.tsx's.
 */

const SHOTS = 'artifacts/ui';
const SITE = 'e2e-seeded-site.atlassian.net';
const SECRET = 'e2e-secret-token-must-never-render';

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(AUTH_DATABASE_URL, { max: 1 });
    try {
        return await run(sql);
    } finally {
        await sql.end();
    }
}

const setRole = (role: string) =>
    withSql((sql) => sql`update org_membership set role = ${role} where github_login = ${E2E_LOGIN}`);

/** One org-wide connection in the signed-in member's organization. */
const seedOrgConnection = () =>
    withSql(
        (sql) => sql`
            insert into connector_connection (org_id, owner_user_id, kind, site, cloud_id, email, api_token, access)
            select org_id, null, 'jira', ${SITE}, 'cloud-e2e', 'bot@example.com', ${SECRET}, 'read'
            from org_membership where github_login = ${E2E_LOGIN} limit 1
        `
    );

const clearConnections = () => withSql((sql) => sql`delete from connector_connection where site = ${SITE}`);

const panel = (page: Page) => page.getByRole('region', { name: 'Organization Jira connections' });

test.afterEach(async () => {
    await clearConnections();
    await setRole(ADMIN_ROLE);
});

test('a member reads the list with no controls, and a forced org create is a 403', async ({ page }) => {
    await seedOrgConnection();
    await throughSignIn(page);
    await setRole(MEMBER_ROLE);
    await page.goto('/settings/organization');

    const row = panel(page).getByRole('row').filter({ hasText: SITE });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Legacy API token');
    await expect(row).toContainText('Shared (legacy)');
    await expect(row).not.toContainText('OAuth');
    await expect(panel(page).getByRole('button')).toHaveCount(0);
    await expect(panel(page).getByRole('textbox')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-member.png`, fullPage: true });

    const forced = await page.request.post('/api/connections', {
        data: { scope: ORG_CONNECTION_SCOPE, site: SITE, email: 'x@example.com', apiToken: 'x' },
    });
    expect(forced.status()).toBe(403);
});
