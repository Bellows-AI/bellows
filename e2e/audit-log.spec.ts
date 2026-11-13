import { readFile } from 'node:fs/promises';
import { ADMIN_ROLE } from '@factory-ai/core';
import { expect, test } from '@playwright/test';
import { setRole } from './roles.js';
import { throughSignIn } from './signin.js';

/**
 * The organization's audit log, end to end on the `auth` board: the admin's own sign-in is a row on the Organization
 * page, and Export saves the picked days as NDJSON holding it. Captured at desktop and phone width.
 */

const SHOTS = 'artifacts/ui';

test('an admin reads the audit log and exports it', async ({ page }) => {
    await throughSignIn(page);
    await setRole(ADMIN_ROLE);
    await page.goto('/settings/organization');

    const section = page.getByRole('region', { name: 'Audit log' });
    const events = section.getByRole('region', { name: 'Audit events' });
    await expect(events.getByText('Signed in').first()).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/settings-audit-log.png`, fullPage: true });

    const download = page.waitForEvent('download');
    await section.getByRole('button', { name: 'Export' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^audit-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.ndjson$/);
    const rows = (await readFile((await file.path())!, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { action: string });
    expect(rows.map((row) => row.action)).toContain('auth.sign_in');

    await page.setViewportSize({ width: 390, height: 844 });
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/settings-audit-log-phone.png`, fullPage: true });
});
