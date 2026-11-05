import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { E2E_DATABASE_URL } from '../playwright.config.js';
import { clearExecutors, E2E_REPO, saveExecutor, withExecutor } from './executor.js';
import { stubAttachments } from './fixtures/attachments.js';
import {
    authoredBy,
    CLOSING_GATE_STARTED_AT,
    closingGatesThread,
    failedGateFollowUpThread,
    failedGateThread,
    followUpThread,
    interruptedThread,
    measuredActivityOf,
    recordedActivityOf,
    publishedThread,
    routeThread,
    runningThread,
    sessionAuthor,
} from './fixtures/threads.js';
import { FORBIDDEN, watchConsole } from './page-health.js';

const SHOTS = 'artifacts/ui';

/** A literal 'NaN' or 'undefined' is what a missing null guard looks like to a reader. */

/** Queue a task through the real composer and land on its detail page. */
async function queueTask(page: Page, command: string): Promise<string> {
    await page.goto('/tasks/new');
    // The guided composer (#176): the prompt is a labelled field, the action is Start task.
    await page.getByLabel('What should the agent do?').fill(command);
    await page.getByRole('button', { name: 'Start task' }).click();
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
    return /\/tasks\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

/**
 * The board claim, driven the way the driver drives it — the offline board's worker routes are
 * open (AUTH_MODE=none), so the spec can move its own queued task through running and stopped
 * the same hands a real worker would.
 */
async function claimQueued(page: Page, taskId: string): Promise<string> {
    const response = await page.request.post('/api/jobs/claim', {
        data: { worker: 'e2e-task-detail', leaseSeconds: 300 },
    });
    expect(response.status(), 'the spec\u2019s own queued task is the only one claimable').toBe(200);
    const body = (await response.json()) as { id: string; leaseToken: string };
    expect(body.id).toBe(taskId);
    return body.leaseToken;
}

/** A seeded task — terminal, never marked done — from the summary read model. The seed's
 * command is 'seed task'; the spec's own queued tasks must never be mistaken for one. */
async function seededTaskId(page: Page, not?: string): Promise<string> {
    const response = await page.request.get('/api/tasks');
    const body = (await response.json()) as {
        page: { items: { id: string; command: string; doneAt: string | null }[] };
    };
    const open = body.page.items.find(
        (task) => task.doneAt === null && task.command === 'seed task' && task.id !== not
    );
    expect(open, 'the seed leaves succeeded tasks open').toBeTruthy();
    return open!.id;
}

/** The task's whole chain, the way the dialog counts it. */
async function threadLength(page: Page, taskId: string): Promise<number> {
    const response = await page.request.get(`/api/jobs/${taskId}/thread`);
    return ((await response.json()) as { jobs: unknown[] }).jobs.length;
}

const header = (page: Page) => page.locator('.task-actions');

test.describe('the task detail actions', () => {
    // queueTask starts through the real composer, which needs an executor to offer Start, and
    // the real board's create, which refuses an executor the member does not hold (#1019).
    test.beforeEach(async ({ page }) => {
        await saveExecutor(page);
        await withExecutor(page);
    });
    test.afterEach(({ page }) => clearExecutors(page));

    /**
     * The state matrix, driven through the board's own routes: every not-terminal state offers
     * Stop run; the request in flight and the request landed both read Stopping…; a terminal
     * open task offers Mark done as the one primary; Remove task lives only behind More task
     * actions and vanishes while any member of the thread is running.
     */
    test('Stop run spans queued, running and stopping; Mark done waits behind them', async ({ page }) => {
        const problems = watchConsole(page);

        // Queued: Stop run and the overflow both offered — the board lands queued stops directly.
        await queueTask(page, 'e2e — stop a queued task');
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await expect(header(page).getByRole('button', { name: 'More task actions' })).toBeVisible();
        await expect(page.locator('.task-controls')).toContainText('Queued');
        await page.screenshot({ path: `${SHOTS}/task-detail-queued.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Stop run' }).click();
        await expect(page.locator('.task-controls')).toContainText('Stopped · Needs review', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();

        // Running: claimed the way a driver claims. The overflow keeps only Rename — a running
        // member hides Remove — and stopping reads as a disabled, busy control.
        const runningId = await queueTask(page, 'e2e — stop a running task');
        const leaseToken = await claimQueued(page, runningId);
        await expect(page.locator('.task-controls')).toContainText('Running', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await header(page).getByRole('button', { name: 'More task actions' }).click();
        await expect(page.getByRole('menuitem', { name: 'Rename task' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Remove task' })).toHaveCount(0);
        await page.keyboard.press('Escape');
        await page.screenshot({ path: `${SHOTS}/task-detail-running.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Stop run' }).click();
        await expect(header(page).getByRole('button', { name: 'Stopping…' })).toBeDisabled({ timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeHidden();
        await page.screenshot({ path: `${SHOTS}/task-detail-stopping.png`, fullPage: true });

        // The park still has to land: the worker's suspend carries the stop stamp home.
        const parked = await page.request.post(`/api/jobs/${runningId}/suspend`, { data: { leaseToken } });
        expect(parked.status()).toBe(200);
        expect(((await parked.json()) as { status: string }).status).toBe('stopped');
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible({ timeout: 10_000 });

        // Mark done closes the task, and the closure reads as attribution, not a disabled control.
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toHaveClass(/primary/);
        await page.screenshot({ path: `${SHOTS}/task-detail-open.png`, fullPage: true });
        await header(page).getByRole('button', { name: 'Mark done' }).click();
        // The stand-in account AUTH_MODE=none attributes every action to.
        await expect(header(page).getByText('Closed by __local__')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('.task-controls')).toContainText('Done');
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeHidden();
        await expect(header(page).locator('button[disabled]')).toHaveCount(0);
        await page.screenshot({ path: `${SHOTS}/task-detail-done.png`, fullPage: true });

        for (const token of FORBIDDEN) expect(problems.join('\n'), token).not.toContain(token);
        expect(problems.join('\n')).toBe('');
    });

    test('the remove dialog: keyboard path, initial focus, focus restoration, refusal, and the route out', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        const taskId = await seededTaskId(page);
        await page.goto(`/tasks/${taskId}`);

        const trigger = header(page).getByRole('button', { name: 'More task actions' });
        // The dialog's layer wrapper is a zero-height positioning context — visibility reads on
        // the panel that floats inside it.
        const dialog = page.locator('.task-remove');

        // Keyboard open, exactly one destructive item, no Remove anywhere in the action row.
        await trigger.click();
        const item = page.getByRole('menuitem', { name: 'Remove task' });
        await expect(item).toBeVisible();
        expect(await header(page).getByRole('button', { name: 'Remove task' }).count()).toBe(0);

        // Escape closes the menu and hands focus back to its trigger.
        await page.keyboard.press('Escape');
        await expect(item).toBeHidden();
        await expect(trigger).toBeFocused();

        await trigger.click();
        await item.click();

        // The dialog names the task and every consequence — with the thread's REAL run count —
        // and Cancel holds the initial focus, so the destructive answer is never the first
        // thing a keypress reaches.
        const runs = await threadLength(page, taskId);
        await expect(dialog).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Remove \u201Cseed task\u201D?' })).toBeVisible();
        await expect(dialog.getByText(new RegExp(`This permanently deletes all ${runs} runs`))).toBeVisible();
        await expect(dialog.getByText(/their transcript from Bellows/)).toBeVisible();
        await expect(dialog.getByText(/worktree will be queued for deletion/)).toBeVisible();
        await expect(dialog.getByText(/Published branches and pull requests are not deleted/)).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
        await page.screenshot({ path: `${SHOTS}/task-remove-dialog.png`, fullPage: true });

        // The backdrop closes it too, focus landing on the trigger.
        await page.mouse.click(10, 500);
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();

        // Escape and Cancel each close it, focus landing on the trigger both times.
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();

        await trigger.click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
        await expect(page).toHaveURL(new RegExp(`${taskId}$`));

        // The board's refusal stays authoritative: fed a 409, the dialog holds its place, the
        // reason is announced once as an alert, and the page stays usable.
        await page.route(`**/api/jobs/${taskId}/remove`, (route) =>
            route.fulfill({
                status: 409,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'Task is running', code: 'TASK_RUNNING' }),
            })
        );
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();
        await dialog.getByRole('button', { name: 'Remove task' }).click();
        await expect(dialog.getByRole('alert')).toContainText('Task is running');
        await expect(dialog).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-remove-refused.png`, fullPage: true });
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        await page.unroute(`**/api/jobs/${taskId}/remove`);

        // A route-id change is a different conversation: a refusal earned on one task must not
        // haunt the next one's dialog. The modal holds the page while open, so the jump happens
        // after Cancel — the reset the page's id effect performs is what the fresh dialog proves.
        await page.getByRole('link', { name: 'View all tasks' }).click();
        await page.waitForURL(/\/tasks$/);
        await page.locator('.inbox-row a').first().click();
        await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await expect(dialog.getByRole('button', { name: 'Remove task' })).toBeEnabled();
        await dialog.getByRole('button', { name: 'Cancel' }).click();

        // The real removal: in flight the dialog cannot be dismissed — Escape included — and
        // the inbox is where the route ends.
        const currentId = /\/tasks\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
        await page.route(`**/api/jobs/${currentId}/remove`, async (route) => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            await route.continue();
        });
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Remove task' }).click();
        await dialog.getByRole('button', { name: 'Remove task' }).click();
        await expect(dialog.getByRole('button', { name: 'Removing\u2026' })).toBeDisabled();
        await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeVisible();
        await page.mouse.click(10, 500);
        await expect(dialog).toBeVisible();
        await expect(page).toHaveURL(/\/tasks$/, { timeout: 10_000 });
        await page.screenshot({ path: `${SHOTS}/task-removed-inbox.png`, fullPage: true });

        for (const token of FORBIDDEN) expect(problems.join('\n'), token).not.toContain(token);
        // The 409 the spec feeds the remove request is the test's own doing — the browser logs
        // the refused status itself, and the app's handling of it is what the assertions above
        // verified. It is the one console line this flow may produce.
        const real = problems.filter(
            (p) => p !== 'console: Failed to load resource: the server responded with a status of 409 (Conflict)'
        );
        expect(real.join('\n')).toBe('');
    });
});

const sql = postgres(E2E_DATABASE_URL, { max: 1 });

test.beforeAll(async () => {
    // A launch needs a tracked repository. The offline board lists the repositories its database
    // already holds sessions for, so the repository the mocked composer offers is given one —
    // `queueTask` drives the real create route, which validates against that list.
    await sql`
        insert into session_branch (agent, session_id, repo, branch, first_seen, last_seen, org_id)
        select 'claude-code', 'e2e-task-detail-tracked', ${`${E2E_REPO.owner}/${E2E_REPO.name}`}, 'main', now(), now(), m.org_id
        from app_user u join org_membership m on m.user_id = u.id
        where u.github_login = '__local__'
        on conflict do nothing
    `;
});

test.afterAll(async () => {
    await sql.end();
});

test.describe('the task detail page', () => {
    test('a follow-up thread labels its runs, verifies the newest, and links the thread PR', async ({ page }) => {
        await routeThread(page, followUpThread);
        await page.goto(`/tasks/${followUpThread[1]!.id}`);

        const conversation = page.locator('.task-conversation');
        await expect(conversation.getByText('Request', { exact: true })).toBeVisible();
        await expect(conversation.getByText('Follow-up', { exact: true })).toBeVisible();
        // Verification is the newest run's: lint failed on run 2.
        await expect(page.locator('.task-verification')).toContainText('lint');
        // The thread's publication came from run 1; the Outcome tile names the PR, shut or open.
        await expect(page.locator('.task-outcome .task-section-aside')).toHaveText('PR #1');
        await expect(page.locator('.task-outcome').getByRole('link', { name: '#1' })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-detail-thread.png`, fullPage: true });
    });

    test('the statistics modal reads the task tokens by type, "—" for unmeasured, and the review note', async ({
        page,
    }) => {
        await routeThread(page, followUpThread);
        await page.goto(`/tasks/${followUpThread[1]!.id}`);

        await page.locator('.task-activity > summary').click();
        await page.getByRole('button', { name: /Open task statistics/ }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText('1,240', { exact: true }).first()).toBeVisible();
        await expect(dialog.getByText('9,000').first()).toBeVisible();
        // Cache creation was never measured: a dash, not a zero.
        await expect(dialog.getByText('—').first()).toBeVisible();
        await expect(dialog).toContainText('Includes 1 review run.');
        await page.screenshot({ path: `${SHOTS}/task-detail-statistics.png`, fullPage: true });
    });

    test('the statistics modal shows the canonical task: review row, task-owned row, estimates, models', async ({
        page,
    }) => {
        await routeThread(page, followUpThread);
        await page.unroute('**/api/jobs/*/activity');
        await page.route('**/api/jobs/*/activity', (route) =>
            route.fulfill({ json: measuredActivityOf(followUpThread) })
        );
        const problems = watchConsole(page);
        await page.goto(`/tasks/${followUpThread[1]!.id}`);
        // The sidebar line is the newest run's own figures (2,000 uncached input), not the task's.
        await expect(page.locator('.task-stats-line')).toContainText('Uncached input 2,000');
        await page.locator('.task-activity > summary').click();
        await page.getByRole('button', { name: /Open task statistics/ }).click();
        const dialog = page.getByRole('dialog');

        // Task usage reads task.usage (5,640), not the newest run (2,000).
        const usage = dialog.getByRole('region', { name: 'Task usage' });
        await expect(usage.locator('[data-type="input"]')).toContainText('5,640');
        await expect(usage.locator('[data-type="cacheRead"]')).toContainText('~');
        await expect(usage.locator('[data-type="cacheCreation"]')).toContainText('1 of 2 sessions measured');
        // One row per run of the task, the review labelled by the run it reviews.
        await expect(dialog.locator('.task-stats-runs tbody > tr[data-kind]')).toHaveCount(3);
        await expect(dialog.getByRole('rowheader', { name: /Review of run 2/ })).toContainText(
            'run no longer on the board'
        );
        const owned = dialog.getByRole('region', { name: 'Task-owned, not assigned to a run' });
        await expect(owned).toContainText('usage between runs of this task');
        await expect(dialog.getByRole('region', { name: 'Not in the figures above' })).toContainText('1,234');
        // Models: the [1m] raw variant and the children behind a row open on demand.
        const models = dialog.getByRole('region', { name: 'Models' });
        await expect(models).toContainText('model-a');
        await dialog.getByRole('button', { name: 'Show usage details for Run 2' }).click();
        await expect(dialog.locator('.task-stats-detail')).toBeVisible();
        const text = await dialog.innerText();
        expect(text).not.toMatch(/NaN|undefined/);
        await page.screenshot({ path: `${SHOTS}/task-stats-dialog.png`, fullPage: true });

        await page.setViewportSize({ width: 390, height: 900 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow, 'the statistics modal overflows the page at 390px').toBeLessThanOrEqual(0);
        await page.screenshot({ path: `${SHOTS}/task-stats-dialog_390.png`, fullPage: true });
        expect(problems).toEqual([]);
    });

    test('the statistics modal shows gate counts, a reused badge, PR links, and a dash for what was not timed', async ({
        page,
    }) => {
        await routeThread(page, followUpThread);
        await page.unroute('**/api/jobs/*/activity');
        await page.route('**/api/jobs/*/activity', (route) =>
            route.fulfill({ json: recordedActivityOf(followUpThread) })
        );
        const problems = watchConsole(page);
        await page.goto(`/tasks/${followUpThread[1]!.id}`);
        await page.locator('.task-activity > summary').click();
        await page.getByRole('button', { name: /Open task statistics/ }).click();
        const dialog = page.getByRole('dialog');

        const gates = dialog.getByRole('region', { name: 'Gates' });
        await expect(gates.locator('dt', { hasText: 'Passed' })).toBeVisible();
        await expect(gates.locator('div', { has: page.locator('dt', { hasText: 'Passed' }) }).locator('dd')).toHaveText(
            '2'
        );
        await expect(gates.locator('div', { has: page.locator('dt', { hasText: 'Failed' }) }).locator('dd')).toHaveText(
            '1'
        );
        await expect(gates.getByText('reused', { exact: true })).toBeVisible();
        await expect(gates).toContainText('Reused the result of execution 0a1b2c3d: tree unchanged');
        // No execution carried its timing: a dash and the coverage, not a zero duration.
        await expect(
            gates.locator('div', { has: page.locator('dt', { hasText: 'Duration' }) }).locator('dd')
        ).toHaveText('—');
        await expect(gates).toContainText('Duration measured for 0 of 3 executions.');

        const prs = dialog.getByRole('region', { name: 'Pull requests' });
        await expect(prs.getByRole('link', { name: 'acme/web#7' })).toHaveAttribute(
            'href',
            'https://github.com/acme/web/pull/7'
        );
        await expect(
            prs.locator('div', { has: page.locator('dt', { hasText: 'Operations' }) }).locator('dd')
        ).toHaveText('2');
        await expect(
            prs.locator('div', { has: page.locator('dt', { hasText: 'Distinct PRs' }) }).locator('dd')
        ).toHaveText('1');
        expect(await dialog.innerText()).not.toMatch(/NaN|undefined/);
        await page.screenshot({ path: `${SHOTS}/task-stats-gates-prs.png`, fullPage: true });
        expect(problems).toEqual([]);
    });

    test('a run still going marks the task figures provisional', async ({ page }) => {
        await routeThread(page, runningThread);
        await page.unroute('**/api/jobs/*/activity');
        await page.route('**/api/jobs/*/activity', (route) =>
            route.fulfill({ json: measuredActivityOf(runningThread, { live: true }) })
        );
        await page.goto(`/tasks/${runningThread[runningThread.length - 1]!.id}`);
        await page.locator('.task-activity > summary').click();
        await page.getByRole('button', { name: /Open task statistics/ }).click();
        await expect(page.getByRole('dialog')).toContainText('provisional');
    });

    test('a refused activity read says the usage is unavailable, not zero', async ({ page }) => {
        await routeThread(page, followUpThread);
        await page.unroute('**/api/jobs/*/activity');
        await page.route('**/api/jobs/*/activity', (route) =>
            route.fulfill({ status: 503, json: { error: 'telemetry unavailable', code: 'UNAVAILABLE' } })
        );
        await page.goto(`/tasks/${followUpThread[1]!.id}`);
        await page.locator('.task-activity > summary').click();
        await page.getByRole('button', { name: /Open task statistics/ }).click();
        await expect(page.getByRole('dialog')).toContainText('Usage is unavailable');
    });

    // Issue #796: an attempt the infrastructure took reads apart from a failed retry.
    test('an interrupted run lists each interruption apart from its attempts', async ({ page }) => {
        await routeThread(page, interruptedThread);
        const problems = watchConsole(page);
        await page.goto(`/tasks/${interruptedThread[0]!.id}`);

        // The Task activity tile starts shut; its head opens it.
        await page.locator('.task-activity > summary').click();
        const interruptions = page.locator('.task-activity section', {
            has: page.getByRole('heading', { name: 'Interruptions' }),
        });
        await expect(interruptions).toContainText('not counted as failed attempts');
        await expect(interruptions.locator('.task-history-item')).toHaveText([
            /Claim 1: the driver was drained/,
            /Claim 2: infrastructure loss: the runner pod was deleted before it exited \(Evicted\)/,
        ]);
        await expect(interruptions.locator('time')).toHaveCount(2);
        await page.screenshot({ path: `${SHOTS}/task-detail-interrupted.png`, fullPage: true });

        await expect(page.getByRole('heading', { name: 'Run history' })).toHaveCount(0);
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${SHOTS}/task-detail-interrupted-390.png`, fullPage: true });
        expect(problems).toEqual([]);
    });

    test('a running task whose agent finished shows which gate runs and how many are left', async ({ page }) => {
        await routeThread(page, closingGatesThread);
        const problems = watchConsole(page);
        await page.clock.setFixedTime(new Date(Date.parse(CLOSING_GATE_STARTED_AT) + 134_000));
        await page.goto(`/tasks/${closingGatesThread[0]!.id}`);

        const strip = page.locator('.task-conversation .run-close-phase');
        await expect(strip.getByRole('status')).toContainText('Agent finished — running checks');
        await expect(strip.getByRole('status')).toContainText('3/5 gates passed');
        const lint = strip.locator('li', { hasText: 'lint' });
        await expect(lint).toContainText('running');
        await expect(lint).toContainText('2m 14s');
        await expect(strip.locator('li', { hasText: 'prettier' })).toContainText('pending');
        await page.screenshot({ path: `${SHOTS}/task-detail-closing-gates.png`, fullPage: true });
        await page.setViewportSize({ width: 390, height: 1000 });
        await page.screenshot({ path: `${SHOTS}/task-detail-closing-gates-390.png`, fullPage: true });
        expect(problems).toEqual([]);
    });

    test('a running run shows its activity and a bounded live output', async ({ page }) => {
        await routeThread(page, runningThread);
        const problems = watchConsole(page);
        await page.goto(`/tasks/${runningThread[0]!.id}`);
        await expect(page.getByText('Agent activity', { exact: true })).toBeVisible();
        await expect(page.locator('.task-conversation').getByText('→ Bash npm test')).toBeVisible();
        await expect(page.locator('.task-conversation pre')).toContainText('step 81 running');

        // The well is genuinely keyboard scrollable: the focusable element IS the scroller, so
        // arrows move the log and not the page. The fixture's output is tall enough to clip.
        const output = page.locator('.task-conversation pre.chat-output');
        await output.evaluate((el) => {
            el.scrollTop = el.scrollHeight;
        });
        const before = await output.evaluate((el) => el.scrollTop);
        expect(before).toBeGreaterThan(0);
        await output.focus();
        await page.keyboard.press('ArrowUp');
        // The scroll animates, so poll rather than read on the keypress's heels.
        await expect.poll(() => output.evaluate((el) => el.scrollTop), { timeout: 2_000 }).toBeLessThan(before);
        expect(problems).toEqual([]);
    });

    test('the detail renders at every target width without overflow', async ({ page }) => {
        test.setTimeout(60_000);
        await routeThread(page, authoredBy(publishedThread, await sessionAuthor(page)));

        for (const width of [360, 768, 1024, 1440]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.goto(`/tasks/${publishedThread[0]!.id}`);
            await expect(page.locator('.task-controls')).toBeVisible();
            const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth
            );
            expect(overflow, `${width}px overflows by ${overflow}px`).toBeLessThanOrEqual(0);

            const rail = await page.locator('.task-rail').boundingBox();
            const controls = await page.locator('.task-controls').boundingBox();
            const conversation = await page.locator('.task-conversation').boundingBox();
            const head = await page.locator('.task-head').boundingBox();
            if (width < 1024) {
                // DOM order: the head, then the rail (controls first), then the conversation.
                expect(head!.y + head!.height).toBeLessThanOrEqual(rail!.y + 1);
                expect(rail!.y + rail!.height).toBeLessThanOrEqual(conversation!.y + 1);
            } else {
                // The rail is a 340px right column from the app bar down, beside the head and the
                // conversation; the controls tile leads it.
                const appBar = await page.locator('header.appbar').boundingBox();
                expect(Math.round(rail!.width)).toBe(340);
                expect(conversation!.x + conversation!.width).toBeLessThanOrEqual(rail!.x + 1);
                expect(head!.x + head!.width).toBeLessThanOrEqual(rail!.x + 1);
                expect(Math.abs(rail!.y - (appBar!.y + appBar!.height))).toBeLessThanOrEqual(1);
                expect(Math.round(rail!.x + rail!.width)).toBe(width);
                expect(controls!.y).toBeLessThan(rail!.y + 20);
            }
            await page.screenshot({ path: `${SHOTS}/task-detail-${width}.png`, fullPage: true });
        }
    });

    test('a failed gate opens only its own output, counts only what happened, and the follow-up is sent', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        const me = await sessionAuthor(page);
        const followUp = failedGateFollowUpThread[1]!;
        await routeThread(page, authoredBy(failedGateThread, me));
        const sent: unknown[] = [];
        await page.route('**/api/jobs/*/follow-up', async (route) => {
            sent.push(route.request().postDataJSON());
            await routeThread(page, authoredBy(failedGateFollowUpThread, me));
            return route.fulfill({ status: 201, json: { id: followUp.id } });
        });
        await page.goto(`/tasks/${failedGateThread[0]!.id}`);

        await expect(page.locator('.task-controls')).toContainText('Failed · Needs review');
        await expect(page.locator('.task-controls')).toContainText('Verification failed');

        // A failed gate opens the Verification tile; its head still counts what happened.
        const verification = page.locator('.task-verification');
        await expect(verification).toHaveAttribute('open', '');
        await expect(verification.locator('.task-section-aside')).toHaveText('1 failed2 passed');
        const gate = (name: string) => verification.locator('.chat-gate-list details', { hasText: name });
        await expect(gate('lint')).toHaveAttribute('open', '');
        await expect(gate('build')).not.toHaveAttribute('open');
        await expect(gate('test').first()).not.toHaveAttribute('open');

        // The one long unbroken line scrolls inside its own well, never the page.
        const well = verification.getByLabel('Output of lint').locator('pre');
        expect(await well.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        await expect(verification.getByRole('button', { name: 'Copy output of lint' })).toBeVisible();
        // Issue #733: environment.setup time is its own row in the Task activity tile.
        await page.locator('.task-activity > summary').click();
        await expect(page.locator('.task-activity')).toContainText('Environment setup4m');
        await page.screenshot({ path: `${SHOTS}/task-detail-gate-failed.png`, fullPage: true });

        // Mark done and Remove both wait in the overflow.
        await header(page).getByRole('button', { name: 'More task actions' }).click();
        await expect(page.getByRole('menuitem', { name: 'Mark done' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Remove task' })).toBeVisible();
        await page.keyboard.press('Escape');

        // Ask for another pass lands the caret in the composer and sends nothing by itself; the rail
        // offers it once.
        await expect(page.getByRole('button', { name: 'Ask for another pass' })).toHaveCount(1);
        await header(page).getByRole('button', { name: 'Ask for another pass' }).click();
        const box = page.getByLabel('Ask for a follow-up');
        await expect(box).toBeFocused();
        expect(sent).toEqual([]);
        // Focusing the composer scrolls it into view; a full-page shot taken scrolled paints the fixed shell mid-image.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${SHOTS}/task-detail-gate-composer-focused.png`, fullPage: true });

        // Typed, not filled: the keystrokes land only if the caret really is in the composer.
        await page.keyboard.type(followUp.command);
        await expect(box).toHaveValue(followUp.command);
        await page.getByRole('button', { name: 'Send follow-up' }).click();

        await expect(page.locator('.task-conversation')).toContainText(followUp.command, { timeout: 10_000 });
        await expect(page.locator('.task-conversation').getByText('Follow-up', { exact: true })).toBeVisible();
        await expect(page.locator('.task-controls')).toContainText('Queued');
        // The head is queued now, so there is nothing to follow up yet.
        await expect(box).toHaveCount(0);
        expect(sent).toEqual([{ command: followUp.command }]);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: `${SHOTS}/task-detail-gate-follow-up-sent.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});

test.describe('the follow-up composer attachments', () => {
    test('the text and the file survive a trip to Settings, and the send carries both', async ({ page }) => {
        const problems = watchConsole(page);
        const me = await sessionAuthor(page);
        const board = await stubAttachments(page);
        const followUp = failedGateFollowUpThread[1]!;
        await routeThread(page, authoredBy(failedGateThread, me));
        const sent: { body: unknown; key: string | undefined }[] = [];
        await page.route('**/api/jobs/*/follow-up', async (route) => {
            const request = route.request();
            sent.push({ body: request.postDataJSON(), key: request.headers()['idempotency-key'] });
            await routeThread(page, authoredBy(failedGateFollowUpThread, me));
            return route.fulfill({ status: 201, json: { id: followUp.id } });
        });
        await page.goto(`/tasks/${failedGateThread[0]!.id}`);

        const box = page.getByLabel('Ask for a follow-up');
        await box.fill('also check the export');
        await page.getByLabel('Attach files', { exact: true }).setInputFiles({
            name: 'notes.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('hello'),
        });
        const chips = page.getByRole('list', { name: 'Attached files' });
        await expect(chips.getByText('Ready')).toBeVisible();

        // Settings must finish its first reads before the trip back, or leaving it cancels them mid-flight.
        const settingsLoaded = ['/api/workspace', '/api/repos', '/api/env'].map((path) =>
            page.waitForResponse((r) => new URL(r.url()).pathname === path)
        );
        await page.locator('.sidenav-link', { hasText: 'Settings' }).click();
        await expect(page).toHaveURL(/\/settings$/);
        await Promise.all(settingsLoaded);
        await page.goBack();
        await expect(box).toHaveValue('also check the export');
        await expect(chips.getByText('notes.txt')).toBeVisible();
        await expect(chips.getByText('Ready')).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-detail-follow-up-attachments.png`, fullPage: true });

        await page.getByRole('button', { name: 'Send follow-up' }).click();
        await expect.poll(() => sent.length).toBe(1);
        expect(sent[0]!.body).toEqual({ command: 'also check the export', attachments: [board.ids.get('notes.txt')] });
        expect(sent[0]!.key).toMatch(/^[0-9a-f]{32}$/);
        expect(problems.join('\n')).toBe('');
    });
});

