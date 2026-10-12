import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Locator, Page } from '@playwright/test';

const SHOTS = 'artifacts/ui';

/** The states the environment editors can be in, one interaction per state, a screenshot per state.
 * `npm test` renders the panel with react-dom/server and proves it does not throw; only a browser
 * proves the inputs accept typing, the draft survives tab switches and navigation, and Save writes.
 * The three scope editors live in the settings tree (#150): Core at /settings/organization, My
 * workspace at /settings/workspace, Per repository at /settings/repos. Issue #182 is the draft
 * editor and its guards: real tabs, secret states, pending removal with Undo, the advanced .env
 * disclosure, and the discard confirmation behind navigation and repository switches. */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

function watchConsole(page: Page): string[] {
    const problems: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    return problems;
}

/** The Core (organization) scope's panel — the editor on the Organization section. */
function corePanel(page: Page) {
    return page.locator('section.panel', { has: page.getByRole('heading', { name: 'Core (organization)' }) });
}

async function open(page: Page) {
    await page.goto('/settings/organization');
    await expect(page.getByRole('heading', { name: 'Core (organization)' })).toBeVisible({ timeout: 60_000 });
}

/**
 * Clears the scope through the page's own contract, so every run starts from an empty editor no
 * matter what earlier runs stored (the seed leaves env_var alone): removal is pending per row,
 * so both tabs are swept and the whole-list save commits the deletions. A clean panel needs no
 * save at all — and its save button is exactly what tells us so.
 */
