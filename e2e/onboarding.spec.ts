import { randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { IDP_PORT } from '../playwright.config.js';
import { countLaunches } from './executor.js';

/**
 * The setup walk end to end, in a real browser against the stub identity provider: a first sign-in
 * connects a model (the live key check is stubbed — no provider is reached), skips the tracker, and
 * starts its first task from Ready, which lands on the task page. Ready's Repositories Change takes
 * the reselect round trip and comes back to Ready.
 *
 * Only the provider's key check is stubbed: the create reaches the board, which only queues it (no
 * runner claims anything here), and the stored job carries the agent and model the model step chose.
 * The lanes run a created task on the scripted model.
 */

const IDP = `http://127.0.0.1:${IDP_PORT}`;
const title = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

/** The key check's answer for any key: valid, with one model, so Save is offered. */
async function stubKeyCheck(page: Page): Promise<void> {
    await page.route('**/api/model-setup/verify', (route) =>
        route.fulfill({ json: { ok: true, models: ['claude-sonnet-e2e'] } })
    );
}

test('a first sign-in connects a model, starts its first task from Ready and lands on it', async ({ page }) => {
    // A fresh account, so its membership carries no setup answer whatever other tests recorded.
    const newcomer = { login: `first-task-${randomInt(1e6)}`, id: 610_000_000 + randomInt(1e6) };
    await page.request.post(`${IDP}/_control/identity`, { data: newcomer });
    try {
        await stubKeyCheck(page);
        const launches = countLaunches(page);

        await page.goto('/');
        await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
        await title(page, 'Choose organizations and repositories').waitFor({ timeout: 60_000 });
        await page.getByRole('button', { name: 'Continue' }).click();

        await expect(page).toHaveURL(/\/onboarding\/model\?returnTo=%2F$/, { timeout: 60_000 });
        await page.getByRole('radio', { name: /^Anthropic/ }).check();
        await page.getByLabel('API key').fill('sk-ant-api03-e2e-stub-key');
        await expect(page.getByRole('status', { name: 'Key check' })).toContainText('✓', { timeout: 10_000 });
        const agent = await page.getByLabel('Agent', { exact: true }).inputValue();
        const model = await page.getByLabel('Model', { exact: true }).inputValue();
        await page.getByRole('button', { name: /^(Save and continue|Continue)$/ }).click();

        await expect(page).toHaveURL(/\/onboarding\/tools\?returnTo=%2F$/, { timeout: 60_000 });
        await page.getByRole('button', { name: 'Skip for now' }).click();

        await expect(page).toHaveURL(/\/onboarding\/ready\?returnTo=%2F$/, { timeout: 60_000 });
        await expect(title(page, "You're set")).toBeVisible();
        await expect(page.getByRole('listitem', { name: 'Model' })).toContainText(`Claude Code · Anthropic · ${model}`);
        await page.screenshot({ path: 'artifacts/ui/onboarding-ready.png', fullPage: true });

        // Repositories' Change: the reselect round trip, back to Ready — never "That sign-in expired".
        await page
            .getByRole('listitem', { name: 'Repositories' })
            .getByRole('link', { name: /Change/ })
            .click();
        await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByText('That sign-in expired')).toHaveCount(0);
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page).toHaveURL(/\/onboarding\/ready/, { timeout: 60_000 });
        await expect(title(page, "You're set")).toBeVisible();

        // Start: the starter fills the request, the task is created on the agent default and opened.
        await page.getByRole('button', { name: 'Write CONTRIBUTING.md' }).click();
        await expect(page.getByLabel('What should the agent do?')).toHaveValue(/CONTRIBUTING\.md/);
        await page.getByRole('button', { name: 'Start task' }).click();
        await expect(page).toHaveURL(/\/tasks\/[\w-]+$/, { timeout: 60_000 });
        expect(launches.bodies).toHaveLength(1);
        expect(launches.bodies[0]).not.toHaveProperty('executor');
        // The board stored the task on the onboarding choice: the agent default, frozen on the job.
        const id = new URL(page.url()).pathname.split('/').pop();
        const job = (await (await page.request.get(`/api/jobs/${id}`)).json()) as {
            agentType: string | null;
            agentModel: string | null;
        };
        expect(job.agentType).toBe(agent);
        expect(job.agentModel).toBe(model);

        // Setup is complete: an app route stays put, with no "No model yet" banner.
        await page.goto('/tasks');
        await expect(page.locator('.sidenav')).toBeVisible({ timeout: 60_000 });
        await expect(page).toHaveURL(/\/tasks$/);
        await expect(page.locator('.no-model-banner')).toHaveCount(0);
    } finally {
        await page.request.post(`${IDP}/_control/identity`, { data: {} });
    }
});
