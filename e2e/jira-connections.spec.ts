import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { ADMIN_ROLE, MEMBER_ROLE } from '@factory-ai/core';
import { AUTH_DATABASE_URL, E2E_LOGIN, IDP_PORT } from '../playwright.config.js';
import { throughSignIn } from './signin.js';

/**
 * Jira under Settings → Integrations (Browse to connect, the overview, the connection's own page) and the
 * Workspace and Organization pages that no longer have a Jira panel, through the real board's OAuth flow against the Atlassian stand-in in
 * `e2e/stub-idp.mjs` (`POST /atlassian/_control` picks the account that "consents", or denies).
 *
 * On the `auth` project: the start and callback routes need a signed-in caller. The dialogs'
 * refusals and the write confirmation are web/test/integration-detail.dom.test.tsx's and the catalog's.
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

const CATALOG = '/settings/integrations/available';

/** The connection's own page, reached from the overview's card. */
const openDetail = async (page: Page) => {
    await page.getByRole('link', { name: new RegExp(SITE) }).click();
    await expect(page.getByRole('region', { name: 'Jira connection' })).toBeVisible();
    return page.getByRole('region', { name: 'Jira connection' });
};

/** An overflow entry (Reconnect, Disconnect): open the connection's menu, then pick; the inline action is a plain button. */
async function pickFromMenu(page: Page, name: string) {
    await page.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name }).click();
}

/** Connect from the catalog's Jira card; the consent returns to the Integrations overview. */
async function connect(page: Page, options: { comments?: boolean } = {}) {
    await page.goto(CATALOG);
    await page
        .getByRole('listitem', { name: 'Jira' })
        .getByRole('button', { name: /^Connect( another)?$/ })
        .click();
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
    await connect(page);

    await expect(page.getByText('Jira connected.')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-callback.png`, fullPage: true });
    await expect(page).not.toHaveURL(/result=/);
    const card = page.getByRole('link', { name: new RegExp(SITE) });
    await expect(card).toContainText(ACCOUNT_A);
    const detail = await openDetail(page);
    await expect(detail).toContainText(ACCOUNT_A);
    await expect(detail).toContainText('Tasks can look Jira up.');
    await expect(detail.getByRole('button', { name: 'Allow adding comments' })).toBeVisible();
    await expect(detail.getByRole('textbox')).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-connected.png`, fullPage: true });
    await detail.getByRole('button', { name: /^Actions for / }).click();
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-menu.png`, fullPage: true });
    await expect(page.getByRole('menuitem', { name: 'Reconnect' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Disconnect' })).toBeVisible();
    await page.keyboard.press('Escape');
    // Disconnect (the destructive entry) asks first, then lands on the overview with a one-time notice.
    await pickFromMenu(page, 'Disconnect');
    await page
        .getByRole('dialog', { name: new RegExp(`Disconnect ${SITE}`) })
        .getByRole('button', { name: 'Disconnect' })
        .click();
    await expect(page).toHaveURL(/\/settings\/integrations$/);
    await expect(page.getByText(`Disconnected ${SITE}.`)).toBeVisible();
    await expect(page.getByText('No integrations connected yet.')).toBeVisible();
});

test('reconnecting as another account is refused and the row keeps the first account', async ({ page }) => {
    await connect(page);
    await expect(page.getByText('Jira connected.')).toBeVisible();
    await openDetail(page);
    const detailUrl = page.url();

    await consentAs(page, 'b');
    await pickFromMenu(page, 'Reconnect');
    await expect(page.getByText(/not the account this connection was made with/)).toBeVisible();
    await expect(page).toHaveURL(detailUrl);
    const detail = page.getByRole('region', { name: 'Jira connection' });
    await expect(detail).toContainText(ACCOUNT_A);
    await expect(detail).not.toContainText('stub-account-b');
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-mismatch.png`, fullPage: true });
});

test('a denied consent says so and leaves no connection', async ({ page }) => {
    await consentAs(page, 'a', true);
    await connect(page);

    await expect(page.getByText(/consent was denied/)).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(SITE) })).toHaveCount(0);
    await expect(page.getByText('No integrations connected yet.')).toBeVisible();
});

