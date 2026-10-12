import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { appearance, chooseAppearance, expectAppearanceOptions } from './appearance.js';
import { seededTaskId } from './routes.js';
import { controlsOutsideViewport, noHorizontalOverflow } from './viewport.js';

const SHOTS = 'artifacts/ui';

/**
 * The responsive shell's browser verification (issue 160): the four widths, the drawer's focus
 * management, the skip link, and the shapes every routed page must agree on. Runs on the open
 * board (AUTH_MODE=none, seeded offline server) like the dashboard check beside it.
 *
 * The closeout audit (issue 190) lives here too: narrow-phone toolbar wrap is pinned, and 200%
 * zoom gets the overflow sentinel. The per-route overflow sentinel, the named scroll regions, the
 * pill under long inbox content and the route/state/theme/width screenshot matrix live in
 * matrix.spec.ts (issue 287).
 *
 * The task inbox's own cases (issue 279) close the file: chip removal with Back/reload,
 * poll-stable depth and focus, and its screenshots.
 */

/** Every page the shell routes to, with the name its screenshot carries. */
const PAGES: ReadonlyArray<[string, string]> = [
    ['/', 'page-dashboard'],
    ['/tasks', 'page-inbox'],
    ['/tasks/new', 'page-composer'],
    ['/settings', 'page-settings-overview'],
    ['/settings/workspace', 'page-settings-workspace'],
    ['/settings/repos', 'page-settings-repos'],
    ['/settings/executors', 'page-settings-executors'],
    ['/settings/organization', 'page-settings-organization'],
    ['/account', 'page-account'],
];

/** The routes the zoom audit walks: every shell page plus, at run time, a task detail. */
const MATRIX_ROUTES: ReadonlyArray<string> = PAGES.map(([path]) => path);

/** Waits for the route's data anchor, so a measurement reads the settled layout and not the
    shell the SPA paints first. Each mapped route waits for content that only exists once its
    data (or its terminal error/empty state) has landed — never the loading skeleton. */
async function settle(page: Page, path: string): Promise<void> {
    if (path === '/') {
        // The dashboard answers 202 while the first read runs (dashboard.spec.ts's open()).
        await page.locator('.usage-summary, .usage-empty').first().waitFor({ timeout: 60_000 });
        return;
    }
    if (path === '/tasks') {
        await page.locator('.inbox-row, .inbox-empty, .inbox-error').first().waitFor();
        return;
    }
    if (path.startsWith('/tasks/')) {
        // The detail grid mounts when the thread answers; the composer page is its own address.
        await page.locator('.task-layout, .composer').first().waitFor();
        return;
    }
    await page.locator('main#main-content').waitFor();
    // Every other routed page mounts its sections below the shell; a panel is the difference
    // between a skeleton and the layout the route settles into.
    await page.locator('main .composer, main section.panel').first().waitFor();
}

/** The matrix's route list with a live task detail appended. */
async function matrixRoutes(page: Page): Promise<string[]> {
    return [...MATRIX_ROUTES, `/tasks/${await seededTaskId(page)}`];
}

