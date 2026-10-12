import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { appearance, chooseAppearance, expectAppearanceOptions } from './appearance.js';
import { throughSignIn } from './signin.js';

/**
 * The sign-in flow, in a real browser, against a stub identity provider.
 *
 * dashboard.spec.ts stays on the open board and is untouched: it is the visual regression check and
 * should not churn over an auth change. This file is the one that proves the gate, the round trip,
 * the selection screen (#125) and the sign-out, and it runs against its own server with
 * AUTH_MODE=github.
 *
 * The stub reports TWO installations and the run's identity is fresh (playwright.config.ts). No
 * test leans on being the run's first sign-in: one that needs the screen forces it (?reselect=1,
 * the settings page's own link), one that needs a stored choice signs one in itself, and every id
 * an assertion pins is read from the pending report or from the row the test just chose — never a
 * fixture constant. Each test therefore passes alone, filtered or reordered; workers: 1 only
 * serializes.
 */

const usageGroups = (page: Page) => page.locator('.usage-summary .usage-group');
/** The analytics anchor: the metric summary when the selection has data, the one empty state
    when it has none — which is every fresh github-mode member, since the seed plants under the
    local org only (issue 166). The auth board's "the dashboard answered" is this anchor. */
const analyticsAnchor = (page: Page) => page.locator('.usage-summary, .usage-empty').first();
const gate = (page: Page) => page.locator('.login-gate');
const signIn = (page: Page) => page.getByRole('link', { name: 'Sign in with GitHub' });
const screen = (page: Page) => page.locator('.onboarding');

/** One installation as the pending report lists it: the org name the screen renders, and its id. */
interface ReportedInstallation {
    id: string;
    account: string;
}

/**
 * The parked sign-in's own report (issue 125): the installations the stub account can see, the
 * same payload the selection screen renders. Tests derive their expectations from it, so nothing
 * here writes down an installation or organization id.
 */
const pendingReport = async (page: Page): Promise<ReportedInstallation[]> => {
    const response = await page.request.get('/api/auth/github/pending');
    return ((await response.json()) as { installations: ReportedInstallation[] }).installations;
};

test('an anonymous visitor gets the gate and no dashboard', async ({ page }) => {
    // The document itself is served without authentication: if index.html 401'd there would be
    // nothing left to render a sign-in button in. The wall is on /api/*, never on the document.
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);

    await expect(gate(page)).toBeVisible();
    await expect(gate(page).getByRole('heading', { level: 1, name: 'Bellows' })).toBeVisible();
    await expect(page).toHaveTitle('Bellows');
    await expect(signIn(page)).toBeVisible();
    // The point of gating above App rather than inside it: the panels are never mounted, so no
    // request for data is ever made by somebody who could not read the answer.
    await expect(usageGroups(page)).toHaveCount(0);

    // The appearance preference (issue 188) is on the public surface too, before any session.
    await expect(appearance(page)).toBeVisible();
    await expectAppearanceOptions(page, ['System', 'Light', 'Dark']);
});

test('the selection screen tracks only the chosen organizations (issue 125)', async ({ page }) => {
    // `reselect=1` opens the screen whatever any other test has already stored — this test stands
    // alone.
    await page.goto('/api/auth/github?reselect=1');

    // The step between the OAuth round trip and the session: one row per reported installation,
    // read from the pending report rather than written down.
    await screen(page).waitFor({ timeout: 60_000 });
    const reported = await pendingReport(page);
    expect(reported).toHaveLength(2);
    const orgs = screen(page).locator('.onboarding-org');
    await expect(orgs).toHaveCount(2);
    // Whatever a previous test stored arrives pre-checked; normalize to every reported
    // installation checked, so what this test confirms is what this test chose.
    for (const install of reported) {
        await orgs.filter({ hasText: install.account }).getByRole('checkbox').check();
    }
    await page.screenshot({ path: 'artifacts/ui/onboarding.png', fullPage: true });

    // The same screen at phone width, both palettes: the closeout's onboarding captures. The
    // column must reflow to one column and never widen the body (issue 190).
    const overflow = () => page.evaluate(() => document.body.scrollWidth - document.body.clientWidth);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await overflow(), 'onboarding overflows at 390px').toBeLessThanOrEqual(0);
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({
        path: 'artifacts/ui/matrix/onboarding_default_dark_390.png',
        fullPage: true,
        animations: 'disabled',
    });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await page.screenshot({
        path: 'artifacts/ui/matrix/onboarding_default_light_390.png',
        fullPage: true,
        animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));

    // Deselect the second reported installation and confirm: the session lands, and only the
    // still-checked org was materialized — the choice, nothing else from the report.
    const kept = reported[0]!;
    await orgs.filter({ hasText: reported[1]!.account }).getByRole('checkbox').uncheck();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(analyticsAnchor(page)).toBeVisible({ timeout: 60_000 });

    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    const body = (await me.json()) as {
        user: { login: string };
        role: string;
        organization: { id: string; name: string };
        organizations: { id: string; name: string }[];
        mode: string;
    };
    expect(body.user.login).toBe('e2e-user');
    // The chosen installation was materialized as the member's organization — the org, the
    // membership and the session's binding to it, no invite anywhere in the flow (#99). This
    // account is the installation's FIRST member, so its membership lands `admin` (#410).
    expect(body.role).toBe('admin');
    expect(body.mode).toBe('github');
    expect(body.organization).toEqual({ id: kept.id, name: kept.account });
    expect(body.organizations).toEqual([{ id: kept.id, name: kept.account }]);
});

test('signing out returns to the gate, and the next sign-in reuses the stored choice (issue 125)', async ({ page }) => {
    // Through the screen when this is the run's first sign-in, straight in when another test
    // already stored a choice: either way a choice is stored before the sign-out below.
    await throughSignIn(page);

    // Through the user menu — the affordance, not a hand-crafted request.
    await page.locator('.user-menu-button').click();
    // The Headless UI Menu renders each item in the menuitem role, overriding the button's.
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(gate(page)).toBeVisible();
    await expect(usageGroups(page)).toHaveCount(0);

    // The old cookie no longer authenticates: /me answers "nobody".
    const me = await page.request.get('/api/auth/me');
    expect(await me.json()).toMatchObject({ authenticated: false });

    // The appearance preference (issue 188) is local, not session state: the choice outlives the
    // sign-out, on the gate as anywhere.
    await chooseAppearance(page, 'Dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(gate(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Idempotent: signing out again, or with an already-dead session, is a 204 — never an error.
    const response = await page.request.post('/api/auth/logout');
    expect(response.status()).toBe(204);

    // Straight back in from the gate: the stored choice is the choice, so no selection screen.
    await signIn(page).click();
    await analyticsAnchor(page).waitFor({ timeout: 60_000 });
    await expect(screen(page)).toHaveCount(0);
});
