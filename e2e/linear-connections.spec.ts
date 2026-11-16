import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { IDP_PORT } from '../playwright.config.js';
import { throughSignIn } from './signin.js';

/**
 * Linear under Settings → Integrations: Browse to connect, the overview, the connection's own page, through the real
 * board's OAuth flow against the Linear stand-in in `e2e/stub-idp.mjs` (`POST /linear/_control` picks the account
 * that "consents", or denies; `GET` answers what authorize and revoke recorded).
 *
 * On the `auth` project: the start and callback routes need a signed-in caller. The dialogs' refusals are
 * web/test/integrations-catalog.dom.test.tsx's and web/test/integration-detail.dom.test.tsx's.
 */

const SHOTS = 'artifacts/ui';
const WORKSPACE = 'e2e-workspace';
const ACCOUNT_A = 'stub-linear-a@example.com';
const CATALOG = '/settings/integrations/available';
const CONTROL = `http://127.0.0.1:${IDP_PORT}/linear/_control`;

interface StubState {
    authorized: Array<{ scope: string }>;
    revoked: string[];
}

/** Which stub account "consents" next, and whether the consent is denied; the stub is shared by every test. */
const consentAs = (page: Page, account: 'a' | 'b', deny = false) =>
    page.request.post(CONTROL, { data: { account, deny } });

const stubState = async (page: Page): Promise<StubState> => (await page.request.get(CONTROL)).json();

/** Disconnects every connection the signed-in member holds, the way the page's Disconnect does. */
async function disconnectAll(page: Page) {
    const listed = await page.request.get('/api/connections');
    const { connections } = (await listed.json()) as { connections: Array<{ id: string }> };
    for (const row of connections) await page.request.delete(`/api/connections/${row.id}`);
}