async function clearScope(panel: Locator) {
    for (const tabName of [/^Variables \(/, /^Secrets \(/]) {
        await panel.getByRole('tab', { name: tabName }).click();
        // No iteration cap: the test timeout bounds a runaway sweep, and a cap below the row
        // count would only move the failure to a more confusing assertion.
        const removeButtons = panel.getByRole('button', { name: /^Remove/ });
        while ((await removeButtons.count()) > 0) {
            await removeButtons.first().click();
        }
    }
    await panel.getByRole('tab', { name: /^Variables \(/ }).click();
    const save = panel.getByRole('button', { name: 'Save changes' });
    if (await save.isEnabled()) {
        await save.click();
        await expect(panel.getByText('Changes saved.')).toBeVisible({ timeout: 15_000 });
    }
    await expect(panel.getByText('No variables configured.')).toBeVisible();
}

test.describe('environment editors', () => {
    test('renders each scope editor on its own settings section, cleanly', async ({ page }) => {
        const problems = watchConsole(page);

        await open(page);
        // The Organization section answers who and what scope before any editor (#180) — no
        // "not built yet" stub anymore.
        await expect(page.getByText('Your role')).toBeVisible();
        await expect(page.getByText('Any member can edit.')).toBeVisible();
        const text = await page.locator('main').innerText();
        for (const token of FORBIDDEN) expect(text, `organization section contains ${token}`).not.toContain(token);
        await page.screenshot({ path: `${SHOTS}/settings-organization.png`, fullPage: true });

        await page.goto('/settings/workspace');
        await expect(page.getByRole('heading', { name: 'My workspace' })).toBeVisible({ timeout: 60_000 });
        const workspaceText = await page.locator('main').innerText();
        for (const token of FORBIDDEN)
            expect(workspaceText, `workspace section contains ${token}`).not.toContain(token);
        await page.screenshot({ path: `${SHOTS}/settings-workspace-env.png`, fullPage: true });

        await page.goto('/settings/repos');
        // The per-repository editor (#150) moved behind a row's Configure action (#181), and the
        // open board's missing root keeps the checkout offer off — the dedicated root-null test
        // below pins that posture. This leg pins only that the page renders cleanly.
        await expect(page.getByRole('button', { name: 'Save selection' })).toBeVisible({ timeout: 60_000 });
        const reposText = await page.locator('main').innerText();
        for (const token of FORBIDDEN) expect(reposText, `repos section contains ${token}`).not.toContain(token);
        await page.screenshot({ path: `${SHOTS}/settings-repos.png`, fullPage: true });

        expect(problems.join('\n')).toBe('');
    });

    test('a variable can be added by row, edited, and saved', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        const core = corePanel(page);
        await clearScope(core);

        // Clean means the save button has nothing to do — the disabled posture is the test.
        await expect(core.getByRole('button', { name: 'Save changes' })).toBeDisabled();

        await core.getByRole('button', { name: 'Add variable' }).click();
        await core.getByLabel('Variable 1 name').fill('E2E_PROBE_VAR');
        await core.getByLabel('Variable 1 value').fill('probe-value');
        await expect(core.getByRole('tab', { name: /^Variables \(/ })).toHaveText('Variables (1)');
        await page.screenshot({ path: `${SHOTS}/env-row-edit.png`, fullPage: true });

        await core.getByRole('button', { name: 'Save changes' }).click();
        await expect(core.getByText('Changes saved.')).toBeVisible({ timeout: 15_000 });
        // The echoed rows are adopted inside the mounted panel: the value survives as the input's.
        await expect(core.getByLabel('Variable 1 value')).toHaveValue('probe-value');
        await page.screenshot({ path: `${SHOTS}/env-row-saved.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('a dirty editor guards in-app navigation with the one dialog', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        const core = corePanel(page);
        await clearScope(core);

        await core.getByRole('button', { name: 'Add variable' }).click();
        await core.getByLabel('Variable 1 name').fill('E2E_GUARD_VAR');

        await page.getByRole('link', { name: 'Tasks' }).click();
        await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
        await expect(page.getByText('Your changes to Core (organization) have not been saved.')).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/env-unsaved-dialog.png`, fullPage: true });

        // The safe answer keeps everything exactly as it was, focus included.
        await page.getByRole('button', { name: 'Continue editing' }).click();
        await expect(page.getByText('Discard unsaved changes?')).toBeHidden();
        await expect(core.getByLabel('Variable 1 name')).toHaveValue('E2E_GUARD_VAR');
        expect(page.url()).toContain('/settings/organization');

        // Discard resets the draft and resumes the navigation that was asked for.
        await page.getByRole('link', { name: 'Tasks' }).click();
        await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
        await page.getByRole('button', { name: 'Discard changes' }).click();
        await expect(page).toHaveURL(/\/tasks$/);
        expect(problems.join('\n')).toBe('');
    });

    test('the repositories page offers no checkout without a workspace root, though rows stay readable', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await page.goto('/settings/repos');
        // The open board runs without ORG_WORKSPACE_ROOT (issue 181's root-null posture):
        // availability and status stay readable — the seeded repository is named, its cached
        // checkout status renders — while every checkout control is off, with the reason in the
        // warn banner and its Workspace link. The dirty-draft dialog and the guarded Configure
        // switch drive on the auth project's board, where a root exists (workspace.spec.ts).
        await expect(page.getByRole('button', { name: 'Save selection' })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByText('Bellows-AI/bellows.ai')).toBeVisible();
        const selected = page.locator('.repo-card', { hasText: 'Selected' });
        await expect(selected.locator('.repo-card-value')).toHaveText('0');
        await expect(selected).toContainText('of 20 allowed');
        await expect(selected).toContainText('1 available');
        const checkbox = page.getByRole('checkbox', { name: 'Enable Bellows-AI/bellows.ai in my workspace' });
        await expect(checkbox).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Save selection' })).toBeDisabled();
        const banner = page.locator('.banner-warn');
        await expect(banner).toContainText('Workspace root not configured');
        await expect(banner).toContainText('An operator must set ORG_WORKSPACE_ROOT on the deployment');
        // The operator's setting, never a member's: the banner offers no button.
        await expect(banner.getByRole('button')).toHaveCount(0);

        await banner.getByRole('link', { name: 'Learn about workspaces' }).click();
        await expect(page).toHaveURL(/\/settings\/workspace$/);
        expect(problems.join('\n')).toBe('');
        await page.screenshot({ path: `${SHOTS}/settings-repos-root-null.png`, fullPage: true });
    });

    test('the editor stays usable and overflow-free at a narrow phone width', async ({ page }) => {
        const problems = watchConsole(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await open(page);

        const core = corePanel(page);
        await clearScope(core);
        await core.getByRole('button', { name: 'Add variable' }).click();
        await core.getByLabel('Variable 1 name').fill('E2E_NARROW');
        await core.getByLabel('Variable 1 value').fill('fits');

        // No page-level overflow at 390×844: the row has reflowed into labeled groups.
        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `${SHOTS}/env-narrow.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});
