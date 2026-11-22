import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2E_WEBHOOK_SECRET, IDP_PORT } from '../playwright.config.js';
import { throughSignIn } from './signin.js';

/**
 * The member's GitHub grant, in a real browser (BEL-528): sign-in through the App's user authorization keeps it, Settings
 * says so, a revocation delivered by GitHub breaks it, and the reconnect link is the silent sign-in round trip that makes
 * it live again. The stub identity provider issues the token pair; the revocation is the real signed webhook.
 */

const IDP = `http://127.0.0.1:${IDP_PORT}`;
const card = (page: Page) => page.getByRole('listitem', { name: 'GitHub connection' });

// Back to the default account and a stub that issues a refresh token, whatever a test left.
test.afterEach(async ({ request }) => {
    await request.post(`${IDP}/_control/identity`, { data: {} });
    await request.post(`${IDP}/_control/github`, { data: {} });
});

test('the sign-in leaves a live grant, a revocation breaks it, and reconnecting renews it', async ({ page }) => {
    await throughSignIn(page);
    await page.goto('/settings/integrations');
    await expect(card(page).getByText('Connected as e2e-user')).toBeVisible();
    await expect(card(page).getByText('Connected', { exact: true })).toBeVisible();
    await expect(card(page).getByRole('link')).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/ui/github-grant-live.png', fullPage: true });

    // GitHub tells the board the member revoked the App's authorization: a signed delivery, the only credential it has.
    const me = (await (await page.request.get('/api/auth/me')).json()) as {
        user: { githubUserId: number; login: string };
    };
    const body = JSON.stringify({ action: 'revoked', sender: { id: me.user.githubUserId, login: me.user.login } });
    const signature = `sha256=${createHmac('sha256', E2E_WEBHOOK_SECRET).update(body).digest('hex')}`;
    const delivered = await page.request.post('/api/github/webhook', {
        data: body,
        headers: {
            'content-type': 'application/json',
            'x-github-event': 'github_app_authorization',
            'x-hub-signature-256': signature,
        },
    });
    expect(delivered.status()).toBe(200);

    await page.reload();
    await expect(card(page).getByText('Needs reconnect')).toBeVisible();
    await expect(card(page).getByText('Connected', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: 'artifacts/ui/github-grant-broken.png', fullPage: true });

    // The reconnect is the sign-in itself: silent for a member who already consented, back on this page, live again.
    await card(page).getByRole('link', { name: 'Reconnect GitHub' }).click();
    await expect(card(page).getByText('Connected', { exact: true })).toBeVisible();
    await expect(card(page).getByText('Connected as e2e-user')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/settings/integrations');
});

test('an App whose user tokens do not expire is told apart on the sign-in screen', async ({ page, request }) => {
    await request.post(`${IDP}/_control/github`, { data: { noRefreshToken: true } });

    await page.goto('/');
    await page.getByRole('link', { name: 'Sign in with GitHub' }).click();

    await expect(page.getByText(/Expire user authorization tokens/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toBeVisible();
});
