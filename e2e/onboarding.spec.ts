import { randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ADMIN_ROLE } from '@factory-ai/core';
import { IDP_PORT } from '../playwright.config.js';
import { countLaunches } from './executor.js';
import { setRole } from './roles.js';
import { throughSignIn } from './signin.js';

/**
 * The setup walk end to end, in a real browser against the stub identity provider: a first sign-in
 * connects a provider and creates its default executor (the live key check is stubbed — no provider is
 * reached), skips the tracker, and starts its first task from Ready, which lands on the task page.
 * Ready's Repositories Change takes the reselect round trip and comes back to Ready.
 *
 * Only the provider's key check is stubbed: the create reaches the board, which only queues it (no
 * runner claims anything here). Create and continue makes a real connection with a sealed key and the executor on it,
 * the default: it is listed in Settings → Executors after a reload, the first task is launched on it, and the model
 * it will run is the executor's own default model. The lanes run a created task on the scripted model.
 */

const IDP = `http://127.0.0.1:${IDP_PORT}`;
const title = (page: Page, name: string) => page.getByRole('heading', { level: 1, name });

/** The key check's answer for any key: valid, with one model, so the executor card opens and Create is offered. */
async function stubKeyCheck(page: Page): Promise<void> {
    await page.route('**/api/provider-connections/verify', (route) =>
        route.fulfill({ json: { ok: true, models: ['claude-sonnet-e2e'] } })
    );
}

/** The executors these tests set up, by name: the shared board is left as the other specs expect it. */
const SETUP_EXECUTORS = ['Claude Code · Sonnet', 'e2e-org-setup'];

/**
 * Removes what a test's setup created, through the board's own routes: the default cleared explicitly (a selected
 * executor is never deleted silently), then the executor, then its connection. Tolerates a session that is gone.
 */
async function removeSetup(page: Page): Promise<void> {
    const read = await page.request.get('/api/workspace');
    if (!read.ok()) return;
    const workspace = (await read.json()) as {
        executors: { id: string; name: string; providerConnectionId?: string | null }[];
        orgExecutors: { id: string; name: string; providerConnectionId?: string | null }[];
    };
    type Row = { id: string; name: string; providerConnectionId?: string | null };
    const ours = (rows: Row[]) => rows.filter((row) => SETUP_EXECUTORS.includes(row.name));
    const connections: string[] = [];
    for (const row of ours(workspace.orgExecutors)) {
        await page.request.delete(`/api/org/executors/${row.id}?clearDefaults=true`);
        if (row.providerConnectionId) connections.push(row.providerConnectionId);
    }
    for (const row of ours(workspace.executors)) {
        await page.request.delete('/api/workspace/executors/default');
        await page.request.delete(`/api/workspace/executors/${row.id}`);
        if (row.providerConnectionId) connections.push(row.providerConnectionId);
    }
    for (const id of connections) await page.request.delete(`/api/provider-connections/${id}`);
}

// Back to the default account after every test, in a hook with its own budget: a test that times out
// cannot leave later files signed in as its newcomer.
test.afterEach(async ({ page, request }) => {
    await removeSetup(page);
    await request.post(`${IDP}/_control/identity`, { data: {} });
});

