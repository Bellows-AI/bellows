import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { FORBIDDEN, watchConsole } from './page-health.js';

const SHOTS = 'artifacts/ui';

/** The inline variables editor on each settings page (BEL-262): one interaction per state, a
 * screenshot per state. `npm test` renders the editor with react-dom/server and drives it under
 * jsdom; only a browser proves the keyboard path, the `.env` round trip through real textarea
 * input, the unsaved-changes guard on in-app navigation, and that the save bar stays reachable with
 * many rows (jsdom has no layout). The three scopes live in the settings tree: Organization at
 * /settings/organization, Workspace at /settings/workspace, Per repository at /settings/repos. */

/** The Organization scope's editor — the section on the Organization page. */
function editorOf(page: Page) {
    return page.locator('section.env-editor', { has: page.getByRole('heading', { name: 'Organization variables' }) });
}

async function open(page: Page) {
    await page.goto('/settings/organization');
    await expect(page.getByRole('heading', { name: 'Organization variables' })).toBeVisible({ timeout: 60_000 });
}

/**
 * Clears the scope through the page's own contract, so every run starts from an empty scope no
 * matter what earlier runs stored (the seed leaves env_var alone): removal is pending per row and
 * the whole-list save commits the deletions. A scope that is already empty needs no save.
 */
async function clearScope(page: Page) {
    const editor = editorOf(page);
    for (const kind of ['Variables', 'Secrets']) {
        await editor.getByRole('tab', { name: new RegExp(`^${kind}`) }).click();
        const removeButtons = editor.getByRole('button', { name: /^Remove / });
        // No iteration cap: the test timeout bounds a runaway sweep, and a cap below the row count
        // would only move the failure to a more confusing assertion.
        while ((await removeButtons.count()) > 0) {
            await removeButtons.first().click();
        }
    }
    const save = editor.getByRole('button', { name: 'Save changes' });
    if (await save.count()) {
        await save.click();
        await expect(editor.getByRole('status')).toHaveText('Changes saved.', { timeout: 15_000 });
    }
    await editor.getByRole('tab', { name: /^Variables/ }).click();
    await expect(editor.getByText('No variables yet.')).toBeVisible();
}

