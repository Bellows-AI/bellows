import { expect, test } from '@playwright/test';

/**
 * Batches off, as the browser shows it (BEL-264). The e2e board runs with `BATCHES_ENABLED=true`
 * (playwright.config.ts) for the batch specs, so this spec serves the session as a board with the
 * flag off would — the real `/api/auth/me` body with `batches: false` — and asserts the SPA's side:
 * no Batches link, direct batch URLs land on the dashboard, no batch API read. The server's own
 * refusal (404 BATCHES_DISABLED) is pinned by server/test/routes.batches.test.ts.
 */
test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', async (route) => {
        const response = await route.fetch();
        const me = (await response.json()) as Record<string, unknown>;
        await route.fulfill({ response, json: { ...me, batches: false } });
    });
});

// The SPA re-reads `/api/auth/me` on its own schedule, so a read can still be in flight when the test
// ends. Dropping the handler and letting that read settle is what keeps its `route.fetch()` from
// throwing "Test ended" / "Response has been disposed" into the finished test.
test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('lists no Batches link and never asks the batch API', async ({ page }) => {
    const batchReads: string[] = [];
    page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/batches')) batchReads.push(request.url());
    });
    await page.goto('/tasks');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    // The item's name is "Tasks" until the task poll lands, then "Tasks, N tasks need review"; the
    // preview's "View all tasks" link also contains "tasks", so a bare substring name matches both.
    await expect(nav.getByRole('link', { name: /^Tasks(,|$)/ })).toBeVisible();
    await expect(nav.getByRole('link', { name: /Batches/ })).toHaveCount(0);
    expect(batchReads).toEqual([]);
});

for (const path of ['/batches', '/batches/new', '/batches/not-a-batch']) {
    test(`${path} lands on the dashboard with no batch page`, async ({ page }) => {
        const batchReads: string[] = [];
        page.on('request', (request) => {
            if (new URL(request.url()).pathname.startsWith('/api/batches')) batchReads.push(request.url());
        });
        await page.goto(path);
        await expect(page).toHaveURL(/\/$/);
        await expect(page.locator('main')).not.toContainText(/batch/i);
        expect(batchReads).toEqual([]);
    });
}
