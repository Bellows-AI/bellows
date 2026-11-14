import { randomInt } from 'node:crypto';
import { ADMIN_ROLE } from '@factory-ai/core';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { IDP_PORT } from '../playwright.config.js';
import { setRole } from './roles.js';
import { finishSignIn, throughSignIn } from './signin.js';

/**
 * An admin's member access, end to end on the `auth` board: the invitation is the org's sign-in link, a new
 * account that follows it appears in the roster; a removal keeps that account out across its next sign-in; a
 * restore lets the sign-in after it back in. The stub IdP signs the invitee in (`POST /_control/identity`); the
 * board has no GitHub App, so GitHub's member list is reported unavailable and only the link is offered.
 */

const SHOTS = 'artifacts/ui';
const IDP = `http://127.0.0.1:${IDP_PORT}`;
const INVITEE = { login: `invitee-${randomInt(1e6)}`, id: 500_000_000 + randomInt(1e6) };

const roster = (page: Page) => page.getByRole('region', { name: 'Organization members' });
const removedList = (page: Page) => page.getByRole('region', { name: 'Removed members' });

/**
 * Signs the invitee in through `link` in a fresh browser context, ticking the invited organization on the selection
 * screen the link opens (the stub reports two installations, so a tracked other one never stands in for it).
 */
async function inviteeSignsIn(browser: Browser, page: Page, link: string) {
    const org = new URL(link).searchParams.get('org');
    await page.request.post(`${IDP}/_control/identity`, { data: INVITEE });
    const context = await browser.newContext();
    try {
        const invitee = await context.newPage();
        await invitee.goto(link);
        await expect(invitee.locator('.onboarding')).toBeVisible({ timeout: 60_000 });
        await invitee.getByRole('checkbox', { name: new RegExp(`stub-org-${org}`) }).check();
        await finishSignIn(invitee);
    } finally {
        await context.close();
        await page.request.post(`${IDP}/_control/identity`, { data: {} });
    }
}

test('invite, remove and restore a member', async ({ page, browser }) => {
    await throughSignIn(page);
    await setRole(ADMIN_ROLE);
    await page.goto('/settings/organization');

    const invite = page.locator('section.panel', { has: page.getByRole('heading', { name: 'Invite members' }) });
    await expect(invite.getByText("GitHub's member list is unavailable")).toBeVisible();
    const link = (await invite.locator('.mono').textContent()) ?? '';
    expect(link).toMatch(/\/api\/auth\/github\?org=\d+&reselect=1$/);
    await page.screenshot({ path: `${SHOTS}/settings-members-invite.png`, fullPage: true });

    // Invite: the new account follows the link and appears as a member.
    await inviteeSignsIn(browser, page, link);
    await page.reload();
    await expect(roster(page).getByText(INVITEE.login)).toBeVisible();

    // Remove, behind the confirmation; the next sign-in, the org ticked, does not bring the membership back.
    await roster(page)
        .getByRole('button', { name: `Remove ${INVITEE.login}` })
        .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('their personal tokens are revoked');
    await page.screenshot({ path: `${SHOTS}/settings-members-remove-confirm.png` });
    await dialog.getByRole('button', { name: 'Remove member' }).click();
    await expect(removedList(page).getByText(INVITEE.login)).toBeVisible();
    await expect(roster(page).getByText(INVITEE.login)).toHaveCount(0);

    await inviteeSignsIn(browser, page, link);
    await page.reload();
    await expect(removedList(page).getByText(INVITEE.login)).toBeVisible();
    await expect(roster(page).getByText(INVITEE.login)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settings-members-removed.png`, fullPage: true });

    // Restore: the removed list empties, and the sign-in after it admits the account again.
    await removedList(page)
        .getByRole('button', { name: `Restore ${INVITEE.login}` })
        .click();
    await expect(removedList(page)).toHaveCount(0);
    await inviteeSignsIn(browser, page, link);
    await page.reload();
    await expect(roster(page).getByText(INVITEE.login)).toBeVisible();
});
