import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { BatchRecord } from '../web/src/batch-model.js';
import { BatchBoard } from './fixtures/batch-board.js';
import { seededTaskId } from './routes.js';
import { type Theme, VIEWPORTS } from './screenshot-matrix.js';
import { noHorizontalOverflow } from './viewport.js';
import { useTheme, watchConsole } from './page-health.js';

/**
 * The batch pages in a real browser, desktop and phone, in one theme — the theme only changes the
 * screenshots, and rendered contrast is matrix.spec.ts's (issue 584). The open board
 * runs no driver, so everything the scheduler would do is the fake board's (fixtures/batch-board.ts)
 * — but a draft is created and saved against the real API first, and the fake takes over from the
 * moment the saved batch exists. What is verified here is the journey across pages: that a draft
 * round-trips and starts, that the task page links back to its batch, that the list shows it, and
 * that nothing overflows at either width. The started batch's own controls — parallel progress,
 * the human gate, the automatic continuation, retry, accept and cancel — are
 * `web/test/batch-detail.dom.test.tsx`; their screenshots are the nightly gallery's (baseline.spec.ts).
 */

const SHOTS = 'artifacts/ui/batches';

/** The step at desktop and at phone width, each checked for page-level overflow, then desktop again. */
async function shoot(page: Page, step: string, theme: Theme): Promise<void> {
    for (const viewport of [VIEWPORTS[1], VIEWPORTS[0]]) {
        await page.setViewportSize(viewport);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await noHorizontalOverflow(page);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
            path: `${SHOTS}/${step}_${theme}_${viewport.width}.png`,
            fullPage: true,
            animations: 'disabled',
        });
    }
}

const batchIdOf = (page: Page): string => new URL(page.url()).pathname.split('/').pop()!;

/** Fills one task's three text fields. */
async function fillTask(page: Page, section: string, taskIndex: number, text: string): Promise<void> {
    const task = page.getByRole('region', { name: section }).locator('fieldset').nth(taskIndex);
    await task.getByLabel('Instructions').fill(`${text}: do it`);
    await task.getByLabel('Acceptance').fill(`${text}: it works`);
    await task.getByLabel('Verification').fill('npm test');
}

test.describe('batch pages', () => {
    const theme: Theme = 'dark';

    test('plan a batch, start it, and find it from its task and the list', async ({ page }) => {
        const problems = watchConsole(page);
        await useTheme(page, theme);
        const board = new BatchBoard(page);
        await board.install();
        const rootTask = await seededTaskId(page);

        // — The way in: the sidenav reaches the list, and the list reaches a new draft by keyboard.
        await page.goto('/');
        await page.locator('.sidenav-link', { hasText: 'Batches' }).click();
        await expect(page).toHaveURL(/\/batches$/);
        await page.getByRole('link', { name: 'New batch' }).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(/\/batches\/new$/);

        // — Draft: created and saved against the real board.
        await expect(page.getByRole('heading', { level: 1, name: 'New batch' })).toBeVisible();
        await page.getByLabel('Title').fill(`Upgrade the SDK (${theme})`);
        await page.getByLabel('Concurrency').fill('2');
        await page.getByLabel('Repository (main)').fill('acme/widgets');
        await page.getByLabel('Default executor (optional)').fill('Main ORG');
        await page.getByLabel('Default executor scope').selectOption('org');
        await fillTask(page, 'Stage 1', 0, 'first');
        await page.getByRole('button', { name: 'Add task to stage 1' }).click();
        await fillTask(page, 'Stage 1', 1, 'second');
        await page.getByRole('button', { name: 'Add stage' }).click();
        await fillTask(page, 'Stage 2', 0, 'third');
        await shoot(page, 'draft', theme);

        await page.getByRole('button', { name: 'Save draft' }).click();
        await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
        const id = batchIdOf(page);
        await expect(page.getByRole('heading', { level: 1, name: `Upgrade the SDK (${theme})` })).toBeVisible();
        const saved = (await page.request.get(`/api/batches/${id}`).then((r) => r.json())) as BatchRecord;
        expect(saved.status).toBe('draft');
        expect(saved.tasks).toHaveLength(3);
        expect(saved.plan).toMatchObject({ executor: 'Main ORG', executorScope: 'org' });

        // The review before launch: every effective value says where it came from.
        board.adopt({
            ...saved,
            cancelledAt: null,
            completedAt: null,
            expiredAt: null,
            activeStage: null,
            tasks: saved.tasks.map((task, index) => ({ ...task, rootJobId: index === 2 ? rootTask : null })),
        });
        await page.reload();
        const review = page.getByRole('region', { name: 'Before launch' });
        await expect(review).toContainText('inherited');
        await expect(review).toContainText('2 at a time');
        await expect(review).toContainText('Main ORG (organization)');
        await shoot(page, 'review', theme);

        // An edit unsaved keeps check and start off until it is saved.
        await page.getByLabel('Title').fill(`Upgrade the SDK (${theme}) v2`);
        await expect(page.getByRole('button', { name: 'Start batch' })).toBeDisabled();
        await page.getByRole('button', { name: 'Save draft' }).click();
        await expect(page.getByRole('button', { name: 'Start batch' })).toBeEnabled();
        await page.getByRole('button', { name: 'Check launch' }).click();
        await expect(page.getByText('Launch checks passed')).toBeVisible();
        await page.getByRole('button', { name: 'Start batch' }).click();
        await expect(page.locator('.page-header-meta .pill')).toHaveText('Running');
        expect(board.requests.filter((entry) => entry.endsWith('/start'))).toHaveLength(1);

        // — The task page links back to the batch that holds it.
        await page.goto(`/tasks/${rootTask}`);
        await expect(page.locator('.batch-backlink').getByRole('link')).toHaveAttribute('href', `/batches/${id}`);

        // — The list shows the batch with its verdict.
        await page.goto('/batches');
        await expect(page.getByRole('link', { name: `Upgrade the SDK (${theme}) v2` })).toBeVisible();
        await expect(page.locator('table.data .pill').first()).toHaveText('Running');
        await shoot(page, 'list', theme);
        expect(problems.join('\n')).toBe('');
    });
});

test('a refused plan shows each problem at its field and writes nothing', async ({ page }) => {
    await page.goto('/batches/new');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.locator('p.status.error')).toContainText('The plan has problems');
    await expect(page.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/batches\/new$/);
});