test.describe('the attachments in the task history', () => {
    const PNG = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64'
    );
    const NOTES = Buffer.from('release notes, line one\n');
    const meta = (id: string, name: string, mediaType: string, bytes: Buffer) => ({
        id,
        name,
        mediaType,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        state: 'bound' as const,
    });

    test('after a reload each request lists its own files; the download is the uploaded bytes', async ({ page }) => {
        const problems = watchConsole(page);
        const me = await sessionAuthor(page);
        const image = meta('00000000-0000-4000-8000-0000000000b1', 'shot.png', 'image/png', PNG);
        // A real upload: Chromium never routes an `<a download>` request through page.route, so the download
        // reaches the board, which serves the uploader's own ready draft.
        const uploaded = await page.request.post('/api/attachments', {
            data: NOTES,
            headers: { 'content-type': 'application/octet-stream', 'x-attachment-name': 'notes.txt' },
        });
        expect(uploaded.status()).toBe(201);
        const notes = meta((await uploaded.json()).id, 'notes.txt', 'text/plain', NOTES);
        const later = meta('00000000-0000-4000-8000-0000000000b3', 'later.txt', 'text/plain', NOTES);
        const thread = authoredBy(failedGateFollowUpThread, me).map((j, i) => ({
            ...j,
            attachments: i === 0 ? [image, notes] : [later],
        }));
        await routeThread(page, thread);
        await page.route('**/api/attachments/*/content*', (route) => {
            const url = new URL(route.request().url());
            const png = url.pathname.includes(image.id);
            return route.fulfill({
                status: 200,
                body: png ? PNG : NOTES,
                headers: {
                    'content-type': png ? 'image/png' : 'text/plain',
                    'content-disposition': url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment',
                    'x-content-type-options': 'nosniff',
                },
            });
        });
        await page.goto(`/tasks/${thread[0]!.id}`);
        await page.reload();

        const exchanges = page.locator('.chat-exchange');
        await expect(exchanges.nth(0).getByText('shot.png').first()).toBeVisible();
        await expect(exchanges.nth(0).getByText('notes.txt')).toBeVisible();
        await expect(exchanges.nth(1).getByText('later.txt')).toBeVisible();
        await expect(exchanges.nth(1).getByText('notes.txt')).toHaveCount(0);
        await expect
            .poll(() =>
                exchanges
                    .nth(0)
                    .locator('img.attachment-preview')
                    .evaluate((i: HTMLImageElement) => i.naturalWidth)
            )
            .toBeGreaterThan(0);
        await page.screenshot({ path: `${SHOTS}/task-detail-attachments.png`, fullPage: true });

        const [download] = await Promise.all([
            page.waitForEvent('download'),
            exchanges
                .nth(0)
                .getByRole('link', { name: /Download notes\.txt/ })
                .click(),
        ]);
        expect(download.suggestedFilename()).toBe('notes.txt');
        const saved = await readFile((await download.path())!);
        expect(createHash('sha256').update(saved).digest('hex')).toBe(notes.sha256);
        expect(problems.join('\n')).toBe('');
    });

    test('an image whose read is refused says the preview is unavailable', async ({ page }) => {
        const me = await sessionAuthor(page);
        const image = meta('00000000-0000-4000-8000-0000000000b4', 'gone.png', 'image/png', PNG);
        const thread = authoredBy(failedGateThread, me).map((j) => ({ ...j, attachments: [image] }));
        await routeThread(page, thread);
        await page.route('**/api/attachments/*/content*', (route) => route.fulfill({ status: 503, body: '' }));
        await page.goto(`/tasks/${thread[0]!.id}`);
        await expect(page.getByText('Preview unavailable')).toBeVisible();
        await expect(page.getByRole('link', { name: /Download gone\.png/ })).toBeVisible();
    });
});

