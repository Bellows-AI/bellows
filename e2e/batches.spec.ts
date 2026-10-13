import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { blankPlan, updateTask, type BatchRecord } from '../web/src/batch-model.js';
import { BatchBoard } from './fixtures/batch-board.js';
import { seededTaskId } from './routes.js';
import { type Theme, VIEWPORTS } from './screenshot-matrix.js';
import { noHorizontalOverflow } from './viewport.js';

/**
 * The batch pages in a real browser, desktop and phone, in one theme — the theme only changes the
 * screenshots, and rendered contrast is matrix.spec.ts's (issue 584). The open board
 * runs no driver, so everything the scheduler would do is the fake board's (fixtures/batch-board.ts)
 * — but a draft is created and saved against the real API first, and the fake takes over from the
 * moment the saved batch exists. What is verified here is the journey across pages: that a draft
 * round-trips and starts, that the task page links back to its batch, that the list shows it, and
 * that nothing overflows at either width. The started batch's own controls — parallel progress,
 * the human gate, the automatic continuation, retry, accept and cancel — are
 * `web/test/batch-detail.dom.test.tsx`.
 */

const SHOTS = 'artifacts/ui/batches';

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

    test('plan a batch, start it, and find it from its task and the list', async ({ page }) => {
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

for (const theme of ['light', 'dark'] as const) {
    test(`a failed stage verification reads as needing a person (${theme})`, async ({ page }) => {
        const problems = watchConsole(page);
        await atTheme(page, theme);
        const board = new BatchBoard(page);
        await board.install();
        const id = '0f53d75f-0000-4000-8000-000000000654';
        const plan = updateTask({ ...blankPlan('acme/widgets'), title: `Held stage (${theme})` }, 'task-1', (task) => ({
            ...task,
            objective: 'Bump it',
            acceptance: 'Builds',
            verification: 'npm test',
        }));
        const now = new Date().toISOString();
        board.adopt({
            id,
            status: 'running',
            version: 3,
            createdBy: null,
            startedBy: null,
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            cancelledAt: null,
            completedAt: null,
            expiredAt: null,
            activeStage: 'stage-1',
            plan,
            tasks: [
                {
                    key: 'task-1',
                    stage: 'stage-1',
                    execution: 'succeeded',
                    pr: 'https://github.com/acme/widgets/pull/9',
                    gate: 'passed',
                    waitReason: null,
                    rootJobId: null,
                    attempt: 1,
                },
            ],
            verification: [
                {
                    stage: 'stage-1',
                    state: 'failed',
                    detail: 'checks on main at cd89f3d2 fail: e2e failing',
                    headSha: 'cd89f3d2aabbccdd',
                    checkedAt: now,
                },
            ],
        });
        await page.goto(`/batches/${id}`);
        await expect(page.locator('.page-header-meta .pill')).toHaveText('Needs attention');
        const notice = page.locator('[data-verification="failed"]');
        await expect(notice).toContainText('verification of stage-1 failed');
        await expect(notice).toContainText('e2e failing');
        await expect(notice).toContainText('cd89f3d2');
        await expect(page.getByRole('region', { name: 'Stage 1' }).getByRole('button', { name: /Retry/ })).toHaveCount(
            0
        );
        await shoot(page, 'verification-failed', theme);
        expect(problems.join('\n')).toBe('');
    });
}

for (const theme of ['light', 'dark'] as const) {
    test(`an automerge PR the board is still merging reads as the board's, not yours (${theme})`, async ({ page }) => {
        const problems = watchConsole(page);
        await atTheme(page, theme);
        const board = new BatchBoard(page);
        await board.install();
        const id = '0f53d75f-0000-4000-8000-000000000693';
        const pr = 'https://github.com/acme/widgets/pull/12';
        const plan = updateTask(
            { ...blankPlan('acme/widgets'), title: `Board merging (${theme})`, policy: 'automerge' },
            'task-1',
            (task) => ({ ...task, objective: 'Bump it', acceptance: 'Builds', verification: 'npm test' })
        );
        const now = new Date().toISOString();
        board.adopt(
            {
                id,
                status: 'running',
                version: 3,
                createdBy: null,
                startedBy: null,
                createdAt: now,
                updatedAt: now,
                startedAt: now,
                cancelledAt: null,
                completedAt: null,
                expiredAt: null,
                activeStage: 'stage-1',
                plan,
                tasks: [
                    {
                        key: 'task-1',
                        stage: 'stage-1',
                        execution: 'succeeded',
                        pr,
                        gate: 'open',
                        waitReason: `waiting for the board to merge ${pr}`,
                        rootJobId: null,
                        attempt: 1,
                    },
                ],
                verification: [],
            },
            { state: 'running', tasks: [{ key: 'task-1', next: { action: 'wait' } }] }
        );
        await page.goto(`/batches/${id}`);
        const task = page.locator('[data-task="task-1"]');
        await expect(task.getByText('Board merging')).toBeVisible();
        await expect(page.locator('.page-header-meta .pill')).toHaveText('Running');
        await expect(task.getByText('Waiting for you')).toHaveCount(0);
        await expect(page.getByText('Review and merge the pull request.')).toHaveCount(0);
        await expect(page.getByText(/0 need you/)).toBeVisible();
        await shoot(page, 'board-merging', theme);
        expect(problems.join('\n')).toBe('');
    });
}

test('a refused plan shows each problem at its field and writes nothing', async ({ page }) => {
    await page.goto('/batches/new');
    await page.getByRole('button', { name: 'Save draft' }).click();
    await expect(page.locator('p.status.error')).toContainText('The plan has problems');
    await expect(page.getByLabel('Title')).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/batches\/new$/);
});
