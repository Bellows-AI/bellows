import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
    authoredBy,
    missingSummaryThread,
    otherAuthorThread,
    routeThread,
    sessionAuthor,
    type ThreadUser,
} from './fixtures/threads.js';
import { throughSignIn } from './signin.js';

/**
 * Who may continue a task (#281, F3), against a real sign-in: the board refuses a follow-up from
 * anyone but the thread's owner or an org admin, so the page offers the composer to those accounts. The session is the stub IdP's real one, read back from `/api/auth/me` — never
 * a fixture id — and the thread is routed with its author set to self. Another member's and a
 * null author's refusal are web/test/task-detail.render.test.tsx's; the board's 403 inside the
 * composer is web/test/task-detail.dom.test.tsx's.
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

test('your own task offers the composer to the signed-in session', async ({ page }) => {
    await openAs(page, me);
    await expect(page.getByLabel('Ask for a follow-up')).toBeVisible();
    await expect(page.getByText('can continue this session')).toHaveCount(0);
});

// The stub IdP's first account is the org's first member, so it lands `admin` (docs/auth.md).
test("an admin sees the composer on another member's task", async ({ page }) => {
    const owner = otherAuthorThread[0]!.author!;
    await routeThread(page, otherAuthorThread);
    await page.goto(`/tasks/${otherAuthorThread[0]!.id}`);
    await expect(page.getByLabel('Ask for a follow-up')).toBeVisible();
    await expect(page.getByText('can continue this session')).toHaveCount(0);
    expect(owner.login).not.toBe(me.login);
});

test('a turn an admin queued names the author it was queued on behalf of', async ({ page }) => {
    const root = otherAuthorThread[0]!;
    const owner = root.author!;
    // The owner's root stays as it was; the admin's follow-up is appended as the thread's next turn.
    const adminTurn = {
        ...root,
        id: 'aaaaaaaa-0000-4000-8000-000000000165',
        command: 'resume after the node loss',
        followUpTo: root.id,
        createdAt: '2026-09-01T13:00:00.000Z',
        author: me,
        createdBy: me.id,
        executionUser: owner,
        actingFor: owner,
    };
    const onBehalf = [root, adminTurn];
    await routeThread(page, onBehalf);
    await page.goto(`/tasks/${root.id}`);
    await expect(page.getByText(`queued by ${me.login} on behalf of ${owner.login}`)).toBeVisible();
    await expect(page.locator('.task-opened-by')).toContainText(owner.login);
    await expect(page.locator('.task-opened-by')).not.toContainText(me.login);
    await expect(page.getByLabel('Ask for a follow-up')).toBeVisible();
    await page.screenshot({ path: 'artifacts/ui/task-detail-admin-on-behalf.png', fullPage: true });
});
