import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import postgres from 'postgres';
import { E2E_DATABASE_URL } from '../playwright.config.js';

/**
 * An agent's question in the task conversation, against the real board: seeded through the
 * database like the other task-detail specs, answered through the real answer route as the
 * AUTH_MODE=none stand-in member, `Local`. One theme: the read-only, failed and Other states are
 * web/test/task-question.render.test.tsx's, and rendered contrast is matrix.spec.ts's.
 */

const SHOTS = 'artifacts/ui';

const sql = postgres(E2E_DATABASE_URL, { max: 1 });
let orgId: string;

test.beforeAll(async () => {
    const [row] = await sql<{ orgId: string }[]>`select org_id as "orgId" from job limit 1`;
    orgId = row!.orgId;
});

test.afterAll(async () => {
    await sql.end();
});

const DATABASE = {
    question: 'Which database should the cache use?',
    header: 'Database',
    multiSelect: false,
    options: [
        { label: 'Postgres', description: 'Already running beside the board' },
        { label: 'SQLite', description: 'One file, no server' },
    ],
};

/**
 * One running task with one pending question. A running job's lease never expires inside the run,
 * so nothing claims it. Ids are fresh per seed.
 */
async function seedQuestion(): Promise<string> {
    const id = crypto.randomUUID();
    const lease = crypto.randomUUID();
    await sql`
        insert into job (org_id, id, root_job_id, command, status, attempts, lease_token, lease_expires_at,
                         started_at, finished_at, exit_code, summary)
        values (${orgId}, ${id}, ${id}, ${`pick a cache database ${id.slice(0, 8)}`}, 'running', 1,
                ${lease}, now() + interval '1 day', now(), null, null, null)
    `;
    await sql`
        insert into job_question (org_id, job_id, question_id, attempt, lease_token, questions, state)
        values (${orgId}, ${id}, ${`toolu_${id.slice(0, 8)}`}, 1, ${lease}, ${sql.json([DATABASE] as never)},
                'pending')
    `;
    return id;
}

async function open(page: Page, id: string): Promise<Locator> {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.addInitScript(() => localStorage.setItem('factory.theme', 'light'));
    await page.goto(`/tasks/${id}`);
    const question = page.locator('.question');
    await expect(question).toBeVisible();
    return question;
}

const shoot = (question: Locator, state: string) =>
    question.locator('xpath=ancestor::article').screenshot({ path: `${SHOTS}/task-question-${state}-light.png` });

const status = (question: Locator) => question.locator('[aria-live="polite"]');

test.describe('answering an agent question', () => {
    test('answers a pending single-select question → Answered by the member', async ({ page }) => {
        const question = await open(page, await seedQuestion());
        await expect(status(question)).toHaveText('Claude is waiting for your answer');
        await expect(page.locator('.page-header-meta')).toContainText('Needs answer');
        const submit = question.getByRole('button', { name: 'Submit' });
        await expect(submit).toBeDisabled();
        await shoot(question, 'waiting');

        await question.getByRole('radio', { name: /SQLite/ }).check();
        // Hold the answer in flight long enough to see the busy form.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route('**/questions/*/answer', async (route) => {
            await held;
            await route.continue();
        });
        await submit.click();
        await expect(question.getByRole('button', { name: 'Sending…' })).toBeDisabled();
        await expect(question.getByRole('radio', { name: /SQLite/ })).toBeDisabled();
        await shoot(question, 'submitting');
        release();

        await expect(status(question)).toContainText('Answered by Local');
        await expect(question.locator('dd')).toHaveText('SQLite');
        await expect(question.locator('input')).toHaveCount(0);
        await shoot(question, 'answered');
    });

    test('a second browser answering the same question sees it Answered (409)', async ({ browser, page }) => {
        const id = await seedQuestion();
        const first = await open(page, id);

        // The second member's thread stays on the pre-answer snapshot, so their Submit is what
        // learns about the first answer — the 409 — rather than the next poll.
        const other = await browser.newContext();
        const second = await other.newPage();
        const snapshot = await (await page.request.get(`/api/jobs/${id}/thread`)).json();
        await second.route('**/api/jobs/*/thread', (route) => route.fulfill({ json: snapshot }));
        const late = await open(second, id);
        await late.getByRole('radio', { name: /Postgres/ }).check();

        await first.getByRole('radio', { name: /SQLite/ }).check();
        await first.getByRole('button', { name: 'Submit' }).click();
        await expect(status(first)).toContainText('Answered by Local');

        const conflict = second.waitForResponse((response) => response.url().endsWith('/answer'));
        await late.getByRole('button', { name: 'Submit' }).click();
        expect((await conflict).status()).toBe(409);
        await expect(status(late)).toContainText('Answered by Local');
        await expect(late.locator('dd')).toHaveText('SQLite');
        await other.close();
    });
});
