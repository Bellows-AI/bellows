import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { throughSignIn } from './signin.js';

/**
 * The workspace section of Settings, the repositories section that lists the tracked repositories
 * (#181, #777), and the one failure that shows up only in production.
 *
 * On the `auth` project, because every route here needs a signed-in member — and because the
 * `chromium` project is the visual regression check for the dashboard and should not churn over
 * this.
 *
 * The server here is the offline entry, with no GitHub App credential; the stored fallback
 * reports the seed's one repository (SEED_REPO, scoped to the caller's org) as the tracked list.
 * The board keeps no checkouts, so neither page carries checkout state. The repositories page's
 * Configure switch dialog and the executor dialog are
 * web/test/repository-selection.dom.test.tsx's and web/test/executor-dialog.dom.test.tsx's.
 */

const SHOTS = 'artifacts/ui';

async function signedIn(page: Page) {
    // The shared helper: through the selection screen on the run's first sign-in, straight in
    // after it (the stored choice is the choice).
    await throughSignIn(page);
}

test('reloading /settings/workspace directly serves the app rather than a 404', async ({ page }) => {
    /*
     * THE reason this file exists.
     *
     * A client-side route only breaks on a real server: Vite has its own history fallback, so this
     * would pass in `npm run dev` and fail in the baked image, where the API serves the SPA. The
     * document must also be open — the wall is on /api/*, never on index.html — which is why the
     * status is asserted before anything renders.
     */
    // Signed out first — a fresh context has no session: the deep link gets the gate, not a 404.
    const anonymous = await page.goto('/settings/workspace');
    expect(anonymous?.status()).toBe(200);
    await expect(page.locator('.login-gate')).toBeVisible();

    await signedIn(page);

    const response = await page.goto('/settings/workspace');
    expect(response?.status()).toBe(200);
    // The 200 + shell is the deep-link contract; the heading proves the route resolved to the
    // workspace section and not the catch-all. exact: the section's own h2 ("My workspace")
    // would otherwise match alongside the page h1 (issue 190).
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(page.locator('.sidenav')).toBeVisible();
});
test('the workspace page carries no checkout state; the repositories page lists what the board tracks', async ({
    page,
}) => {
    await signedIn(page);
    await page.goto('/settings/workspace');
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'My workspace' }).first()).toBeVisible({ timeout: 60_000 });
    const workspaceText = await page.locator('main').innerText();
    for (const gone of ['Manage repository checkouts', 'Nothing checked out', 'workspace root', 'ORG_WORKSPACE_ROOT']) {
        expect(workspaceText, gone).not.toContain(gone);
    }
    await page.screenshot({ path: `${SHOTS}/settings-workspace.png`, fullPage: true });

    await page.goto('/settings/repos');
    const tracked = page.getByRole('region', { name: 'Tracked repositories' });
    await expect(tracked).toBeVisible();
    await expect(tracked.getByRole('button', { name: 'Configure' }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Save selection' })).toHaveCount(0);
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    const reposText = await page.locator('main').innerText();
    for (const gone of ['Checkout status', 'Last commit', 'ORG_WORKSPACE_ROOT', 'Not checked out']) {
        expect(reposText, gone).not.toContain(gone);
    }
    await page.screenshot({ path: `${SHOTS}/settings-repos-tracked.png`, fullPage: true });
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

    // The repositories page with its detail open: the table's Configure and the repository
    // editor's footer share the narrowed width.
    await page.goto('/settings/repos');
    await page.getByRole('button', { name: 'Configure' }).click();
    await expect(page.getByRole('heading', { name: /^Selected repository:/ })).toBeVisible({ timeout: 60_000 });
    expect(await wrapped(), '/settings/repos').toEqual([]);
    await page.screenshot({ path: `${SHOTS}/settings-repos-1024.png`, fullPage: true });
});

test('the workspace section renders nothing malformed', async ({ page }) => {
    // The null-not-zero contract, in the browser this time: no page may render a placeholder that
    // leaked out of a formatter.
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