test('a first sign-in connects a provider, starts its first task from Ready and lands on it', async ({ page }) => {
    // A fresh account, so its membership carries no setup answer whatever other tests recorded.
    const newcomer = { login: `first-task-${randomInt(1e6)}`, id: 610_000_000 + randomInt(1e6) };
    await page.request.post(`${IDP}/_control/identity`, { data: newcomer });
    await stubKeyCheck(page);
    const launches = countLaunches(page);

    await page.goto('/');
    await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
    await title(page, 'Choose organizations and repositories').waitFor({ timeout: 60_000 });
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page).toHaveURL(/\/onboarding\/provider\?returnTo=%2F$/, { timeout: 60_000 });
    await expect(title(page, 'Connect a provider')).toBeVisible();
    const executorCard = page.getByRole('group', { name: 'Default executor' });
    // The executor card waits for the key check: dimmed, with its reason, until the key passes.
    await expect(executorCard).toHaveAttribute('aria-disabled', 'true');
    await expect(executorCard.getByText('Check the key first — the models come from the provider.')).toBeVisible();
    await page.screenshot({ path: 'artifacts/ui/onboarding-provider-empty.png', fullPage: true });
    await page.getByRole('radio', { name: /^Anthropic/ }).check();
    await page.getByLabel('API key').fill('sk-ant-api03-e2e-stub-key');
    await expect(page.getByRole('status', { name: 'Key check' })).toContainText('✓', { timeout: 10_000 });
    await expect(executorCard).not.toHaveAttribute('aria-disabled', 'true');
    await expect(executorCard.getByLabel('Executor name')).toHaveValue('Claude Code · Sonnet');
    const modelChip = await executorCard.getByRole('button', { name: /^Default model: / }).getAttribute('aria-label');
    const model = modelChip?.replace(/^Default model: /, '') ?? '';
    expect(model).toBe('claude-sonnet-e2e');
    await page.screenshot({ path: 'artifacts/ui/onboarding-provider-checked.png', fullPage: true });
    await page.getByRole('button', { name: 'Create and continue' }).click();

    await expect(page).toHaveURL(/\/onboarding\/tools\?returnTo=%2F$/, { timeout: 60_000 });
    await page.getByRole('button', { name: 'Skip for now' }).click();

    await expect(page).toHaveURL(/\/onboarding\/ready\?returnTo=%2F$/, { timeout: 60_000 });
    await expect(title(page, "You're set")).toBeVisible();
    await expect(page.getByRole('listitem', { name: 'Provider' })).toContainText('Anthropic · connection Anthropic');
    await expect(page.getByRole('listitem', { name: 'Default executor' })).toContainText(
        'Claude Code · Sonnet — claude-sonnet-e2e'
    );
    // The setup is the persisted default executor, not transient state: a reload reads it back.
    await page.reload();
    await expect(page.getByRole('listitem', { name: 'Default executor' })).toContainText(
        'Claude Code · Sonnet — claude-sonnet-e2e'
    );
    // The composer asks for a task in the preselected repository, its chips on one row in the wide column.
    await expect(page.getByLabel('What should the agent do?')).toHaveAttribute(
        'placeholder',
        /^Describe a task for [\w.-]+\/[\w.-]+…$/,
        { timeout: 60_000 }
    );
    await page.screenshot({ path: 'artifacts/ui/onboarding-ready.png', fullPage: true });
    const repoChip = await page.getByRole('button', { name: /^Repository: / }).boundingBox();
    const modelPicker = await page.getByRole('button', { name: /^Model: / }).boundingBox();
    expect(Math.abs(repoChip!.y + repoChip!.height / 2 - (modelPicker!.y + modelPicker!.height / 2))).toBeLessThan(4);

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

    // Start: the starter fills the request, the task is created on the default executor and opened.
    await page.getByRole('button', { name: 'Write CONTRIBUTING.md' }).click();
    await expect(page.getByLabel('What should the agent do?')).toHaveValue(/CONTRIBUTING\.md/);
    // The arrow shows at every width; Enter sends too.
    await expect(page.getByRole('button', { name: 'Start task' })).toBeVisible();
    await page.getByLabel('What should the agent do?').press('Enter');
    await expect(page).toHaveURL(/\/tasks\/[\w-]+$/, { timeout: 60_000 });
    expect(launches.bodies).toHaveLength(1);
    // The first task runs on the executor the provider step created and selected, by name.
    expect(launches.bodies[0]).toMatchObject({ executor: 'Claude Code · Sonnet' });
    const id = new URL(page.url()).pathname.split('/').pop();
    const job = (await (await page.request.get(`/api/jobs/${id}`)).json()) as { executor: string | null };
    expect(job.executor).toBe('Claude Code · Sonnet');
    const workspace = (await (await page.request.get('/api/workspace')).json()) as {
        defaultExecutor: { scope: string; name: string } | null;
        executors: { name: string; providerConnectionProvider: string | null }[];
        orgExecutors: { name: string; providerConnectionProvider: string | null }[];
    };
    expect(workspace.defaultExecutor).toMatchObject({ name: 'Claude Code · Sonnet' });
    // One connection, one executor: the key lives only on the connection the executor runs on.
    const created = [...workspace.executors, ...workspace.orgExecutors].filter(
        (e) => e.name === 'Claude Code · Sonnet'
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ providerConnectionProvider: 'anthropic' });
    const connections = (await (await page.request.get('/api/provider-connections')).json()) as {
        connections: { name: string }[];
    };
    expect(connections.connections.filter((c) => c.name === 'Anthropic')).toHaveLength(1);
    // The model the run takes is the executor's own default model, the one the card showed.
    const configs = (await (await page.request.get('/api/workspace/executors')).json()) as {
        executors: { name: string; config: { model?: string } }[];
    };
    expect(configs.executors.find((e) => e.name === 'Claude Code · Sonnet')?.config.model).toBe(model);

    // The executor is in Settings → Executors after a reload.
    await page.goto('/settings/executors');
    await expect(page.getByRole('row').filter({ hasText: 'Claude Code · Sonnet' }).first()).toBeVisible({
        timeout: 60_000,
    });
    await page.reload();
    await expect(page.getByRole('row').filter({ hasText: 'Claude Code · Sonnet' }).first()).toBeVisible({
        timeout: 60_000,
    });

    // Setup is complete: an app route stays put.
    await page.goto('/tasks');
    await expect(page.locator('.sidenav')).toBeVisible({ timeout: 60_000 });
    await expect(page).toHaveURL(/\/tasks$/);
});

