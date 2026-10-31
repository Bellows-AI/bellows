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

const header = (page: Page) => page.locator('.page-header-actions');

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
        await expect(page.locator('.page-header-meta')).toContainText('Queued');
        await page.screenshot({ path: `${SHOTS}/task-detail-queued.png`, fullPage: true });

        await header(page).getByRole('button', { name: 'Stop run' }).click();
        await expect(page.locator('.page-header-meta')).toContainText('Stopped · Needs review', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Mark done' })).toBeVisible();

        // Running: claimed the way a driver claims. The overflow is gone — a running member
        // hides Remove — and stopping reads as a disabled, busy control.
        const runningId = await queueTask(page, 'e2e — stop a running task');
        const leaseToken = await claimQueued(page, runningId);
        await expect(page.locator('.page-header-meta')).toContainText('Running', { timeout: 10_000 });
        await expect(header(page).getByRole('button', { name: 'Stop run' })).toBeVisible();
        await expect(header(page).getByRole('button', { name: 'More task actions' })).toBeHidden();
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
        await expect(page.locator('.page-header-meta')).toContainText('Done');
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
        await expect(page.locator('#task-verification')).toContainText('lint');
        // The thread's publication came from run 1; the link says what it is.
        await expect(page.locator('.task-published')).toContainText('Pull request #1');
        await expect(page.getByRole('link', { name: 'View checks' })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-detail-thread.png`, fullPage: true });
    });

    test('the statistics modal reads the task tokens by type, "—" for unmeasured, and the review note', async ({
        page,
    }) => {
        await routeThread(page, followUpThread);
        await page.goto(`/tasks/${followUpThread[1]!.id}`);

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
        await page.getByRole('button', { name: /Open task statistics/ }).click();
        await expect(page.getByRole('dialog')).toContainText('Usage is unavailable');
    });

    // Issue #796: an attempt the infrastructure took reads apart from a failed retry.
    test('an interrupted run lists each interruption apart from its attempts', async ({ page }) => {
        await routeThread(page, interruptedThread);
        const problems = watchConsole(page);
        await page.goto(`/tasks/${interruptedThread[0]!.id}`);

        const interruptions = page.locator('.task-outcome section', {
            has: page.getByRole('heading', { name: 'Interruptions' }),
        });
        await expect(interruptions).toContainText('not counted as failed attempts');
        await expect(interruptions.locator('.task-history-item')).toHaveText([
            /Claim 1: the driver was drained/,
            /Claim 2: infrastructure loss: the runner pod was deleted before it exited \(Evicted\)/,
        ]);
        await expect(interruptions.locator('time')).toHaveCount(2);
        await page.screenshot({ path: `${SHOTS}/task-detail-interrupted.png`, fullPage: true });

        await page.getByRole('heading', { name: 'Run history' }).click();
        await expect(page.locator('.run-history')).toContainText('Run 1 interrupted: the driver was drained');
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
            await expect(page.locator('.task-outcome')).toBeVisible();
            const overflow = await page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth
            );
            expect(overflow, `${width}px overflows by ${overflow}px`).toBeLessThanOrEqual(0);

            const outcome = await page.locator('.task-outcome').boundingBox();
            const conversation = await page.locator('.task-conversation').boundingBox();
            const railColumns = await page
                .locator('.task-outcome-body')
                .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
            const support = await page.locator('.task-support').boundingBox();
            if (width < 1024) {
                // The outcome sits above the conversation, DOM order: a two-column summary, and
                // one column on a phone, where two key/value columns cannot hold a label. The
                // supporting panels follow the conversation and composer.
                expect(outcome!.y + outcome!.height).toBeLessThanOrEqual(conversation!.y + 1);
                const main = await page.locator('.task-main').boundingBox();
                expect(main!.y + main!.height).toBeLessThanOrEqual(support!.y + 1);
                expect(railColumns, `${width}px rail columns`).toBe(width < 600 ? 1 : 2);
            } else {
                // The main column owns the left and stays the wider one; the rail is 320px.
                expect(conversation!.x).toBeLessThan(outcome!.x);
                expect(conversation!.width).toBeGreaterThan(outcome!.width!);
                expect(Math.round(outcome!.width!)).toBe(320);
                // The panels share the sidebar, under the outcome, not under the conversation.
                expect(support!.x).toBeGreaterThan(conversation!.x + conversation!.width! - 1);
                expect(support!.y).toBeGreaterThanOrEqual(outcome!.y + outcome!.height! - 1);
                expect(railColumns, `${width}px rail columns`).toBe(1);
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

        await expect(page.locator('.page-header-meta')).toContainText('Failed · Needs review');
        await expect(page.locator('.page-header-meta')).toContainText('Verification failed');

        const verification = page.locator('#task-verification');
        await expect(verification.locator('.task-verification-counts')).toHaveText('1 failed2 passed');
        await expect(verification.locator('details', { hasText: 'lint' })).toHaveAttribute('open', '');
        await expect(verification.locator('details', { hasText: 'build' })).not.toHaveAttribute('open');
        await expect(verification.locator('details', { hasText: 'test' }).first()).not.toHaveAttribute('open');

        // The one long unbroken line scrolls inside its own well, never the page.
        const well = verification.getByLabel('Output of lint').locator('pre');
        expect(await well.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
        await expect(verification.getByRole('button', { name: 'Copy output of lint' })).toBeVisible();
        // Issue #733: environment.setup time is its own row, apart from the wall clock.
        await expect(page.locator('.task-outcome')).toContainText('Environment setup4m');
        await page.screenshot({ path: `${SHOTS}/task-detail-gate-failed.png`, fullPage: true });

        // Mark done and Remove both wait in the overflow.
        await header(page).getByRole('button', { name: 'More task actions' }).click();
        await expect(page.getByRole('menuitem', { name: 'Mark done' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Remove task' })).toBeVisible();
        await page.keyboard.press('Escape');

        // Ask for another pass lands the caret in the composer and sends nothing by itself — from
        // the header and from the rail's next action alike.
        await header(page).getByRole('button', { name: 'Ask for another pass' }).click();
        await expect(page.getByLabel('Ask for a follow-up')).toBeFocused();
        await page.locator('.task-outcome').getByRole('button', { name: 'Ask for another pass' }).click();
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
        await expect(page.locator('.page-header-meta')).toContainText('Queued');
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

        await page.locator('.sidenav-link', { hasText: 'Settings' }).click();
        await expect(page).toHaveURL(/\/settings$/);
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