test.describe('appearance', () => {
    /**
     * The persisted System/Light/Dark preference (issue 188), in the browser: the bootstrap's
     * before-paint resolution, the control's immediate switches, and persistence; the store and
     * the cross-tab sync are web/test/theme.test.tsx's. The OS palette is always read from the page itself — headless defaults are never
     * written down here.
     */
    const systemTheme = (page: Page) =>
        page.evaluate(() => (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
    const stored = (page: Page) => page.evaluate(() => localStorage.getItem('factory.theme'));

    test('the control carries the three options and switches immediately without a reload', async ({ page }) => {
        await page.goto('/');
        await appearance(page).waitFor({ state: 'attached' });

        await expectAppearanceOptions(page, ['System', 'Light', 'Dark']);
        // The factory state is System with no stored key, resolved to the live OS palette.
        expect(await stored(page)).toBeNull();
        expect(await page.locator('html').getAttribute('data-theme')).toBe(await systemTheme(page));

        await page.evaluate(() => ((window as { __probe?: number }).__probe = 1));
        await chooseAppearance(page, 'Dark');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        expect(await stored(page)).toBe('dark');
        // The probe surviving is the no-reload/no-refetch proof.
        expect(await page.evaluate(() => (window as { __probe?: number }).__probe)).toBe(1);
        await page.screenshot({ path: `${SHOTS}/appearance-dark.png` });

        // The paired light/dark captures; Dark is chosen last so the reload below reads it.
        await chooseAppearance(page, 'Light');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
        await page.screenshot({ path: `${SHOTS}/appearance-light-1440.png`, fullPage: true });
        await chooseAppearance(page, 'Dark');
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await page.screenshot({ path: `${SHOTS}/appearance-dark-1440.png`, fullPage: true });

        // The stored choice, not the OS, survives a reload.
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expect(appearance(page)).toHaveText('Dark');
    });
});

test.describe('the desktop shell', () => {
    test('the persistent nav holds 224px and the 56px app bar sticks without an h1', async ({ page }) => {
        await page.goto('/');
        const nav = page.locator('nav[aria-label="Primary"]');
        await expect(nav).toBeVisible();
        expect((await nav.boundingBox())?.width).toBe(224);
        // Every primary item is the 40px row (issue 274), glyph included.
        for (const link of await nav.locator('.sidenav-link').all()) {
            expect((await link.boundingBox())?.height).toBe(40);
            await expect(link.locator('.icon')).toHaveCount(1);
        }

        const bar = page.locator('.appbar');
        await expect(bar).toBeVisible();
        expect((await bar.boundingBox())?.height).toBe(56);
        expect(await bar.locator('h1').count()).toBe(0);

        // Scroll the tallest page to the bottom: the bar must still sit at the top edge.
        await page.mouse.wheel(0, 20_000);
        await expect
            .poll(async () => (await bar.boundingBox())?.y ?? Number.POSITIVE_INFINITY, 'app bar stuck to the top')
            .toBeLessThanOrEqual(2);
        await page.screenshot({ path: `${SHOTS}/shell-desktop-1440.png`, fullPage: true });
    });

    test('shell screenshots at 1440, 1024 and 390 in both themes', async ({ page }) => {
        for (const width of [1440, 1024, 390] as const) {
            await page.setViewportSize({ width, height: 900 });
            for (const theme of ['dark', 'light'] as const) {
                // The System preference follows the emulated scheme, and survives each goto.
                await page.emulateMedia({ colorScheme: theme });
                await page.goto('/tasks');
                await settle(page, '/tasks');
                if (width > 900) await expect(page.locator('.sidenav-count')).toBeVisible();
                await page.screenshot({ path: `${SHOTS}/shell-${theme}-${width}.png` });
                if (width > 900) continue;
                // At 390 the drawer is the navigation: open it on /settings, where the Overview
                // item is the current page, and capture the restyled panel.
                await page.goto('/settings');
                await page.locator('.appbar-trigger').click();
                const panel = page.locator('.mobile-nav');
                await expect(panel).toBeVisible();
                await expect(panel.locator('.sidenav-link .icon')).toHaveCount(4);
                await expect(panel.locator('[aria-current="page"]')).toHaveText('Overview');
                await expect(panel.locator('.sidenav-count')).toHaveCount(0);
                await page.screenshot({ path: `${SHOTS}/drawer-settings-${theme}-${width}.png` });
                await page.keyboard.press('Escape');
                await expect(panel).toHaveCount(0);
            }
        }
    });
});

test.describe('the responsive shell', () => {
    test('the skip link is the first stop and never steals focus', async ({ page }) => {
        await page.goto('/');
        const skip = page.locator('.skip-link');
        // The gate mounts the app only once the session check answers; Tab before that lands on
        // the sign-in screen and the assertion races the swap.
        await skip.waitFor({ state: 'attached' });

        await page.keyboard.press('Tab');
        await expect(skip).toBeFocused();
        await expect(skip).toBeVisible();
        // The reveal is a transform; capture once it has actually slid in.
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.activeElement!).transform)).toBe('none');
        await page.screenshot({ path: `${SHOTS}/skip-link-focus.png` });

        await page.keyboard.press('Enter');
        const landed = await page.evaluate(() => document.activeElement?.id);
        expect(landed).toBe('main-content');

        // Ordinary navigation: focus follows the click and nothing pulls it to the main region
        // behind the user's back. A DIFFERENT route must actually be crossed — the first link on
        // `/` is the active Dashboard link, and clicking it navigates nowhere.
        await page.locator('.sidenav-link', { hasText: 'Tasks' }).click();
        await expect(page).toHaveURL('/tasks');
        const after = await page.evaluate(() => document.activeElement?.id ?? 'none');
        expect(after, 'client-side navigation did not move focus to the main region').not.toBe('main-content');
    });

    for (const [width, height] of [
        [768, 1000],
        [390, 844],
    ] as const) {
        test(`the drawer manages focus at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await page.goto('/tasks');

            // The persistent column is gone from the layout, not stacked above the content.
            await expect(page.locator('.sidenav')).not.toBeVisible();
            await noHorizontalOverflow(page);

            // The trigger is located by class: while the modal is open Headless UI marks the
            // page behind it aria-hidden, and role queries do not see into that tree.
            const trigger = page.locator('.appbar-trigger');
            await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveCount(1);
            await expect(trigger).toBeVisible();
            await expect(trigger).toHaveAttribute('aria-expanded', 'false');
            await expect(trigger).toHaveAttribute('aria-controls', 'mobile-nav');

            await trigger.click();
            // Visibility asserts on the PANEL, not the dialog container: `.dialog-layer` is a
            // zero-height positioning shell over the viewport — its backdrop and positioner are
            // `position: fixed` — so the container has no box to measure.
            const dialog = page.getByRole('dialog', { name: 'Navigation' });
            const panel = page.locator('.mobile-nav');
            await expect(dialog).toHaveCount(1);
            await expect(panel).toBeVisible();
            await expect(trigger).toHaveAttribute('aria-expanded', 'true');
            await page.screenshot({ path: `${SHOTS}/drawer-${width}-open.png` });

            // Focus moved into the drawer, and repeated Tab cannot leave it.
            const focusInside = () =>
                page.evaluate(() => (document.activeElement?.closest('.dialog-layer') ? 'inside' : 'outside'));
            expect(await focusInside()).toBe('inside');
            for (let i = 0; i < 6; i += 1) {
                await page.keyboard.press('Tab');
                expect(await focusInside(), `Tab ${i + 1} stayed in the drawer`).toBe('inside');
            }

            // Escape closes, and focus returns to the trigger that opened it.
            await page.keyboard.press('Escape');
            await expect(panel).toHaveCount(0);
            await expect(trigger).toBeFocused();

            // A click on the dimmed page closes it too: the positioner spans the viewport, and
            // Headless UI closes whenever the click lands outside the panel.
            await trigger.click();
            await expect(panel).toBeVisible();
            await page.mouse.click(10, 10);
            await expect(panel).toHaveCount(0);

            // Navigation closes it, and the drawer carries counts and the composer link but no
            // task preview rows — and the organization selector moves in with it.
            await trigger.click();
            await expect(panel).toBeVisible();
            expect(await panel.locator('.sidenav-task').count()).toBe(0);
            await expect(panel.getByText(/\d+ running tasks?/)).toBeVisible();
            await expect(panel.getByText(/\d+ tasks? need/)).toBeVisible();
            await expect(panel.locator('.sidenav-newtask')).toBeVisible();
            await expect(panel.locator('.org-select')).toBeVisible();

            // Touch targets: the compact shell's controls all clear 44px.
            const targets: Array<[ReturnType<typeof page.locator>, string]> = [
                [trigger, 'nav trigger'],
                [panel.getByRole('button', { name: 'Close navigation' }), 'close control'],
                [panel.locator('.sidenav-link').first(), 'nav link'],
                [panel.locator('.org-select'), 'organization selector'],
                [page.locator('.appbar .user-menu-button'), 'account menu'],
            ];
            for (const [target, name] of targets) {
                expect((await target.boundingBox())?.height, `${name} touch target`).toBeGreaterThanOrEqual(44);
            }

            await panel.locator('.sidenav-link', { hasText: 'Dashboard' }).click();
            await expect(panel).toHaveCount(0);
            await expect(page).toHaveURL('/');

            if (width !== 390) return;
            // On the narrow phone the account menu opens inside the viewport and restores its trigger.
            const menuTrigger = page.locator('.appbar .user-menu-button');
            await menuTrigger.click();
            const menu = page.locator('.user-menu-panel');
            await expect(menu).toBeVisible();
            const box = (await menu.boundingBox())!;
            expect(box.x, 'account menu left edge').toBeGreaterThanOrEqual(0);
            expect(box.x + box.width, 'account menu right edge').toBeLessThanOrEqual(391);
            await page.screenshot({ path: `${SHOTS}/user-menu-390-open.png` });

            await page.keyboard.press('Escape');
            await expect(menu).toHaveCount(0);
            await expect(menuTrigger).toBeFocused();
        });
    }

    for (const width of [360, 390]) {
        test(`toolbar groups wrap and every action stays reachable at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 844 });

            await page.goto('/');
            await settle(page, '/');
            const controls = page.locator('.dashboard-controls');
            await expect(controls).toBeVisible();
            // Groups wrap as units: the wrap is the mechanism that keeps actions on-screen,
            // so it is asserted where the reachability below could otherwise pass by luck.
            await expect(controls).toHaveCSS('flex-wrap', 'wrap');
            expect(await controlsOutsideViewport(page, width), 'controls pushed outside the viewport').toEqual([]);

            await page.goto('/tasks');
            await settle(page, '/tasks');
            const filters = page.locator('.inbox-filters');
            await expect(filters).toBeVisible();
            await expect(filters).toHaveCSS('flex-wrap', 'wrap');
            expect(await controlsOutsideViewport(page, width), 'controls pushed outside the viewport').toEqual([]);
        });
    }

    test('200% zoom keeps every primary route free of page-level overflow', async ({ page }) => {
        // Real browser zoom does two things at once, and Playwright has no native lever for
        // either: it scales every px dimension the stylesheet writes, and it shrinks the CSS-px
        // viewport the media queries read. Neither mechanism alone reproduces it — zoom on the
        // root leaves media queries at desktop (so the drawer regime never engages), and a
        // narrow viewport leaves the px dimensions unscaled. The test applies both: a 720px
        // viewport (1440 window at 200% is a 720 CSS-px viewport; the shell's drawer regime
        // engages) with root zoom 2 (every px length renders doubled). The combined layout
        // budget is 360 CSS px — strictly harder than the real thing, still above the 320px
        // floor the shell promises — and both projects run Chromium, where `zoom` is
        // standardized.
        await page.addInitScript(() => {
            document.documentElement.style.setProperty('zoom', '2');
        });
        await page.setViewportSize({ width: 720, height: 1000 });
        for (const path of await matrixRoutes(page)) {
            await page.goto(path);
            await settle(page, path);
            await expect
                .poll(() => page.evaluate(() => document.body.scrollWidth - document.body.clientWidth))
                .toBeLessThanOrEqual(0);
        }
        await page.goto('/');
        await settle(page, '/');
        await page.screenshot({ path: `${SHOTS}/zoom-200-dashboard.png`, fullPage: true });
    });
});