/** Stops the task the page shows (a queued stop lands directly) so no spec leaves a claimable task behind. */
async function stopShownTask(page: Page): Promise<void> {
    await header(page).getByRole('button', { name: 'Stop run' }).click();
    await expect(page.locator('.task-controls')).toContainText('Stopped · Needs review', { timeout: 10_000 });
}

test.describe('the task title (BEL-252)', () => {
    test.beforeEach(async ({ page }) => {
        await saveExecutor(page);
        await withExecutor(page);
    });
    test.afterEach(({ page }) => clearExecutors(page));

    const LONG_PROMPT = 'investigate the intermittent checkout timeout '.repeat(27).trim();
    const UNBROKEN_PROMPT = 'Q'.repeat(300);
    const CELLS = [
        { width: 1280, height: 800, scheme: 'light' as const },
        { width: 1280, height: 800, scheme: 'dark' as const },
        { width: 375, height: 800, scheme: 'light' as const },
        { width: 375, height: 800, scheme: 'dark' as const },
    ];

    /** The header's two-line contract and the page-level overflow contract, in one cell. */
    async function expectClampedHeader(page: Page, taskId: string, cell: (typeof CELLS)[number], shot: string) {
        await page.setViewportSize({ width: cell.width, height: cell.height });
        await page.emulateMedia({ colorScheme: cell.scheme });
        await page.goto(`/tasks/${taskId}`);
        const h1 = page.locator('.page-header-leading h1');
        // `Tasks` (no title=) stands until the thread lands.
        await expect(h1).toHaveAttribute('title', /.+/);
        const metrics = await h1.evaluate((el) => ({
            height: el.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
            title: el.getAttribute('title'),
            text: el.textContent,
        }));
        expect(metrics.height, 'at most two lines').toBeLessThanOrEqual(2 * metrics.lineHeight + 1);
        expect(metrics.title, 'the full display title rides title=').toBe(metrics.text);
        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow, 'no horizontal page overflow').toBeLessThanOrEqual(0);
        await page.screenshot({ path: `${SHOTS}/${shot}-${cell.width}-${cell.scheme}.png`, fullPage: true });
    }

    test('a 1,200-character prompt and an unbroken token clamp the heading to two lines and never widen the page', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        const longId = await queueTask(page, LONG_PROMPT);
        await stopShownTask(page);
        const unbrokenId = await queueTask(page, UNBROKEN_PROMPT);
        await stopShownTask(page);
        for (const cell of CELLS) {
            await expectClampedHeader(page, longId, cell, 'task-title-long');
            await expectClampedHeader(page, unbrokenId, cell, 'task-title-unbroken');
        }
        expect(problems).toEqual([]);
    });

    test('a long title is one ellipsized line in the sidebar and the actions stay in view', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        const id = await queueTask(page, LONG_PROMPT);
        await stopShownTask(page);
        const row = page.locator(`.sidenav-task[href="/tasks/${id}"]`);
        await expect(row).toBeVisible();
        const title = row.locator('.sidenav-task-title');
        const look = await title.evaluate((el) => ({
            overflow: getComputedStyle(el).textOverflow,
            whiteSpace: getComputedStyle(el).whiteSpace,
            height: el.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(el).lineHeight),
            clipped: el.scrollWidth > el.clientWidth,
        }));
        expect(look.overflow).toBe('ellipsis');
        expect(look.whiteSpace).toBe('nowrap');
        expect(look.height).toBeLessThanOrEqual(look.lineHeight + 1);
        expect(look.clipped).toBe(true);
        await expect(row.locator('.sidenav-task-author')).toBeVisible();
        await expect(title).toHaveAttribute('class', /sidenav-task-title/);
        await expect(row).toHaveAttribute('title', /.+/);
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeInViewport();
        await page.screenshot({ path: `${SHOTS}/task-title-sidebar.png`, fullPage: true });
    });

    test('Rename updates the header, sidebar and inbox of a finished task without a reload', async ({ page }) => {
        const id = await queueTask(page, 'e2e — rename me');
        await stopShownTask(page);
        // The detail poll has stopped: only the page's own refetch can show the new name.
        await page.evaluate(() => {
            (window as unknown as { __kept: boolean }).__kept = true;
        });
        await header(page).getByRole('button', { name: 'More task actions' }).click();
        await page.getByRole('menuitem', { name: 'Rename task' }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByLabel('Task title')).toHaveValue('e2e — rename me');
        await dialog.getByLabel('Task title').fill('Renamed by the author');
        await dialog.getByRole('button', { name: 'Save' }).click();
        await expect(dialog).toHaveCount(0);

        await expect(page.locator('.page-header-leading h1')).toHaveText('Renamed by the author');
        await expect(page.locator(`.sidenav-task[href="/tasks/${id}"] .sidenav-task-title`)).toHaveText(
            'Renamed by the author'
        );
        await page.getByRole('link', { name: 'View all tasks' }).click();
        await expect(page.getByRole('link', { name: 'Renamed by the author' }).first()).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
    });

    test('a task created without a title shows the first line of its prompt in the header and sidebar', async ({
        page,
    }) => {
        await page.goto('/tasks/new');
        await expect(page.getByLabel('Title (optional)')).toHaveCount(0);
        await page.getByLabel('What should the agent do?').fill('Fix the login crash');
        await page.getByRole('button', { name: 'Start task' }).click();
        await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}$/);
        const id = /\/tasks\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
        await expect(page.locator('.page-header-leading h1')).toHaveText('Fix the login crash');
        await stopShownTask(page);
        await expect(page.locator(`.sidenav-task[href="/tasks/${id}"] .sidenav-task-title`)).toHaveText(
            'Fix the login crash'
        );
    });
});

