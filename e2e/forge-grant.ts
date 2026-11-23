import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { E2E_WEBHOOK_SECRET } from '../playwright.config.js';

/**
 * GitHub tells the board the signed-in member revoked the App's authorization: the signed delivery is the only
 * credential the webhook has, and it breaks the member's grant (docs/connections.md).
 */
export async function revokeGitHubAuthorization(page: Page): Promise<void> {
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
}