test.describe('the task inbox (issue 279)', () => {
    test('a chip removes its one filter, Back restores it, Clear filters empties them all', async ({ page }) => {
        await page.goto('/tasks?state=past&q=task&author=nobody');
        await settle(page, '/tasks');
        const search = page.locator('.inbox-search').getByLabel('Search');
        const chips = page.locator('.inbox-chip');
        await expect(chips).toHaveCount(2);
        await expect(chips.first()).toHaveText('Search: task');
        await expect(search).toHaveValue('task');

        await page.getByRole('link', { name: 'Remove filter: Search' }).click();
        await expect(page).toHaveURL('/tasks?state=past&author=nobody');
        await expect(chips).toHaveCount(1);
        await expect(chips.first()).toHaveText('Author: nobody');
        // The field follows the URL: the removed filter's text must not linger in the box.
        await expect(search).toHaveValue('');

        await page.goBack();
        await expect(page).toHaveURL('/tasks?state=past&q=task&author=nobody');
        await expect(chips).toHaveCount(2);
        await expect(search).toHaveValue('task');

        await page.reload();
        await settle(page, '/tasks');
        await expect(chips).toHaveCount(2);

        await page.getByRole('link', { name: 'Clear filters' }).first().click();
        await expect(page).toHaveURL('/tasks');
        await expect(chips).toHaveCount(0);
        await expect(search).toHaveValue('');
    });

    test('inbox screenshots, filtered and stale, in both themes at 1440 and 390', async ({ page }) => {
        test.setTimeout(150_000);
        for (const width of [1440, 390] as const) {
            await page.setViewportSize({ width, height: 1000 });
            for (const theme of ['dark', 'light'] as const) {
                await page.emulateMedia({ colorScheme: theme });
                await page.goto('/tasks');
                await settle(page, '/tasks');
                await page.screenshot({ path: `${SHOTS}/inbox-${theme}-${width}.png`, fullPage: true });
                await page.goto('/tasks?state=past&q=task&author=nobody');
                await settle(page, '/tasks');
                await page.screenshot({ path: `${SHOTS}/inbox-filtered-${theme}-${width}.png` });
            }
        }

        // The stale state: the first page lands, then every refresh fails — the warning joins
        // the rows and never replaces them.
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/tasks');
        await settle(page, '/tasks');
        await page.route('**/api/tasks*', (route) => route.fulfill({ status: 503, body: 'down' }));
        await expect(page.locator('.banner-warn')).toBeVisible({ timeout: 45_000 });
        await expect(page.locator('.inbox-row').first()).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/inbox-stale-dark-1440.png` });
    });
});