test('allowing adding comments reconnects and the connection shows write', async ({ page }) => {
    await connect(page);
    await expect(page.getByText('Jira connected.')).toBeVisible();
    const detail = await openDetail(page);
    await expect(detail).toContainText('Tasks can look Jira up.');

    await detail.getByRole('button', { name: 'Allow adding comments' }).click();
    const confirm = page.getByRole('dialog', { name: 'Allow adding comments' });
    await expect(confirm).toContainText('read-bound tasks of this account will be refused');
    await page.screenshot({ path: `${SHOTS}/settings-jira-connections-write-consent.png`, fullPage: true });
    await confirm.getByRole('button', { name: 'Continue to Atlassian' }).click();

    const after = page.getByRole('region', { name: 'Jira connection' });
    await expect(after).toContainText('Tasks can look Jira up and add comments.');
    await expect(after.getByRole('button', { name: 'Allow adding comments' })).toHaveCount(0);
    // Now a write row: Reconnect is its inline action.
    await expect(after.getByRole('button', { name: 'Reconnect' })).toBeVisible();
});

test('a successful return leaves a clean address and the notice does not come back on reload', async ({ page }) => {
    await connect(page);
    await expect(page.getByText('Jira connected.')).toBeVisible();

    const url = new URL(page.url());
    expect(url.pathname).toBe('/settings/integrations');
    expect(url.search).toBe('');
    await page.reload();
    await expect(page.getByRole('link', { name: new RegExp(SITE) })).toBeVisible();
    await expect(page.getByText('Jira connected.')).toHaveCount(0);
});

test('two accounts of one site are two cards with their own addresses, and each page survives a reload', async ({
    page,
}) => {
    await connect(page);
    await expect(page.getByText('Jira connected.')).toBeVisible();
    await consentAs(page, 'b');
    await connect(page);
    await expect(page.getByText('Jira connected.')).toBeVisible();

    const cards = page.getByRole('link', { name: new RegExp(SITE) });
    await expect(cards).toHaveCount(2);
    const hrefs = await cards.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(new Set(hrefs).size).toBe(2);

    await page.goto(hrefs[1]!);
    const detail = page.getByRole('region', { name: 'Jira connection' });
    await expect(detail).toContainText('stub-account-');
    const account = await detail.textContent();
    await page.reload();
    await expect(page.getByRole('region', { name: 'Jira connection' })).toHaveText(account!);
});

test('a stale connection address says it is not found', async ({ page }) => {
    await page.goto('/settings/integrations/jira/00000000-0000-4000-8000-000000000000');
    await expect(page.getByRole('heading', { name: 'Integration not found' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Jira connection' })).toHaveCount(0);
});

const THEMES = ['light', 'dark'] as const;
const WIDTHS: ReadonlyArray<[string, number, number]> = [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
];

test('the overview, the catalog and the Jira page hold at mobile and desktop in both themes', async ({ page }) => {
    await connect(page);
    await expect(page.getByText('Jira connected.')).toBeVisible();
    const overview = page.url();
    const detail = await openDetail(page).then(() => page.url());
    for (const theme of THEMES) {
        await page.emulateMedia({ colorScheme: theme });
        for (const [size, width, height] of WIDTHS) {
            await page.setViewportSize({ width, height });
            for (const [name, url, title] of [
                ['overview', overview, 'Integrations'],
                ['catalog', `${new URL(overview).origin}${CATALOG}`, 'Browse integrations'],
                ['jira-detail', detail, 'Jira'],
            ] as const) {
                await page.goto(url);
                await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
                await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
                const overflow = await page.evaluate(
                    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
                );
                expect(overflow, `${name} overflows at ${size} ${theme}`).toBeLessThanOrEqual(0);
                await page.screenshot({
                    path: `${SHOTS}/settings-integrations-${name}-${size}-${theme}.png`,
                    fullPage: true,
                });
            }
        }
    }
});

test('a member sees no Jira panel on the Organization or Workspace pages', async ({ page }) => {
    await setRole(MEMBER_ROLE);
    await page.goto('/settings/organization');
    await expect(page.getByRole('heading', { name: 'Core (organization)' })).toBeVisible();
    await expect(page.getByRole('region', { name: /Jira/ })).toHaveCount(0);
    await expect(page.getByText(/Jira connection/)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settings-organization-no-jira.png`, fullPage: true });

    await page.goto('/settings/workspace');
    await expect(page.getByRole('heading', { level: 1, name: 'Workspace' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Jira connections' })).toHaveCount(0);

    await page.goto('/settings/integrations');
    await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
});