test.describe('the conversation scrolls on its own above a docked composer (BEL-263)', () => {
    type Thread = ReturnType<typeof authoredBy>;

    /** `count` finished exchanges ahead of `tail`, enough to overflow any viewport. */
    function longThread(tail: Thread[number], count = 14): Thread {
        const lead = followUpThread[0]!;
        const earlier = Array.from({ length: count }, (_, i) => ({
            ...lead,
            id: `aaaaaaaa-0000-4000-8000-0000002630${String(i).padStart(2, '0')}`,
            command: `step ${i + 1}: tidy the module and say what changed`,
            summary: `Step ${i + 1} done. ${'The agent explained what it changed and why. '.repeat(6)}`,
        }));
        return [...earlier, tail] as Thread;
    }

    const metrics = (page: Page) =>
        page.evaluate(() => {
            const conversation = document.querySelector('.task-conversation')!;
            const composer = document.querySelector('.task-follow-up')?.getBoundingClientRect();
            const exchanges = conversation.querySelectorAll('.chat-exchange');
            return {
                pageOverflow: document.scrollingElement!.scrollHeight - window.innerHeight,
                scrolls: conversation.scrollHeight > conversation.clientHeight,
                scrollTop: conversation.scrollTop,
                // A running run has no composer to dock: the conversation's own edge stands in.
                composerTop: composer?.top ?? conversation.getBoundingClientRect().bottom,
                composerBottom: composer?.bottom ?? null,
                lastBottom: exchanges[exchanges.length - 1]!.getBoundingClientRect().bottom,
            };
        });

    const toBottom = (page: Page) =>
        page.evaluate(() => {
            const conversation = document.querySelector('.task-conversation')!;
            conversation.scrollTop = conversation.scrollHeight;
        });

    for (const [state, tailOf] of [
        ['completed', () => followUpThread[0]!],
        ['error', () => followUpThread[1]!],
    ] as const) {
        test(`${state}: the page does not scroll, the composer does not move and the last line stays reachable`, async ({
            page,
        }) => {
            const author = await sessionAuthor(page);
            await page.setViewportSize({ width: 1440, height: 900 });
            await routeThread(
                page,
                authoredBy(
                    longThread({ ...tailOf(), id: 'aaaaaaaa-0000-4000-8000-000000263999' } as Thread[number]),
                    author
                )
            );
            const problems = watchConsole(page);
            await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000263000');
            await expect(page.locator('.task-follow-up textarea')).toBeVisible();

            await toBottom(page);
            const bottom = await metrics(page);
            expect(bottom.scrolls, 'the conversation is the scroller').toBe(true);
            expect(bottom.pageOverflow, 'no page-level scroll beside it').toBeLessThanOrEqual(0);
            // The last line is reachable and sits above the composer, never behind it.
            expect(bottom.lastBottom).toBeLessThanOrEqual(bottom.composerTop! + 1);
            await page.screenshot({ path: `${SHOTS}/task-detail-docked-${state}-1440-bottom.png` });

            await page.evaluate(() => {
                document.querySelector('.task-conversation')!.scrollTop = 0;
            });
            const top = await metrics(page);
            expect(Math.round(top.composerTop!), 'the composer does not move while the thread scrolls').toBe(
                Math.round(bottom.composerTop!)
            );
            expect(top.pageOverflow).toBeLessThanOrEqual(0);
            expect(problems).toEqual([]);
        });
    }

    test('scrolled up, new content does not move the reader; Jump to latest brings the newest line back', async ({
        page,
    }) => {
        const author = await sessionAuthor(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        const running = (extra: string) =>
            authoredBy(
                longThread({
                    ...runningThread[0]!,
                    id: 'aaaaaaaa-0000-4000-8000-000000263998',
                    output: `${runningThread[0]!.output}${extra}`,
                } as Thread[number]),
                author
            );
        await routeThread(page, running(''));
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000263000');
        await expect(page.locator('.task-conversation pre.chat-output').last()).toContainText('step 81 running');
        await toBottom(page);
        await page.screenshot({ path: `${SHOTS}/task-detail-docked-running-1440-bottom.png` });

        await page.evaluate(() => {
            document.querySelector('.task-conversation')!.scrollTop = 300;
        });
        // The next poll streams more output into the capped well: the thread's own height does
        // not move, and the reader stays put with Jump to latest on offer.
        await routeThread(page, running('\nstep 82 running\nstep 83 running'));
        const jump = page.getByRole('button', { name: 'Jump to latest' });
        await expect(jump).toBeVisible({ timeout: 10_000 });
        expect((await metrics(page)).scrollTop).toBe(300);
        await page.screenshot({ path: `${SHOTS}/task-detail-docked-running-1440-scrolled-up.png` });

        await jump.click();
        await expect(jump).toBeHidden();
        const after = await metrics(page);
        expect(after.lastBottom).toBeLessThanOrEqual(after.composerTop! + 1);
    });

    test('the live raw-output well does not follow new output once its reader scrolled up', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const withOutput = (lines: number) => [
            {
                ...runningThread[0]!,
                output: Array.from({ length: lines }, (_, i) => `step ${i + 1} ok`).join('\n'),
            },
        ];
        await routeThread(page, withOutput(80));
        await page.goto(`/tasks/${runningThread[0]!.id}`);
        const well = page.locator('.task-conversation pre.chat-output');
        await expect(well).toContainText('step 80 ok');
        await well.evaluate((el) => {
            el.scrollTop = 40;
        });
        await routeThread(page, withOutput(120));
        await expect(well).toContainText('step 120 ok', { timeout: 10_000 });
        expect(await well.evaluate((el) => el.scrollTop)).toBe(40);
    });

    test('a phone keeps the composer visible under the conversation', async ({ page }) => {
        const author = await sessionAuthor(page);
        await page.setViewportSize({ width: 390, height: 700 });
        await routeThread(
            page,
            authoredBy(
                longThread({ ...followUpThread[1]!, id: 'aaaaaaaa-0000-4000-8000-000000263999' } as Thread[number]),
                author
            )
        );
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000263000');
        await expect(page.locator('.task-follow-up textarea')).toBeVisible();
        await page.evaluate(() => {
            const main = document.querySelector('.task-main')!;
            window.scrollTo(0, main.getBoundingClientRect().top + window.scrollY - 56);
        });
        await toBottom(page);
        const phone = await metrics(page);
        expect(phone.scrolls).toBe(true);
        expect(phone.composerBottom!).toBeLessThanOrEqual(700);
        expect(phone.lastBottom).toBeLessThanOrEqual(phone.composerTop! + 1);
        await page.screenshot({ path: `${SHOTS}/task-detail-docked-error-390-bottom.png` });
        await page.evaluate(() => {
            document.querySelector('.task-conversation')!.scrollTop = 0;
        });
        await page.screenshot({ path: `${SHOTS}/task-detail-docked-error-390-top.png` });
    });

    test('1366x768: a tall right column scrolls on its own and cannot push the composer out of the viewport', async ({
        page,
    }) => {
        const author = await sessionAuthor(page);
        await page.setViewportSize({ width: 1366, height: 768 });
        // The published thread carries verification and published work in the rail.
        const tail = { ...publishedThread[publishedThread.length - 1]!, id: 'aaaaaaaa-0000-4000-8000-000000263997' };
        await routeThread(page, authoredBy(longThread(tail as Thread[number]), author));
        await page.goto('/tasks/aaaaaaaa-0000-4000-8000-000000263000');
        await expect(page.locator('.task-follow-up textarea')).toBeVisible();
        // Workflow metadata makes the rail taller still: stand in for it with extra rows.
        await page.locator('.task-rail').evaluate((el) => {
            for (let i = 0; i < 40; i++) {
                const row = document.createElement('p');
                row.textContent = `workflow metadata row ${i + 1}`;
                row.style.margin = '12px 0';
                el.appendChild(row);
            }
        });
        const fit = await page.evaluate(() => {
            const composer = document.querySelector('.task-follow-up')!.getBoundingClientRect();
            const rail = document.querySelector('.task-rail')!;
            const box = rail.getBoundingClientRect();
            return {
                pageOverflow: document.scrollingElement!.scrollHeight - window.innerHeight,
                composerBottom: composer.bottom,
                composerTop: composer.top,
                railBottom: box.bottom,
                railScrolls: rail.scrollHeight > rail.clientHeight,
                height: window.innerHeight,
            };
        });
        expect(fit.pageOverflow).toBeLessThanOrEqual(0);
        expect(fit.composerBottom).toBeLessThanOrEqual(fit.height);
        expect(fit.composerTop).toBeGreaterThan(0);
        // The right column is bounded by the viewport and scrolls its own overflow.
        expect(fit.railBottom).toBeLessThanOrEqual(fit.height);
        expect(fit.railScrolls).toBe(true);
        await page.screenshot({ path: `${SHOTS}/task-detail-docked-published-1366x768.png` });
    });
});
