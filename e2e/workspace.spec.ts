import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { throughSignIn } from './signin.js';

/**
 * The workspace section of Settings, the repositories section its selection moved to (#181), the
 * left nav, and the one failure that shows up only in production.
 *
 * On the `auth` project, because every route here needs a signed-in member — and because the
 * `chromium` project is the visual regression check for the dashboard and should not churn over
 * this.
 *
 * The auth server runs with a real ORG_WORKSPACE_ROOT under artifacts/, so this drives real
 * provisioning: a directory is created on disk by the sign-in callback. It does NOT drive a clone —
 * the server here is the offline entry, with no GitHub App credential; the stored fallback reports
 * the seed's one repository (SEED_REPO, scoped to the caller's org) but nothing is selected, so
 * the workspace page pins its empty-checkout sentence. Cloning, checkout statuses and the
 * dirty-detail switch dialog need a credential or a second seeded repository, and stay with a
 * credentialed run. The repositories page's selection guard and the executor dialog are
 * web/test/repository-selection.dom.test.tsx's and web/test/executor-dialog.dom.test.tsx's.
 */

const SHOTS = 'artifacts/ui';

async function signedIn(page: Page) {
    // The shared helper: through the selection screen on the run's first sign-in, straight in
    // after it (the stored choice is the choice).
    await throughSignIn(page);
}

test('the left nav is there and moves between sections', async ({ page }) => {
    await signedIn(page);

    const nav = page.locator('.sidenav');
    await expect(nav).toBeVisible();

    // The Settings item opens the tree at the configuration overview, the area's index (#180);
    // the workspace section is one click below it, with the four section links under the item
    // (#150).
    await nav.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: 'Configuration overview' })).toBeVisible();
    await nav.getByRole('link', { name: 'Workspace' }).click();
    await expect(page).toHaveURL(/\/settings\/workspace$/);
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Repositories' })).toBeVisible();

    await nav.getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/$/);
    // The analytics anchor, not a group count: this member's org holds no seeded rows, so the
    // dashboard truthfully answers with the one empty state rather than four figures.
    await expect(page.locator('.usage-summary, .usage-empty').first()).toBeVisible();
});

test('reloading /settings/workspace directly serves the app rather than a 404', async ({ page }) => {
    /*
     * THE reason this file exists.
     *
     * A client-side route only breaks on a real server: Vite has its own history fallback, so this
     * would pass in `npm run dev` and fail in the baked image, where the API serves the SPA. The
     * document must also be open — the wall is on /api/*, never on index.html — which is why the
     * status is asserted before anything renders.
     */
    await signedIn(page);

    const response = await page.goto('/settings/workspace');
    expect(response?.status()).toBe(200);
    // The 200 + shell is the deep-link contract; the heading proves the route resolved to the
    // workspace section and not the catch-all. exact: the section's own h2 ("My workspace")
    // would otherwise match alongside the page h1 (issue 190).
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(page.locator('.sidenav')).toBeVisible();
});

test('a signed-out visitor deep-linking to the settings tree gets the gate, not a 404', async ({ page }) => {
    await page.request.post('/api/auth/logout');

    const response = await page.goto('/settings/workspace');
    expect(response?.status()).toBe(200);
    await expect(page.locator('.login-gate')).toBeVisible();
});

test('the workspace page links to the repositories page for checkout management', async ({ page }) => {
    await signedIn(page);
    await page.goto('/settings/workspace');

    // Root provisioning happens at sign-in, so the management link is present — a deployment with
    // no ORG_WORKSPACE_ROOT drops it and states the operator copy instead, which the open board
    // renders in its screenshots.
    const link = page.getByRole('link', { name: 'Manage repository checkouts' });
    await expect(link).toBeVisible();
    await expect(page.getByText('Nothing checked out yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select repositories' })).toHaveCount(0);

    // The link IS the way in: selection lives on the repositories page now, not in a modal here.
    await link.click();
    await expect(page).toHaveURL(/\/settings\/repos$/);

    await page.screenshot({ path: `${SHOTS}/settings-workspace.png`, fullPage: true });
});

test('no settings action word wraps at 1024px', async ({ page }) => {
    // The acceptance (issue 282, PLAN §7.4): at a 1024px window, every button in the page region
    // keeps its label on one line — a wrapped "Config / ure" reads as two words and a broken row.
    await signedIn(page);
    await page.setViewportSize({ width: 1024, height: 800 });

    /** Labels whose text runs over more than one line box, among the visible buttons in main. */
    const wrapped = () =>
        page.locator('main').evaluate((main) =>
            [...main.querySelectorAll('button')]
                .filter((button) => button.offsetParent !== null && button.textContent?.trim())
                .filter((button) => {
                    const range = document.createRange();
                    range.selectNodeContents(button);
                    const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
                    return tops.size > 1;
                })
                .map((button) => button.textContent?.trim())
        );

    for (const [path, ready] of [
        ['/settings/organization', 'Core (organization)'],
        ['/settings/workspace', 'My workspace'],
        ['/settings/executors', 'My workspace'],
    ] as const) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: ready }).first()).toBeVisible({ timeout: 60_000 });
        expect(await wrapped(), path).toEqual([]);
    }

    // The repositories page with its detail open: the table's Configure, the selection bar's
    // save and the repository editor's footer all share the narrowed width.
    await page.goto('/settings/repos');
    await page.getByRole('button', { name: 'Configure' }).click();
    await expect(page.getByRole('heading', { name: /^Selected repository:/ })).toBeVisible({ timeout: 60_000 });
    expect(await wrapped(), '/settings/repos').toEqual([]);
    await page.screenshot({ path: `${SHOTS}/settings-repos-1024.png`, fullPage: true });
});

test('the workspace section renders nothing malformed', async ({ page }) => {
    // The null-not-zero contract, in the browser this time: a repo with no checkout must render an
    // em dash and never a placeholder that leaked out of a formatter.
    const errors: string[] = [];
    page.on('console', (message) => {
        // Nothing is exempt, including the pre-sign-in session probe: /api/auth/me answers
        // 200 {authenticated: false} for nobody precisely so the browser logs no error for it.
        if (message.type() === 'error') errors.push(message.text());
    });

    await signedIn(page);
    await page.goto('/settings/workspace');
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();

    const text = (await page.locator('main').innerText()) || '';
    for (const token of ['NaN', 'undefined', 'Infinity', '[object Object]']) {
        expect(text, token).not.toContain(token);
    }
    expect(errors).toEqual([]);

    await page.screenshot({ path: `${SHOTS}/settings-workspace-env.png`, fullPage: true });
});
