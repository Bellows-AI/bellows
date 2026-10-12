import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { BatchRecord } from '../web/src/batch-model.js';
import { BatchBoard } from './fixtures/batch-board.js';
import { seededTaskId } from './routes.js';
import { type Theme, VIEWPORTS } from './screenshot-matrix.js';
import { noHorizontalOverflow } from './viewport.js';

/**
 * The batch pages in a real browser, desktop and phone, in one theme — the theme only changes the
 * screenshots, and rendered contrast is matrix.spec.ts's (issue 584). The open board
 * runs no driver, so everything the scheduler would do is the fake board's (fixtures/batch-board.ts)
 * — but a draft is created and saved against the real API first, and the fake takes over from the
 * moment the saved batch exists. What is verified here is the page: that a draft round-trips,
 * that parallel progress, the human gate, the automatic continuation, retry, accept and cancel
 * are each readable and operable, and that nothing overflows at either width.
 */

const SHOTS = 'artifacts/ui/batches';
const POLL_WAIT = { timeout: 15_000 };
const PR = 'https://github.com/acme/widgets/pull/9';

/** Console errors, page errors and failed requests are all failures — collected, asserted once. */
function watchConsole(page: Page): string[] {
    const problems: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    return problems;
}

async function atTheme(page: Page, theme: Theme): Promise<void> {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem('factory.theme', t), theme);
}

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

    test('plan a batch, start it, and follow it through the gate to the end', async ({ page }) => {
        const problems = watchConsole(page);
        await atTheme(page, theme);
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

        // The review before launch: every effective value says where it came from.
        board.adopt({
            ...saved,
            cancelledAt: null,
            completedAt: null,
            activeStage: null,
            tasks: saved.tasks.map((task, index) => ({ ...task, rootJobId: index === 2 ? rootTask : null })),
        });
        await page.reload();
        const review = page.getByRole('region', { name: 'Before launch' });
        await expect(review).toContainText('inherited');
        await expect(review).toContainText('2 at a time');
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

        // — Parallel progress: two tasks of stage 1 run at once.
        board.update(
            id,
            { 'task-1': { execution: 'running', attempt: 1 }, 'task-2': { execution: 'running', attempt: 1 } },
            'stage-1'
        );
        const stageOne = page.locator('[data-stage="stage-1"]');
        await expect(stageOne.locator('.batch-task .pill-ok', { hasText: 'Running' })).toHaveCount(2, POLL_WAIT);
        await shoot(page, 'parallel', theme);

        // — The human gate: one PR to merge, one failed run; the page says what resumes by itself.
        board.update(id, {
            'task-1': {
                execution: 'succeeded',
                pr: PR,
                waitReason: `waiting for a person to merge ${PR}`,
                rootJobId: rootTask,
            },
            'task-2': { execution: 'failed' },
        });
        await expect(page.locator('.page-header-meta .pill')).toHaveText('Needs attention', POLL_WAIT);
        await expect(stageOne.getByRole('note')).toContainText('Human review gate.');
        await expect(stageOne.getByRole('note')).toContainText('next stage starts automatically');
        await expect(stageOne.getByText('Review and merge the pull request.')).toBeVisible();
        await expect(stageOne.getByRole('link', { name: 'Pull request' })).toHaveAttribute('href', PR);
        await shoot(page, 'gate', theme);

        // — Failure and retry: the board is asked, and the retry shows as a new attempt.
        await stageOne.getByRole('button', { name: 'Retry task-2' }).click();
        await expect(stageOne.locator('[data-task="task-2"]')).toContainText('Attempt 2', POLL_WAIT);
        await expect(stageOne.locator('[data-task="task-2"] .pill-ok')).toHaveText('Queued');
        expect(board.requests).toContain(`POST /${id}/tasks/task-2/retry`);

        // — Automatic continuation: the merge lands, stage 2 starts without anyone pressing anything.
        board.update(
            id,
            {
                'task-1': { gate: 'passed', waitReason: null },
                'task-2': { execution: 'succeeded', gate: 'passed', waitReason: null, pr: PR },
                'task-3': { execution: 'running' },
            },
            'stage-2'
        );
        await expect(page.locator('[data-stage="stage-2"]')).toHaveClass(/is-active/, POLL_WAIT);
        await expect(stageOne).toContainText('2/2 accepted');
        await expect(page.getByRole('region', { name: 'Report' })).toContainText('Merged so far');
        await shoot(page, 'continued', theme);

        // — Cancellation: confirmed, then the batch is history and offers no more controls.
        await page.getByRole('button', { name: 'Cancel batch' }).click();
        await expect(page.locator('.banner-warn')).toContainText('Merged pull requests stay merged');
        await page.getByRole('button', { name: 'Confirm cancel' }).click();
        await expect(page.locator('.page-header-meta .pill')).toHaveText('Cancelled', POLL_WAIT);
        await expect(page.getByRole('button', { name: 'Cancel batch' })).toHaveCount(0);
        await shoot(page, 'cancelled', theme);

        // — The task page links back to the batch that holds it.
        await page.goto(`/tasks/${rootTask}`);
        await expect(page.locator('.batch-backlink').getByRole('link')).toHaveAttribute('href', `/batches/${id}`);

        // — The list shows the batch with its verdict.
        await page.goto('/batches');
        await expect(page.getByRole('link', { name: `Upgrade the SDK (${theme}) v2` })).toBeVisible();
        await expect(page.locator('table.data .pill').first()).toHaveText('Cancelled');
        await shoot(page, 'list', theme);
        expect(problems.join('\n')).toBe('');
    });

    test('a task accepted by a person, not a merge, is accepted from its card', async ({ page }) => {
        const problems = watchConsole(page);
        await atTheme(page, theme);
        const board = new BatchBoard(page);
        await board.install();

        await page.goto('/batches/new');
        await page.getByLabel('Title').fill(`Manual check (${theme})`);
        await page.getByLabel('Repository (main)').fill('acme/widgets');
        await fillTask(page, 'Stage 1', 0, 'only');
        await page.getByLabel('Done when').selectOption('accepted');
        await page.getByLabel('Acceptance condition').fill('the dashboard loads');
        await page.getByRole('button', { name: 'Save draft' }).click();
        await expect(page).toHaveURL(/\/batches\/[0-9a-f-]{36}$/);
        const id = batchIdOf(page);
        const saved = (await page.request.get(`/api/batches/${id}`).then((r) => r.json())) as BatchRecord;
        board.adopt({ ...saved, cancelledAt: null, completedAt: null, activeStage: null });
        await page.reload();
        await page.getByRole('button', { name: 'Start batch' }).click();
        board.update(
            id,
            { 'task-1': { execution: 'succeeded', waitReason: 'waiting for acceptance: the dashboard loads' } },
            'stage-1'
        );
        const card = page.locator('[data-task="task-1"]');
        await expect(card).toContainText('the dashboard loads', POLL_WAIT);
        await shoot(page, 'accept', theme);
        await card.getByRole('button', { name: 'Accept task-1' }).click();
        await expect(card.locator('.pill-done')).toHaveText('Accepted', POLL_WAIT);
        expect(board.requests).toContain(`POST /${id}/tasks/task-1/accept`);
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
