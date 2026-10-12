import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { authoredBy, missingSummaryThread, routeThread, sessionAuthor, type ThreadUser } from './fixtures/threads.js';
import { throughSignIn } from './signin.js';

/**
 * Who may continue a task (#281, F3), against a real sign-in: the board refuses a follow-up from
 * anyone but the account that queued the row it is posted to, so the page offers the composer to
 * that account alone. The session is the stub IdP's real one, read back from `/api/auth/me` — never
 * a fixture id — and the thread is routed with its author set to self. Another member's and a
 * null author's refusal are web/test/task-detail.render.test.tsx's.
 */

const task = missingSummaryThread[0]!.id;

async function openAs(page: Page, author: ThreadUser): Promise<void> {
    await routeThread(page, authoredBy(missingSummaryThread, author));
    await page.goto(`/tasks/${task}`);
    await expect(page.locator('.page-header h1')).toHaveText('seed task');
}

let me: ThreadUser;

test.beforeEach(async ({ page }) => {
    await throughSignIn(page);
    me = await sessionAuthor(page);
});

test("your own task offers the composer, and the board's 403 renders inside it and keeps the draft", async ({
    page,
}) => {
    await openAs(page, me);
    const box = page.getByLabel('Ask for a follow-up');
    await expect(box).toBeVisible();
    await expect(page.getByText('can continue this session')).toHaveCount(0);

    const refusal = 'Only the account that queued the task can follow it up';
    await page.route('**/api/jobs/*/follow-up', (route) =>
        route.fulfill({ status: 403, json: { error: refusal, code: 'FORBIDDEN' } })
    );
    await box.fill('one more pass');
    await page.getByRole('button', { name: 'Send follow-up' }).click();
    await expect(page.locator('.composer')).toContainText(refusal);
    await expect(box).toHaveValue('one more pass');
});