test("an admin's setup creates an organization executor and default that every reload reads back", async ({ page }) => {
    await throughSignIn(page);
    await setRole(ADMIN_ROLE);
    await stubKeyCheck(page);
    await page.goto('/onboarding/provider?returnTo=%2Fsettings');
    // A board that already has a default shows it first; the admin adds another provider either way.
    const add = page.getByRole('button', { name: 'Add another provider' });
    await expect(add.or(page.getByRole('radiogroup', { name: 'Provider' }))).toBeVisible({ timeout: 30_000 });
    if (await add.isVisible()) await add.click();
    await page.getByRole('radio', { name: /^Anthropic/ }).check();
    await page.getByLabel('API key').fill('sk-ant-api03-e2e-org-stub-key');
    await expect(page.getByRole('status', { name: 'Key check' })).toContainText('✓', { timeout: 10_000 });
    await page.getByRole('radio', { name: /^Everyone in/ }).check();
    await page.getByLabel('Executor name').fill('e2e-org-setup');
    await page.screenshot({ path: 'artifacts/ui/onboarding-provider-org.png', fullPage: true });
    await page.getByRole('button', { name: 'Create and continue' }).click();
    await expect(page).toHaveURL(/\/onboarding\/(tools|ready)|\/settings/, { timeout: 30_000 });
    await page.goto('/onboarding/provider?returnTo=%2Fsettings');
    // The banner is the persisted default executor, with its connection, not what the form last held.
    await expect(page.getByText(/runs tasks on e2e-org-setup\./)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: 'Replace the key' })).toBeVisible();
    await page.screenshot({ path: 'artifacts/ui/onboarding-org-executor-provider.png', fullPage: true });

    await page.goto('/settings/executors');
    const region = page.getByRole('region', { name: 'Organization executors' });
    await expect(region.getByRole('row').filter({ hasText: 'e2e-org-setup' })).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(region.getByRole('row').filter({ hasText: 'e2e-org-setup' })).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: 'artifacts/ui/onboarding-org-executor-settings-executors.png', fullPage: true });

    const workspace = (await (await page.request.get('/api/workspace')).json()) as {
        defaultExecutor: { scope: string; name: string } | null;
        orgExecutors: { name: string; providerConnectionScope: string | null }[];
    };
    expect(workspace.defaultExecutor).toEqual({ scope: 'org', name: 'e2e-org-setup' });
    expect(workspace.orgExecutors.find((e) => e.name === 'e2e-org-setup')).toMatchObject({
        providerConnectionScope: 'org',
    });
});
