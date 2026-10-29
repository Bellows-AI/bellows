import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { ADMIN_ROLE, MEMBER_ROLE } from '@factory-ai/core';
import { AUTH_DATABASE_URL, E2E_LOGIN, IDP_PORT } from '../playwright.config.js';
import { throughSignIn } from './signin.js';

/**
 * The Jira connections of the Workspace settings page and the Organization page that no longer has
 * one (BEL-61), through the real board's OAuth flow against the Atlassian stand-in in
 * `e2e/stub-idp.mjs` (`POST /atlassian/_control` picks the account that "consents", or denies).
 *
 * On the `auth` project: the start and callback routes need a signed-in caller. The dialogs'
 * refusals and the write confirmation are web/test/jira-connections.dom.test.tsx's.
 */

const SHOTS = 'artifacts/ui';
const SITE = 'e2e-site.atlassian.net';
const ACCOUNT_A = 'stub-account-a@example.com';

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

/** Which stub account "consents" next, and whether the consent is denied; the stub is shared by every test. */
const consentAs = (page: Page, account: 'a' | 'b', deny = false) =>
    page.request.post(`http://127.0.0.1:${IDP_PORT}/atlassian/_control`, { data: { account, deny } });

/** Disconnects every Jira connection the signed-in member holds, the way the page's Disconnect does. */
async function disconnectAll(page: Page) {
    const listed = await page.request.get('/api/connections');
    const { connections } = (await listed.json()) as { connections: Array<{ id: string }> };
    for (const row of connections) await page.request.delete(`/api/connections/${row.id}`);
}

const panel = (page: Page) => page.getByRole('region', { name: 'Jira connections' });

async function connect(page: Page, options: { comments?: boolean } = {}) {
    await page.getByRole('button', { name: 'Connect Jira' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Jira' });
    if (options.comments) await dialog.getByRole('checkbox', { name: 'Allow adding comments' }).check();
    await dialog.getByRole('button', { name: 'Continue to Atlassian' }).click();
}

test.beforeEach(async ({ page }) => {
    await throughSignIn(page);
    await setRole(ADMIN_ROLE);
    await disconnectAll(page);
    await consentAs(page, 'a');
});

test.afterEach(async ({ page }) => {
    await disconnectAll(page);
    await consentAs(page, 'a');
    await setRole(ADMIN_ROLE);
});

test('connecting through the stub shows the site, the account and read access', async ({ page }) => {
    await page.goto('/settings/workspace');
    await expect(panel(page).getByText('No Jira connections yet.')).toBeVisible();
    await connect(page);

    await page.waitForURL(/integration=jira&result=connected/);
    await expect(panel(page).getByText('Jira connected.')).toBeVisible();
    const row = panel(page).getByRole('row').filter({ hasText: SITE });
    await expect(row).toContainText(ACCOUNT_A);
    await expect(row).toContainText('read');
    await expect(row.getByRole('button', { name: /^Reconnect/ })).toBeVisible();
    await expect(row.getByRole('button', { name: /^Disconnect/ })).toBeVisible();
    await expect(panel(page).getByRole('textbox')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-connected.png`, fullPage: true });
});

test('reconnecting as another account is refused and the row keeps the first account', async ({ page }) => {
    await page.goto('/settings/workspace');
    await connect(page);
    await page.waitForURL(/result=connected/);

    await consentAs(page, 'b');
    await panel(page)
        .getByRole('button', { name: /^Reconnect/ })
        .click();
    await page.waitForURL(/result=identity-mismatch/);
    await expect(panel(page).getByText(/not the account this connection was made with/)).toBeVisible();
    const row = panel(page).getByRole('row').filter({ hasText: SITE });
    await expect(row).toContainText(ACCOUNT_A);
    await expect(row).not.toContainText('stub-account-b');
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-mismatch.png`, fullPage: true });
});

test('a denied consent says so and leaves no row', async ({ page }) => {
    await page.goto('/settings/workspace');
    await consentAs(page, 'a', true);
    await connect(page);

    await page.waitForURL(/result=denied/);
    await expect(panel(page).getByText(/consent was denied/)).toBeVisible();
    await expect(panel(page).getByRole('row').filter({ hasText: SITE })).toHaveCount(0);
    await expect(panel(page).getByText('No Jira connections yet.')).toBeVisible();
});

test('allowing adding comments reconnects and the row shows write', async ({ page }) => {
    await page.goto('/settings/workspace');
    await connect(page);
    await page.waitForURL(/result=connected/);
    const row = panel(page).getByRole('row').filter({ hasText: SITE });
    await expect(row).toContainText('read');

    await row.getByRole('button', { name: /^Allow adding comments/ }).click();
    const confirm = page.getByRole('dialog', { name: 'Allow adding comments' });
    await expect(confirm).toContainText('read-bound tasks of this account will be refused');
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-write-consent.png`, fullPage: true });
    await confirm.getByRole('button', { name: 'Continue to Atlassian' }).click();

    await page.waitForURL(/result=connected/);
    await expect(row).toContainText('write');
    await expect(row.getByRole('button', { name: /^Allow adding comments/ })).toHaveCount(0);
});

test('a member sees no Jira panel on the Organization page, and their own on Workspace', async ({ page }) => {
    await setRole(MEMBER_ROLE);
    await page.goto('/settings/organization');
    await expect(page.getByRole('heading', { name: 'Core (organization)' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Jira/ })).toHaveCount(0);
    await expect(page.getByText(/Jira connection/)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settings-organization-no-jira.png`, fullPage: true });

    await page.goto('/settings/workspace');
    await expect(panel(page)).toBeVisible();
});
