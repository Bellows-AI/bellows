import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { FORBIDDEN, watchConsole } from './page-health.js';

const SHOTS = 'artifacts/ui';

/** The variables summary on each settings page and the dialog it opens (BEL-262): one interaction
 * per state, a screenshot per state. `npm test` renders the summary with react-dom/server and
 * drives the dialog under jsdom; only a browser proves the keyboard path, the `.env` round trip
 * through real textarea input, and that the footer stays on screen with many rows (jsdom has no
 * layout). The three scopes live in the settings tree: Core at /settings/organization, My
 * workspace at /settings/workspace, Per repository at /settings/repos. */

/** The Core (organization) scope's summary — the section on the Organization page. */
function corePanel(page: Page) {
    return page.locator('section.panel', { has: page.getByRole('heading', { name: 'Core (organization)' }) });
}

/** The dialog's panel: the `role=dialog` layer around it is a zero-size fixed wrapper, which
 * Playwright reports as hidden, so the visible surface is the panel itself. */
function dialogOf(page: Page) {
    return page.locator('.env-dialog');
}

async function open(page: Page) {
    await page.goto('/settings/organization');
    await expect(page.getByRole('heading', { name: 'Core (organization)' })).toBeVisible({ timeout: 60_000 });
}

async function openDialog(page: Page) {
    await corePanel(page).getByRole('button', { name: 'Edit variables' }).click();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    return dialog;
}

/**
 * Clears the scope through the page's own contract, so every run starts from an empty scope no
 * matter what earlier runs stored (the seed leaves env_var alone): removal is pending per row and
 * the whole-list save commits the deletions. A scope that is already empty needs no dialog.
 */
async function clearScope(page: Page) {
    const empty = corePanel(page).getByText('No variables or secrets configured yet.');
    if (await empty.count()) return;
    const dialog = await openDialog(page);
    const removeButtons = dialog.getByRole('button', { name: /^Remove/ });
    // No iteration cap: the test timeout bounds a runaway sweep, and a cap below the row count
    // would only move the failure to a more confusing assertion.
    while ((await removeButtons.count()) > 0) {
        await removeButtons.first().click();
    }
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(empty).toBeVisible();
}

