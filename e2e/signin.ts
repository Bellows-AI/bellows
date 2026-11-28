import { expect, type Page } from '@playwright/test';

/** What each sign-in page asks before the dashboard: confirm the selection screen's
    pre-checked default, skip the provider and tools steps, and leave Ready for the app. */
const SETUP_ACTIONS: Record<string, string> = {
    '/onboarding': 'Continue',
    '/onboarding/provider': 'Skip for now',
    '/onboarding/tools': 'Skip for now',
    '/onboarding/ready': 'Go to the dashboard',
};

/**
 * Signs in through whatever the flow serves (issue 125): the selection screen when the
 * signing-in account has no stored choice yet, then the setup steps while the membership's setup
 * is unfinished, straight in when both are answered. Confirms the pre-checked default, so both stub
 * installations end up tracked, skips every setup step — and waits for the dashboard either way.
 *
 * Shared by both auth-project spec files, which sign in fresh contexts against one server: the
 * FIRST sign-in of a run meets the screen and the steps, every later one skips them, and no caller
 * should have to know which it will get.
 */
export async function finishSignIn(page: Page): Promise<void> {
    // The dashboard's answer is the analytics anchor — the metric summary when the selection
    // is ready, the one empty state when it is not (issue 166).
    const dashboard = page.locator('.usage-summary, .usage-empty').first();
    for (let hop = 0; hop <= 2 * Object.keys(SETUP_ACTIONS).length; hop++) {
        await page.locator('.onboarding h1, .usage-summary, .usage-empty').first().waitFor({ timeout: 60_000 });
        const at = new URL(page.url()).pathname;
        const action = SETUP_ACTIONS[at];
        if (!action) {
            // The app renders while its setup read is in flight, so the dashboard can show for a
            // moment before an unfinished member is sent to a step: ask the board, not the page.
            const me = (await (await page.request.get(new URL('/api/auth/me', page.url()).href)).json()) as {
                setup?: { completed: boolean };
            };
            if (me.setup?.completed !== false) break;
            await page.waitForURL((url) => url.pathname.startsWith('/onboarding/'), { timeout: 60_000 });
            continue;
        }
        await page.getByRole('button', { name: action }).click();
        await page.waitForURL((url) => url.pathname !== at, { timeout: 60_000 });
    }
    await expect(dashboard).toBeVisible({ timeout: 60_000 });
}

export async function throughSignIn(page: Page): Promise<void> {
    await page.goto('/');
    await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
    await finishSignIn(page);
}
