import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
    authoredBy,
    mockedActivityOf,
    parkedReviewWaitMarkedDoneThread,
    parkedReviewWaitRunningThread,
    parkedReviewWaitThread,
    sessionAuthor,
    type ThreadJob,
    taskSummaryOf,
} from './fixtures/threads.js';
import { type Theme, VIEWPORTS } from './screenshot-matrix.js';
import { useTheme, watchConsole } from './page-health.js';

/**
 * The task journey's hand-backs across the merged lanes (#286), in one theme — the theme only
 * changes the screenshots: a parked review wait closed with Mark done. The states are the #270
 * fixtures, following one task id. A failed gate answered with another pass is task-detail.spec.ts's;
 * the configure-from-the-blocker launch is composer.spec.ts's F1 journey; another author's
 * refusal is web/test/task-detail.render.test.tsx's.
 */

const SHOTS = 'artifacts/ui/journeys';

// The matrix's desktop width, not the Desktop Chrome device's 1280.
test.use({ viewport: VIEWPORTS[0] });

/** One step of one journey, named `<journey>_<step>_<theme>_<width>` like the baseline gallery. */
async function shoot(page: Page, journey: string, step: string, theme: Theme): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const width = page.viewportSize()!.width;
    // A full-page shot taken scrolled (focusing the composer scrolls it into view) paints the fixed
    // shell at the scroll offset, mid-image. Scrolling does not move focus, so the step still shows.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
        path: `${SHOTS}/${journey}_${step}_${theme}_${width}.png`,
        fullPage: true,
        animations: 'disabled',
    });
}

/**
 * Serve one task's thread and the task list from the same held jobs, so the detail page, the
 * sidebar and the inbox all read one state and a test moves the task on by reassigning `jobs`.
 * The bucket is the board's own rule (server/src/db/task-summary.ts): a run neither terminal nor
 * parked on an open wait is running; otherwise it is review until marked done, then past.
 */
async function routeTask(page: Page, held: { jobs: ThreadJob[] }): Promise<void> {
    await page.route('**/api/jobs/*/thread*', (route) => route.fulfill({ json: { jobs: held.jobs } }));
    // The page's run-activity hook (issue #339) fetches beside the thread poll; a mocked thread
    // answers it too, or the real board 404s a task id the fixture only names.
    await page.route('**/api/jobs/*/activity', (route) => route.fulfill({ json: mockedActivityOf(held.jobs) }));
    await page.route(/\/api\/tasks(\?|$)/, (route) => {
        const row = taskSummaryOf(held.jobs);
        const terminal =
            ['succeeded', 'failed', 'dead', 'stopped'].includes(row.status) ||
            (row.waitReason !== null && row.waitTerminalReason === null);
        const bucket = terminal ? (row.doneAt === null ? 'review' : 'past') : 'running';
        return route.fulfill({
            json: {
                navigation: {
                    counts: { running: 0, review: 0, past: 0, [bucket]: 1 },
                    running: bucket === 'running' ? [row] : [],
                    review: bucket === 'review' ? [row] : [],
                },
                page: { items: [row], nextCursor: null },
            },
        });
    });
}

const header = (page: Page) => page.locator('.page-header-actions');
const meta = (page: Page) => page.locator('.page-header-meta');
const sidebarRow = (page: Page, id: string) =>
    page.locator(`nav[aria-label="Primary"] .sidenav-task[href="/tasks/${id}"]`);

test.describe('task journeys', () => {
    const theme: Theme = 'dark';

    test('running → parked review wait → Mark done reads Done everywhere, with no follow-up offered', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await useTheme(page, theme);
        const me = await sessionAuthor(page);
        const id = parkedReviewWaitThread[0]!.id;
        const held = { jobs: authoredBy(parkedReviewWaitRunningThread, me) };
        await routeTask(page, held);
        let doneRequests = 0;
        await page.route('**/api/jobs/*/done', (route) => {
            doneRequests += 1;
            held.jobs = authoredBy(parkedReviewWaitMarkedDoneThread, me);
            return route.fulfill({ status: 200, json: {} });
        });
        await page.goto(`/tasks/${id}`);

        await expect(meta(page)).toContainText('Running');
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await expect(sidebarRow(page, id).locator('.sidenav-dot-running')).toBeVisible();
        await shoot(page, 'wait', 'running', theme);

        // The run finishes, publishes and parks on its review wait; the next polls carry it.
        held.jobs = authoredBy(parkedReviewWaitThread, me);
        await expect(meta(page)).toContainText('Waiting for review', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toHaveCount(0);
        await expect(header(page)).toContainText('No executor is running. The workflow is waiting for review.');
        await expect(sidebarRow(page, id).locator('.sidenav-dot-paused')).toBeVisible({ timeout: 10_000 });
        await shoot(page, 'wait', 'parked', theme);

        await header(page).getByRole('button', { name: 'Mark done' }).click();
        // Header.
        await expect(meta(page)).toContainText('Done', { timeout: 10_000 });
        await expect(meta(page)).not.toContainText('Waiting for review');
        await expect(header(page)).toContainText(`Closed by ${me.login}`);
        // Rail.
        await expect(page.locator('.task-outcome')).toContainText('Done');
        await expect(page.locator('.task-outcome')).not.toContainText('Waiting for review');
        // Sidebar: a closed task leaves the preview, and nothing else is open.
        await expect(sidebarRow(page, id)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.locator('nav[aria-label="Primary"] summary.sidenav-section')).toHaveText('All caught up');
        // No follow-up offered.
        await expect(page.locator('.task-follow-up')).toHaveCount(0);
        await expect(page.locator('textarea')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Ask for another pass' })).toHaveCount(0);
        expect(doneRequests).toBe(1);
        await shoot(page, 'wait', 'done', theme);

        // Inbox row: the closed task is past, reads Done and wears the done dot.
        await page.goto('/tasks?state=past');
        const row = page.locator('.inbox-row', { hasText: parkedReviewWaitThread[0]!.command });
        await expect(row.locator('.inbox-state .pill')).toHaveText('Done');
        await expect(row.locator('.sidenav-dot-done')).toBeVisible();
        await expect(row).not.toContainText('Waiting for review');
        await shoot(page, 'wait', 'inbox-done', theme);
        expect(problems.join('\n')).toBe('');
    });
});