/** The save bar's Save sits inside the viewport once scrolled to, and the editor never outgrows the width. */
async function expectSaveReachable(page: Page, editor: Locator) {
    const save = editor.getByRole('button', { name: 'Save changes' });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport({ ratio: 1 });
    const box = await editor.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test.describe('inline variables editor', () => {
    test('renders each scope editor on its own settings section, cleanly', async ({ page }) => {
        const problems = watchConsole(page);

        await open(page);
        // The Organization section answers who and what scope before any editor (#180).
        await expect(page.getByText('Your role')).toBeVisible();
        const editor = editorOf(page);
        await expect(editor.getByRole('tab', { name: /^Variables/ })).toHaveAttribute('aria-selected', 'true');
        await expect(editor.getByRole('tab', { name: /^Secrets/ })).toBeVisible();
        // Clean means no save bar: it exists only while the draft differs from what is stored.
        await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
        const text = await page.locator('main').innerText();
        for (const token of FORBIDDEN) expect(text, `organization section contains ${token}`).not.toContain(token);
        await page.screenshot({ path: `${SHOTS}/settings-organization.png`, fullPage: true });

        await page.goto('/settings/workspace');
        await expect(page.getByRole('heading', { name: 'Workspace variables' })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole('button', { name: 'New variable' })).toBeVisible();
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

    test('add, edit and delete a variable by keyboard, with the row following each save', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const editor = editorOf(page);
        const saveBar = editor.getByRole('button', { name: 'Save changes' });

        // Add: Enter on the focused New button, then the name field holds focus.
        await editor.getByRole('button', { name: 'New variable' }).focus();
        await page.keyboard.press('Enter');
        await expect(editor.getByLabel('Variable name')).toBeFocused();
        await page.keyboard.type('E2E_KB_VAR');
        await page.keyboard.press('Tab');
        await page.keyboard.type('first');
        await expect(editor.getByLabel('Variable value')).toHaveValue('first');
        await page.screenshot({ path: `${SHOTS}/env-editor-edit.png`, fullPage: true });
        // Enter commits the row (Done); the save bar is there because the draft is dirty.
        await page.keyboard.press('Enter');
        await expect(editor.getByLabel('Variable name')).toHaveCount(0);
        await expect(editor.getByText('E2E_KB_VAR')).toBeVisible();
        await expect(editor.getByText('Not saved yet')).toBeVisible();
        await saveBar.focus();
        await page.keyboard.press('Enter');
        await expect(editor.getByRole('status')).toHaveText('Changes saved.', { timeout: 15_000 });
        await expect(saveBar).toHaveCount(0);
        await expect(editor.getByText('Updated', { exact: false })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/env-editor-saved.png`, fullPage: true });

        // Edit: open the row from the keyboard, replace the value, Done, save.
        await editor.getByRole('button', { name: 'Edit E2E_KB_VAR' }).focus();
        await page.keyboard.press('Enter');
        const value = editor.getByLabel('Variable value');
        await expect(value).toHaveValue('first');
        await value.focus();
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.type('second');
        await page.keyboard.press('Enter');
        await saveBar.focus();
        await page.keyboard.press('Enter');
        await expect(saveBar).toHaveCount(0, { timeout: 15_000 });
        await editor.getByRole('button', { name: 'Edit E2E_KB_VAR' }).click();
        await expect(editor.getByLabel('Variable value')).toHaveValue('second');
        // Escape cancels the open row; the stored value stays.
        await page.keyboard.press('Escape');
        await expect(editor.getByLabel('Variable value')).toHaveCount(0);

        // Delete: Enter on Remove stages it with an Undo; Save commits the deletion.
        await editor.getByRole('button', { name: 'Remove E2E_KB_VAR' }).focus();
        await page.keyboard.press('Enter');
        await expect(editor.getByText('Removed when you save')).toBeVisible();
        await expect(editor.getByRole('button', { name: 'Undo' })).toBeFocused();
        await saveBar.focus();
        await page.keyboard.press('Enter');
        await expect(editor.getByText('No variables yet.')).toBeVisible({ timeout: 15_000 });
        expect(problems.join('\n')).toBe('');
    });

    test('switching to raw and back keeps the content, including an empty and a quoted value', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const editor = editorOf(page);
        await editor.getByRole('button', { name: 'Raw editor' }).click();
        const text = editor.getByLabel('Variables as .env text');
        const source = ['E2E_PLAIN=plain', 'E2E_EMPTY=', 'E2E_QUOTED="  padded  "'].join('\n');
        await text.fill(source);
        await expect(editor.getByRole('alert')).toHaveCount(0);
        await page.screenshot({ path: `${SHOTS}/env-editor-raw.png`, fullPage: true });

        await editor.getByRole('button', { name: 'List view' }).click();
        const rows = editor.locator('li.env-row');
        await expect(rows).toHaveCount(3);
        // Rows list by name, so the draft already reads in the order the store returns.
        await expect(rows.nth(0)).toContainText('E2E_EMPTY');
        await expect(rows.nth(0)).toContainText('empty');
        await expect(rows.nth(1)).toContainText('E2E_PLAIN');
        await expect(rows.nth(2)).toContainText('E2E_QUOTED');
        // The quotes are syntax, not content: the row holds the padded value itself.
        await editor.getByRole('button', { name: 'Edit E2E_QUOTED' }).click();
        await expect(editor.getByLabel('Variable value')).toHaveValue('  padded  ');
        await page.keyboard.press('Escape');

        await editor.getByRole('button', { name: 'Raw editor' }).click();
        await expect(editor.getByLabel('Variables as .env text')).toHaveValue(source);

        // Persisted, it reads back the same.
        await editor.getByRole('button', { name: 'Save changes' }).click();
        await expect(editor.getByRole('status')).toHaveText('Changes saved.', { timeout: 15_000 });
        await page.reload();
        await expect(editorOf(page).getByRole('tab', { name: /^Variables 3/ })).toBeVisible({ timeout: 60_000 });
        // The store reads back ordered by name, so the same three lines return sorted.
        const sorted = ['E2E_EMPTY=', 'E2E_PLAIN=plain', 'E2E_QUOTED="  padded  "'].join('\n');
        await editorOf(page).getByRole('button', { name: 'Raw editor' }).click();
        await expect(editorOf(page).getByLabel('Variables as .env text')).toHaveValue(sorted);
        expect(problems.join('\n')).toBe('');
    });

    test('malformed .env shows line errors and blocks Save', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const editor = editorOf(page);
        await editor.getByRole('button', { name: 'Raw editor' }).click();
        await editor.getByLabel('Variables as .env text').fill('E2E_OK=1\nTHIS HAS SPACES=yes');
        await expect(editor.getByRole('alert')).toContainText('line 2');
        await expect(editor.getByRole('button', { name: 'Save changes' })).toBeDisabled();
        await page.screenshot({ path: `${SHOTS}/env-editor-errors.png`, fullPage: true });

        // The list view refuses to open over text that does not parse: nothing is overwritten.
        // The control stays focusable (aria-disabled), so the click is forced past Playwright's
        // actionability check, which treats aria-disabled as not enabled.
        await editor.getByRole('button', { name: 'List view' }).click({ force: true });
        await expect(editor.getByLabel('Variables as .env text')).toBeVisible();

        await editor.getByLabel('Variables as .env text').fill('E2E_OK=1');
        await expect(editor.getByRole('alert')).toHaveCount(0);
        await expect(editor.getByRole('button', { name: 'Save changes' })).toBeEnabled();
        expect(problems.join('\n')).toBe('');
    });

    test('Escape cancels a fresh row, and Discard resets a dirty draft without asking', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const editor = editorOf(page);
        const add = editor.getByRole('button', { name: 'New variable' });
        await add.click();
        await expect(editor.getByLabel('Variable name')).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(editor.getByLabel('Variable name')).toHaveCount(0);
        await expect(editor.getByText('No variables yet.')).toBeVisible();
        await expect(add).toBeFocused();
        await expect(editor.getByRole('button', { name: 'Save changes' })).toHaveCount(0);

        await add.click();
        await editor.getByLabel('Variable name').fill('E2E_ESC_VAR');
        await page.keyboard.press('Enter');
        await expect(editor.getByText('Unsaved changes', { exact: true })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/env-editor-dirty.png`, fullPage: true });

        await editor.getByRole('button', { name: 'Discard' }).click();
        await expect(page.getByText('Discard unsaved changes?')).toHaveCount(0);
        await expect(editor.getByText('E2E_ESC_VAR')).toHaveCount(0);
        await expect(editor.getByText('No variables yet.')).toBeVisible();
        await expect(editor.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
        expect(problems.join('\n')).toBe('');
    });

    test('leaving the page with a dirty draft asks via the unsaved-changes dialog', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const editor = editorOf(page);
        await editor.getByRole('button', { name: 'New variable' }).click();
        await editor.getByLabel('Variable name').fill('E2E_GUARD_VAR');
        await page.keyboard.press('Enter');

        await page.getByRole('link', { name: 'Workspace', exact: true }).first().click();
        await expect(page.getByText('Discard unsaved changes?')).toBeVisible();
        await expect(page.getByText('Your changes to Organization variables have not been saved.')).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/env-unsaved-dialog.png`, fullPage: true });

        // The safe answer keeps the draft exactly as it was.
        await page.getByRole('button', { name: 'Continue editing' }).click();
        await expect(page.getByText('Discard unsaved changes?')).toBeHidden();
        await expect(page).toHaveURL(/\/settings\/organization$/);
        await expect(editor.getByText('E2E_GUARD_VAR')).toBeVisible();

        await page.getByRole('link', { name: 'Workspace', exact: true }).first().click();
        await page.getByRole('button', { name: 'Discard changes' }).click();
        await expect(page).toHaveURL(/\/settings\/workspace$/);
        expect(problems.join('\n')).toBe('');
    });

    test('60 variables keep the save bar reachable', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        await clearScope(page);

        const editor = editorOf(page);
        await editor.getByRole('button', { name: 'Raw editor' }).click();
        const lines = Array.from({ length: 60 }, (_, i) => `E2E_MANY_${String(i).padStart(2, '0')}=value-${i}`);
        await editor.getByLabel('Variables as .env text').fill(lines.join('\n'));
        await editor.getByRole('button', { name: 'List view' }).click();
        await expect(editor.locator('li.env-row')).toHaveCount(60);
        await expect(editor.getByRole('tab', { name: /^Variables 60/ })).toBeVisible();

        await expectSaveReachable(page, editor);
        await page.screenshot({ path: `${SHOTS}/env-editor-60.png`, fullPage: true });

        await editor.getByRole('button', { name: 'Save changes' }).click();
        await expect(editor.getByRole('status')).toHaveText('Changes saved.', { timeout: 15_000 });
        await expect(editor.getByRole('tab', { name: /^Variables 60/ })).toBeVisible();
        expect(problems.join('\n')).toBe('');
    });

    test('the editor stays usable and overflow-free at a 390px phone width', async ({ page }) => {
        const problems = watchConsole(page);
        await page.setViewportSize({ width: 390, height: 844 });
        await open(page);
        await clearScope(page);

        const editor = editorOf(page);
        await editor.getByRole('button', { name: 'New variable' }).click();
        await editor.getByLabel('Variable name').fill('E2E_NARROW');
        await editor.getByLabel('Variable value').fill('fits');

        // No page-level overflow at 390x844 and no horizontal scroll inside the box.
        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow).toBeLessThanOrEqual(0);
        const box = editor.locator('.env-box');
        expect(await box.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
        await expectSaveReachable(page, editor);
        await page.screenshot({ path: `${SHOTS}/env-narrow.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});
