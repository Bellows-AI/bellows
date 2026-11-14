import { randomInt } from 'node:crypto';
import { ADMIN_ROLE } from '@factory-ai/core';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { IDP_PORT } from '../playwright.config.js';
import { setRole } from './roles.js';
import { finishSignIn, throughSignIn } from './signin.js';

/**
 * An admin's member access, end to end on the `auth` board: the invitation is the org's sign-in link, a new
 * account that follows it appears in the roster; a removal keeps that account out across its next sign-in, the link
 * no longer pre-ticking the org; a restore lets the sign-in after it back in with the org pre-ticked, so the restored
 * member lands there in one click. The stub IdP signs the invitee in (`POST /_control/identity`); the
 * board has no GitHub App, so GitHub's member list is reported unavailable and only the link is offered.
 */

const SHOTS = 'artifacts/ui';
const IDP = `http://127.0.0.1:${IDP_PORT}`;
const INVITEE = { login: `invitee-${randomInt(1e6)}`, id: 500_000_000 + randomInt(1e6) };

const roster = (page: Page) => page.getByRole('region', { name: 'Organization members' });
const removedList = (page: Page) => page.getByRole('region', { name: 'Removed members' });

/**
 * Signs the invitee in through `link` in a fresh browser context and returns the org it landed in. The selection
 * screen the link opens shows the invited organization `ticked` (and marked as requested) or `unticked`; an unticked
 * one is ticked by hand, a ticked one is left alone, so a pass proves the link did it. The stub reports two
 * installations, so a tracked other one never stands in for it. `shot` screenshots the screen as it opened.
 */
async function inviteeSignsIn(
    browser: Browser,
    page: Page,
    link: string,
    opts: { expect: 'ticked' | 'unticked'; shot?: string }
): Promise<string> {
    const org = new URL(link).searchParams.get('org');
    await page.request.post(`${IDP}/_control/identity`, { data: INVITEE });
    const context = await browser.newContext();
    try {
        const invitee = await context.newPage();
        await invitee.goto(link);
        await expect(invitee.locator('.onboarding')).toBeVisible({ timeout: 60_000 });
        const box = invitee.getByRole('checkbox', { name: new RegExp(`stub-org-${org}`) });
        const requested = invitee.getByText('Requested for this sign-in');
        if (opts.expect === 'ticked') {
            await expect(box).toBeChecked();
            await expect(requested).toBeVisible();
        } else {
            await expect(box).not.toBeChecked();
            await expect(requested).toHaveCount(0);
        }
        if (opts.shot) await invitee.screenshot({ path: `${SHOTS}/${opts.shot}`, fullPage: true });
        if (opts.expect === 'unticked') await box.check();
        await finishSignIn(invitee);
        const me = await invitee.request.get('/api/auth/me');
        return (await me.json()).organization.id as string;
    } finally {
        await context.close();
        await page.request.post(`${IDP}/_control/identity`, { data: {} });
    }
}

test('invite, remove and restore a member — the restored member’s link lands in one click', async ({
    page,
    browser,
}) => {
    await throughSignIn(page);
    await setRole(ADMIN_ROLE);
    await page.goto('/settings/organization');

    const invite = page.locator('section.panel', { has: page.getByRole('heading', { name: 'Invite members' }) });
    await expect(invite.getByText("GitHub's member list is unavailable")).toBeVisible();
    const link = (await invite.locator('.mono').textContent()) ?? '';
    expect(link).toMatch(/\/api\/auth\/github\?org=\d+&reselect=1$/);
    await page.screenshot({ path: `${SHOTS}/settings-members-invite.png`, fullPage: true });

    const org = new URL(link).searchParams.get('org');

    // Invite: the new account follows the link and appears as a member. A first sign-in pre-ticks everything.
    expect(await inviteeSignsIn(browser, page, link, { expect: 'ticked' })).toBe(org);
    await page.reload();
    await expect(roster(page).getByText(INVITEE.login)).toBeVisible();

    // Remove, behind the confirmation; the next sign-in, the org ticked by hand, does not bring the membership back.
    // The link no longer pre-ticks or marks the org.
    await roster(page)
        .getByRole('button', { name: `Remove ${INVITEE.login}` })
        .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('their personal tokens are revoked');
    await page.screenshot({ path: `${SHOTS}/settings-members-remove-confirm.png` });
    await dialog.getByRole('button', { name: 'Remove member' }).click();
    await expect(removedList(page).getByText(INVITEE.login)).toBeVisible();
    await expect(roster(page).getByText(INVITEE.login)).toHaveCount(0);

    expect(await inviteeSignsIn(browser, page, link, { expect: 'unticked' })).not.toBe(org);
    await page.reload();
    await expect(removedList(page).getByText(INVITEE.login)).toBeVisible();
    await expect(roster(page).getByText(INVITEE.login)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/settings-members-removed.png`, fullPage: true });

    // Restore: the removed list empties, and the link's screen opens with the org pre-ticked — Continue alone
    // admits the account again and lands it there.
    await removedList(page)
        .getByRole('button', { name: `Restore ${INVITEE.login}` })
        .click();
    await expect(removedList(page)).toHaveCount(0);
    const landed = await inviteeSignsIn(browser, page, link, { expect: 'ticked', shot: 'members-restored-invite.png' });
    expect(landed).toBe(org);
    await page.reload();
    await expect(roster(page).getByText(INVITEE.login)).toBeVisible();
});
