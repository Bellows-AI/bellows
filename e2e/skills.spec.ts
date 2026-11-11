import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ADMIN_ROLE, MEMBER_ROLE } from '@factory-ai/core';
import { zipOf } from './fixtures/files.js';
import { setRole } from './roles.js';
import { throughSignIn } from './signin.js';

/**
 * Settings → Skills end to end (BEL-272), on the `auth` board: the stub member is the installation's
 * first member, so admin until a spec says otherwise. Names are unique per run — the database is
 * shared with the other auth specs — and admin is restored in `finally`.
 */

const SHOTS = 'artifacts/ui';
const RUN = Date.now().toString(36);
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const skillMd = (name: string, body: string) =>
    `---\nname: ${name}\ndescription: An end to end skill.\n---\n\n# ${name}\n\n${body}\n`;

const section = (page: Page, title: 'My workspace' | 'Organization') =>
    page.locator('section.panel').filter({ has: page.getByRole('heading', { name: new RegExp(`^${title}`) }) });
const rowOf = (page: Page, title: 'My workspace' | 'Organization', name: string) =>
    section(page, title).getByRole('row').filter({ hasText: name });

async function openSkills(page: Page) {
    await page.goto('/settings/skills');
    await expect(section(page, 'Organization')).toBeVisible();
}

async function rowAction(page: Page, title: 'My workspace' | 'Organization', name: string, action: string) {
    await rowOf(page, title, name)
        .getByRole('button', { name: `Actions for ${name}` })
        .click();
    await page.getByRole('menu').getByRole('menuitem', { name: action }).click();
}

async function shots(page: Page, who: 'admin' | 'member') {
    for (const [size, viewport] of [
        ['1440', DESKTOP],
        ['390', PHONE],
    ] as const) {
        for (const scheme of ['light', 'dark'] as const) {
            await page.setViewportSize(viewport);
            await page.emulateMedia({ colorScheme: scheme });
            await expect(section(page, 'Organization')).toBeVisible();
            await page.screenshot({ path: `${SHOTS}/settings-skills_${who}_${scheme}_${size}.png`, fullPage: true });
        }
    }
    await page.setViewportSize(DESKTOP);
}

test.describe('settings skills', () => {
    test.beforeEach(async ({ page }) => {
        await throughSignIn(page);
        await setRole(ADMIN_ROLE);
        const listed = await page.request.get('/api/org/skills');
        expect(listed.status(), 'GET /api/org/skills must be served on the auth board').toBe(200);
    });
    test.afterEach(async () => {
        await setRole(ADMIN_ROLE);
    });

    test('an admin creates an org skill inline and a member sees it read-only', async ({ page }) => {
        const name = `e2e-${RUN}-org`;
        await openSkills(page);
        await section(page, 'Organization').getByRole('button', { name: 'New skill' }).click();
        await page.getByLabel('Name', { exact: true }).fill(name);
        await page.getByRole('button', { name: 'Create skill' }).click();
        await expect(rowOf(page, 'Organization', name)).toBeVisible();
        await shots(page, 'admin');

        await setRole(MEMBER_ROLE);
        await openSkills(page);
        const row = rowOf(page, 'Organization', name);
        await expect(row).toBeVisible();
        await expect(row.getByRole('switch', { name: `Enable ${name}` })).toBeDisabled();
        await expect(row.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
        await expect(section(page, 'Organization').getByRole('button', { name: 'New skill' })).toHaveCount(0);
        await row.getByRole('button', { name: 'View', exact: true }).click();
        await expect(page.locator('.skill-view-source')).toContainText(`name: ${name}`);
        await shots(page, 'member');
    });

    test('a member uploads, edits, switches, downloads and deletes a workspace skill', async ({ page }) => {
        const name = `e2e-${RUN}-ws`;
        await setRole(MEMBER_ROLE);
        await openSkills(page);

        await section(page, 'My workspace').getByRole('button', { name: 'Upload .zip' }).click();
        await page.getByLabel('Choose a .zip file').setInputFiles({
            name: 'upload.zip',
            mimeType: 'application/zip',
            buffer: zipOf({ 'SKILL.md': skillMd(name, 'first'), 'scripts/run.sh': 'echo hi\n' }),
        });
        const row = rowOf(page, 'My workspace', name);
        await expect(row).toBeVisible();

        await row.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.getByLabel('SKILL.md', { exact: true }).fill(skillMd(name, 'second'));
        await page.getByRole('button', { name: 'Save new version' }).click();
        await expect(page.getByRole('button', { name: 'Save new version' })).toHaveCount(0);

        await rowAction(page, 'My workspace', name, 'View SKILL.md and files');
        const view = page.locator('.skill-view');
        await expect(view.locator('.skill-view-source')).toContainText('second');
        await expect(view.locator('.skill-files')).toContainText('SKILL.md');
        await expect(view.locator('.skill-files')).toContainText('scripts/run.sh');
        await view.getByRole('button', { name: 'Close' }).click();

        const sw = row.getByRole('switch', { name: `Enable ${name}` });
        await sw.click();
        await expect(page.getByText(`Disabled “${name}”.`)).toBeVisible();
        await expect(sw).not.toBeChecked();

        const download = page.waitForEvent('download');
        await rowAction(page, 'My workspace', name, 'Download .zip');
        const file = await download;
        expect(file.suggestedFilename()).toBe(`${name}.zip`);
        const zip = await readFile(await file.path());
        expect(zip.includes('SKILL.md')).toBe(true);
        expect(zip.includes('scripts/run.sh')).toBe(true);

        await rowAction(page, 'My workspace', name, 'Delete');
        await page.getByRole('button', { name: 'Delete skill' }).click();
        await expect(row).toHaveCount(0);
    });

    test('an admin switches a built-in off and back on', async ({ page }) => {
        const listed = await page.request.get('/api/skills');
        const { skills } = (await listed.json()) as {
            skills: { name: string; source: string; requires: { connections: unknown[] } }[];
        };
        const builtin = skills.find((skill) => skill.source === 'builtin' && skill.requires.connections.length === 0);
        expect(builtin, 'a built-in without a connection requirement').toBeTruthy();
        const name = builtin!.name;
        try {
            await openSkills(page);
            const sw = page.getByRole('switch', { name: `Offer ${name}` });
            await sw.click();
            await page.getByRole('button', { name: 'Switch off' }).click();
            await expect(page.getByText(`Switched “${name}” off for the organization.`)).toBeVisible();
            await expect(sw).not.toBeChecked();
            await sw.click();
            await expect(sw).toBeChecked();
            await expect(page.getByText(`Switched “${name}” back on.`)).toBeVisible();
        } finally {
            await page.request.put(`/api/org/skills/builtin/${encodeURIComponent(name)}/enabled`, {
                data: { enabled: true },
            });
        }
    });
});