/** Connect from the catalog's Linear card; the consent returns to the Integrations overview. */
async function connect(page: Page, options: { comments?: boolean; shot?: string } = {}) {
    await page.goto(CATALOG);
    const card = page.getByRole('listitem', { name: 'Linear' });
    await expect(card).toContainText('Let tasks look up and comment on your Linear issues.');
    await card.getByRole('button', { name: /^Connect( another)?$/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect Linear' });
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    if (options.comments) await dialog.getByRole('checkbox', { name: 'Allow adding comments' }).check();
    if (options.shot) await page.screenshot({ path: `${SHOTS}/${options.shot}`, fullPage: true });
    await dialog.getByRole('button', { name: 'Continue to Linear' }).click();
}

/** The connection's own page, reached from the overview's card. */
async function openDetail(page: Page) {
    await page.getByRole('link', { name: new RegExp(`Linear.*${WORKSPACE}`) }).click();
    const detail = page.getByRole('region', { name: 'Linear connection' });
    await expect(detail).toBeVisible();
    return detail;
}

async function pickFromMenu(page: Page, name: string) {
    await page.getByRole('button', { name: /^Actions for / }).click();
    await page.getByRole('menuitem', { name }).click();
}

test.beforeEach(async ({ page }) => {
    await throughSignIn(page);
    await disconnectAll(page);
    await consentAs(page, 'a');
});

test.afterEach(async ({ page }) => {
    await disconnectAll(page);
    await consentAs(page, 'a');
});

test('connecting Linear for reading shows Connected on its card and opens its page', async ({ page }) => {
    await page.goto(CATALOG);
    await page.screenshot({ path: `${SHOTS}/settings-linear-catalog.png`, fullPage: true });
    await connect(page, { shot: 'settings-linear-connect-dialog.png' });

    await expect(page.getByText('Linear connected.')).toBeVisible();
    await expect(page).not.toHaveURL(/result=/);
    await page.screenshot({ path: `${SHOTS}/settings-linear-connected.png`, fullPage: true });
    expect((await stubState(page)).authorized.at(-1)?.scope).toBe('read');

    await page.goto(CATALOG);
    await expect(page.getByRole('listitem', { name: 'Linear' })).toContainText('Connected');
    await page.goto('/settings/integrations');
    const detail = await openDetail(page);
    await expect(detail).toContainText(WORKSPACE);
    await expect(detail).toContainText(ACCOUNT_A);
    await expect(detail).toContainText('Tasks can look Linear up.');
    await expect(detail.getByRole('button', { name: 'Allow adding comments' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/settings-linear-detail.png`, fullPage: true });
});

test('allowing adding comments asks Linear for read and write, and the connection shows write', async ({ page }) => {
    await connect(page);
    await expect(page.getByText('Linear connected.')).toBeVisible();
    const detail = await openDetail(page);

    await detail.getByRole('button', { name: 'Allow adding comments' }).click();
    const confirm = page.getByRole('dialog', { name: 'Allow adding comments' });
    await expect(confirm).toContainText(`Linear will ask ${ACCOUNT_A} to approve adding comments.`);
    await page.screenshot({ path: `${SHOTS}/settings-linear-write-consent.png`, fullPage: true });
    await confirm.getByRole('button', { name: 'Continue to Linear' }).click();

    await expect(page.getByText('Linear connected.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Linear connection' })).toContainText(
        'Tasks can look Linear up and add comments.'
    );
    expect((await stubState(page)).authorized.at(-1)?.scope).toBe('read,write');
});

test('reconnecting keeps the connection and its account', async ({ page }) => {
    await connect(page);
    await expect(page.getByText('Linear connected.')).toBeVisible();
    await openDetail(page);
    const detailUrl = page.url();
    const before = (await stubState(page)).authorized.length;

    await pickFromMenu(page, 'Reconnect');
    await expect(page.getByText('Linear connected.')).toBeVisible();
    await expect(page).toHaveURL(detailUrl);
    await expect(page.getByRole('region', { name: 'Linear connection' })).toContainText(ACCOUNT_A);
    expect((await stubState(page)).authorized.length).toBe(before + 1);
});

test('reconnecting as another account is refused and the row keeps the first account', async ({ page }) => {
    await connect(page);
    await expect(page.getByText('Linear connected.')).toBeVisible();
    await openDetail(page);
    const detailUrl = page.url();

    await consentAs(page, 'b');
    await pickFromMenu(page, 'Reconnect');
    await expect(page.getByText(/That Linear account is not the one this connection was made with/)).toBeVisible();
    await expect(page).toHaveURL(detailUrl);
    const detail = page.getByRole('region', { name: 'Linear connection' });
    await expect(detail).toContainText(ACCOUNT_A);
    await expect(detail).not.toContainText('stub-linear-b');
    await page.screenshot({ path: `${SHOTS}/settings-linear-mismatch.png`, fullPage: true });
});

test('a denied consent says so and leaves no connection', async ({ page }) => {
    await consentAs(page, 'a', true);
    await connect(page);

    await expect(page.getByText('Linear consent was denied; nothing was connected.')).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(WORKSPACE) })).toHaveCount(0);
    await expect(page.getByText('No integrations connected yet.')).toBeVisible();
});

test('disconnecting asks first, returns to the overview and revokes the token at Linear', async ({ page }) => {
    await connect(page);
    await expect(page.getByText('Linear connected.')).toBeVisible();
    await openDetail(page);
    const revokedBefore = (await stubState(page)).revoked.length;

    await pickFromMenu(page, 'Disconnect');
    await page
        .getByRole('dialog', { name: new RegExp(`Disconnect ${WORKSPACE}`) })
        .getByRole('button', { name: 'Disconnect' })
        .click();
    await expect(page).toHaveURL(/\/settings\/integrations$/);
    await expect(page.getByText(`Disconnected ${WORKSPACE}.`)).toBeVisible();
    await expect(page.getByText('No integrations connected yet.')).toBeVisible();
    await expect.poll(async () => (await stubState(page)).revoked.length).toBeGreaterThan(revokedBefore);
});