/** The footer's Save sits inside the viewport and the dialog never outgrows it. */
async function expectFooterOnScreen(page: Page, dialog: Locator) {
    const save = dialog.getByRole('button', { name: 'Save changes' });
    await expect(save).toBeInViewport({ ratio: 1 });
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

test.describe('variables summary and dialog', () => {
    test('renders each scope summary on its own settings section, cleanly', async ({ page }) => {
        const problems = watchConsole(page);

        await open(page);
        // The Organization section answers who and what scope before any editor (#180).
        await expect(page.getByText('Your role')).toBeVisible();
        await expect(page.getByText('Any member can edit.')).toBeVisible();
        await expect(corePanel(page).getByRole('button', { name: 'Edit variables' })).toBeVisible();
        // The summary is compact: no inline editing surface on the page.
        await expect(page.getByRole('tab')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
        const text = await page.locator('main').innerText();
        for (const token of FORBIDDEN) expect(text, `organization section contains ${token}`).not.toContain(token);
        await page.screenshot({ path: `${SHOTS}/settings-organization.png`, fullPage: true });

        await page.goto('/settings/workspace');
        await expect(page.getByRole('heading', { name: 'My workspace' })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole('button', { name: 'Edit variables' })).toBeVisible();
        const workspaceText = await page.locator('main').innerText();
        for (const token of FORBIDDEN)
            expect(workspaceText, `workspace section contains ${token}`).not.toContain(token);
        await page.screenshot({ path: `${SHOTS}/settings-workspace-env.png`, fullPage: true });

        await page.goto('/settings/repos');
        // The per-repository variables sit behind a row's Configure action (#181).
        await expect(page.getByRole('heading', { name: 'Repositories', exact: true })).toBeVisible({ timeout: 60_000 });
        const reposText = await page.locator('main').innerText();
        for (const token of FORBIDDEN) expect(reposText, `repos section contains ${token}`).not.toContain(token);
        await page.screenshot({ path: `${SHOTS}/settings-repos.png`, fullPage: true });

        expect(problems.join('\n')).toBe('');
    });

    test('add, edit and delete a variable by keyboard, with the summary following each save', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const core = corePanel(page);
        const edit = core.getByRole('button', { name: 'Edit variables' });

        // Add: Enter on the focused Add button, then the name field holds focus.
        await edit.focus();
        await page.keyboard.press('Enter');
        let dialog = dialogOf(page);
        await expect(dialog).toBeVisible();
        const add = dialog.getByRole('button', { name: 'Add variable' });
        await add.focus();
        await page.keyboard.press('Enter');
        await expect(dialog.getByLabel('Variable 1 name')).toBeFocused();
        await page.keyboard.type('E2E_KB_VAR');
        await page.keyboard.press('Tab');
        await page.keyboard.type('first');
        await expect(dialog.getByLabel('Variable 1 value')).toHaveValue('first');
        await page.screenshot({ path: `${SHOTS}/env-dialog-edit.png`, fullPage: true });
        await dialog.getByRole('button', { name: 'Save changes' }).focus();
        await page.keyboard.press('Enter');
        await expect(dialog).toBeHidden({ timeout: 15_000 });
        await expect(core.getByText('E2E_KB_VAR')).toBeVisible();
        await expect(core.getByText('1 variable')).toBeVisible();
        await expect(core.getByRole('status')).toHaveText('Changes saved.');
        // The dialog closed onto the button that opened it.
        await expect(edit).toBeFocused();
        // Values never reach the summary.
        await expect(core).not.toContainText('first');
        await page.screenshot({ path: `${SHOTS}/env-summary-saved.png`, fullPage: true });

        // Edit: reopen from the keyboard, replace the value, save.
        await page.keyboard.press('Enter');
        dialog = dialogOf(page);
        await expect(dialog).toBeVisible();
        const value = dialog.getByLabel('Variable 1 value');
        await expect(value).toHaveValue('first');
        await value.focus();
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.type('second');
        await dialog.getByRole('button', { name: 'Save changes' }).focus();
        await page.keyboard.press('Enter');
        await expect(dialog).toBeHidden({ timeout: 15_000 });
        await edit.focus();
        await page.keyboard.press('Enter');
        await expect(dialogOf(page).getByLabel('Variable 1 value')).toHaveValue('second');

        // Delete: Enter on Remove stages it with an Undo; Save commits the deletion.
        const remove = dialogOf(page).getByRole('button', { name: 'Remove E2E_KB_VAR' });
        await remove.focus();
        await page.keyboard.press('Enter');
        await expect(dialogOf(page).getByText('E2E_KB_VAR will be removed when you save.')).toBeVisible();
        await dialogOf(page).getByRole('button', { name: 'Save changes' }).focus();
        await page.keyboard.press('Enter');
        await expect(dialogOf(page)).toBeHidden({ timeout: 15_000 });
        await expect(core.getByText('No variables or secrets configured yet.')).toBeVisible();
        expect(problems.join('\n')).toBe('');
    });

    test('switching to .env and back keeps the content, including an empty and a quoted value', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const dialog = await openDialog(page);
        await dialog.getByRole('button', { name: '.env' }).click();
        const text = dialog.getByLabel('Variables as .env text');
        const source = ['E2E_PLAIN=plain', 'E2E_EMPTY=', 'E2E_QUOTED="  padded  "'].join('\n');
        await text.fill(source);
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await page.screenshot({ path: `${SHOTS}/env-dialog-text.png`, fullPage: true });

        await dialog.getByRole('button', { name: 'List' }).click();
        await expect(dialog.getByLabel('Variable 1 name')).toHaveValue('E2E_PLAIN');
        await expect(dialog.getByLabel('Variable 2 name')).toHaveValue('E2E_EMPTY');
        await expect(dialog.getByLabel('Variable 2 value')).toHaveValue('');
        await expect(dialog.getByLabel('Variable 3 name')).toHaveValue('E2E_QUOTED');
        // The quotes are syntax, not content: the list holds the padded value itself.
        await expect(dialog.getByLabel('Variable 3 value')).toHaveValue('  padded  ');

        await dialog.getByRole('button', { name: '.env' }).click();
        await expect(dialog.getByLabel('Variables as .env text')).toHaveValue(source);

        // Persisted, it reads back the same.
        await dialog.getByRole('button', { name: 'Save changes' }).click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });
        // The store reads back ordered by name, so the same three lines return sorted.
        const sorted = ['E2E_EMPTY=', 'E2E_PLAIN=plain', 'E2E_QUOTED="  padded  "'].join('\n');
        const reopened = await openDialog(page);
        await expect(reopened.getByLabel('Variable 1 name')).toHaveValue('E2E_EMPTY');
        await expect(reopened.getByLabel('Variable 1 value')).toHaveValue('');
        await expect(reopened.getByLabel('Variable 3 value')).toHaveValue('  padded  ');
        await reopened.getByRole('button', { name: '.env' }).click();
        await expect(reopened.getByLabel('Variables as .env text')).toHaveValue(sorted);
        expect(problems.join('\n')).toBe('');
    });

    test('malformed .env shows line errors and blocks Save', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const dialog = await openDialog(page);
        await dialog.getByRole('button', { name: '.env' }).click();
        await dialog.getByLabel('Variables as .env text').fill('E2E_OK=1\nTHIS HAS SPACES=yes');
        await expect(dialog.getByRole('alert')).toContainText('line 2');
        await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeDisabled();
        await page.screenshot({ path: `${SHOTS}/env-dialog-errors.png`, fullPage: true });

        // The list view refuses to open over text that does not parse: nothing is overwritten.
        // The control stays focusable (aria-disabled), so the click is forced past Playwright's
        // actionability check, which treats aria-disabled as not enabled.
        await dialog.getByRole('button', { name: 'List' }).click({ force: true });
        await expect(dialog.getByLabel('Variables as .env text')).toBeVisible();

        await dialog.getByLabel('Variables as .env text').fill('E2E_OK=1');
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeEnabled();
        expect(problems.join('\n')).toBe('');
    });

    test('Escape on a dirty dialog asks before it discards, and a clean one closes at once', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const edit = corePanel(page).getByRole('button', { name: 'Edit variables' });
        let dialog = await openDialog(page);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(page.getByText('Discard unsaved changes?')).toHaveCount(0);
        await expect(edit).toBeFocused();

        dialog = await openDialog(page);
        await dialog.getByRole('button', { name: 'Add variable' }).click();
        await dialog.getByLabel('Variable 1 name').fill('E2E_ESC_VAR');
        await page.keyboard.press('Escape');
        await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
        await expect(page.getByText('Your changes to Core (organization) have not been saved.')).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/env-unsaved-dialog.png`, fullPage: true });

        // The safe answer keeps the draft exactly as it was.
        await page.getByRole('button', { name: 'Continue editing' }).click();
        await expect(page.getByText('Discard unsaved changes?')).toBeHidden();
        await expect(dialogOf(page).getByLabel('Variable 1 name')).toHaveValue('E2E_ESC_VAR');

        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Discard changes' }).click();
        await expect(dialogOf(page)).toBeHidden();
        await expect(corePanel(page).getByText('No variables or secrets configured yet.')).toBeVisible();
        await expect(edit).toBeFocused();
        expect(problems.join('\n')).toBe('');
    });

    test('a dirty dialog guards in-app navigation with the one confirmation', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        // Build in-app history first: the page behind a modal cannot be clicked, so the browser's
        // back button is the way out that exists while the dialog is open.
        await page.getByRole('link', { name: 'Workspace', exact: true }).first().click();
        await expect(page).toHaveURL(/\/settings\/workspace$/);
        await page.goBack();
        await expect(page).toHaveURL(/\/settings\/organization$/);
        await expect(page.getByRole('heading', { name: 'Core (organization)' })).toBeVisible();
        await clearScope(page);

        const dialog = await openDialog(page);
        await dialog.getByRole('button', { name: 'Add variable' }).click();
        await dialog.getByLabel('Variable 1 name').fill('E2E_GUARD_VAR');
        await page.goForward();
        await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
        await page.getByRole('button', { name: 'Continue editing' }).click();
        await expect(dialogOf(page).getByLabel('Variable 1 name')).toHaveValue('E2E_GUARD_VAR');
        expect(problems.join('\n')).toBe('');
    });

    test('60 variables keep the footer on screen with Save reachable', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const dialog = await openDialog(page);
        await dialog.getByRole('button', { name: '.env' }).click();
        const lines = Array.from({ length: 60 }, (_, i) => `E2E_MANY_${String(i).padStart(2, '0')}=value-${i}`);
        await dialog.getByLabel('Variables as .env text').fill(lines.join('\n'));
        await dialog.getByRole('button', { name: 'List' }).click();
        await expect(dialog.getByLabel('Variable 60 name')).toHaveValue('E2E_MANY_59');

        // The rows scroll inside the body; the footer never leaves the viewport.
        await expectFooterOnScreen(page, dialog);
        const body = dialog.locator('.env-dialog-body');
        const scrolls = await body.evaluate((el) => el.scrollHeight > el.clientHeight);
        expect(scrolls).toBe(true);
        await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
        await expectFooterOnScreen(page, dialog);
        await page.screenshot({ path: `${SHOTS}/env-dialog-60.png`, fullPage: true });

        await dialog.getByRole('button', { name: 'Save changes' }).click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });
        const core = corePanel(page);
        await expect(core.getByText('60 variables')).toBeVisible();
        // Only the first few names list; the rest are counted.
        await expect(core.getByText('and 55 more')).toBeVisible();
        expect(problems.join('\n')).toBe('');
    });

    test('the dialog stays usable and overflow-free at a 390px phone width', async ({ page }) => {
        const problems = watchConsole(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await open(page);
        await clearScope(page);

        const dialog = await openDialog(page);
        await dialog.getByRole('button', { name: 'Add variable' }).click();
        await dialog.getByLabel('Variable 1 name').fill('E2E_NARROW');
        await dialog.getByLabel('Variable 1 value').fill('fits');

        // No page-level overflow at 390x844 and no horizontal scroll inside the dialog.
        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(0);
        const body = dialog.locator('.env-dialog-body');
        expect(await body.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
        await expectFooterOnScreen(page, dialog);
        await page.screenshot({ path: `${SHOTS}/env-narrow.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});
