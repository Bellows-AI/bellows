import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { ADMIN_ROLE } from '@factory-ai/core';
import { setRole } from './roles.js';
import { throughSignIn } from './signin.js';
import { ADD_LABEL, MODEL_CUSTOM_LABEL, SAVE_LABEL } from '../web/src/workspace/executors.js';

/**
 * Provider connections end to end, on the `auth` board's real routes and store: two connections on two providers,
 * an executor on each, a third executor sharing the first connection, independent switching, persistence across a
 * reload, and the rotation feedback. Only the provider itself is stubbed — the key check and the live model read
 * would reach a real provider — so no key leaves the machine.
 *
 * Everything this spec creates it removes through the routes, executors first (a connection an executor selects
 * cannot be deleted).
 */

const SHOTS = 'artifacts/ui';
const TEAM = 'E2E Team Anthropic';
const OPENAI = 'E2E Personal OpenAI';
const EXECUTORS = { claude: 'e2e-conn-claude', open: 'e2e-conn-open', shared: 'e2e-conn-shared' };
const TEAM_OPTION = `${TEAM} — Anthropic · Organization`;
const OPENAI_OPTION = `${OPENAI} — OpenAI · Personal`;

async function stubProvider(page: Page): Promise<void> {
    await page.route('**/api/model-setup/verify', (route) =>
        route.fulfill({ json: { ok: true, models: ['model-e2e-a', 'model-e2e-b'] } })
    );
    await page.route('**/api/provider-connections/*/models', (route) =>
        route.fulfill({ json: { state: 'listed', models: ['listed-e2e-one', 'listed-e2e-two'] } })
    );
}

async function asAdmin(page: Page) {
    await throughSignIn(page);
    await setRole(ADMIN_ROLE);
}

const section = (page: Page) =>
    page.locator('section').filter({ has: page.getByRole('heading', { name: /^Provider connections/ }) });
const connectionRow = (page: Page, name: string) => section(page).getByRole('row').filter({ hasText: name });

async function addConnection(
    page: Page,
    input: { name: string; provider: RegExp; key: string; scope: 'org' | 'personal' }
) {
    await page.getByRole('button', { name: 'Add connection' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add provider connection' });
    await dialog.getByLabel('Who can use it').selectOption(input.scope);
    await dialog.getByLabel('Name', { exact: true }).fill(input.name);
    await dialog.getByRole('radio', { name: input.provider }).check();
    await dialog.getByLabel(/^(API key|Setup token|Virtual key)$/).fill(input.key);
    await expect(dialog.getByRole('status', { name: 'Key check' })).toContainText('2 models available', {
        timeout: 10_000,
    });
    await page.screenshot({ path: `${SHOTS}/settings-model-connection-dialog.png` });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(connectionRow(page, input.name)).toBeVisible();
}

async function openExecutorDialog(page: Page, name: string | null): Promise<Locator> {
    if (name === null) await page.getByRole('button', { name: ADD_LABEL, exact: true }).click();
    else {
        await page
            .getByRole('region', { name: 'Executors' })
            .getByRole('row')
            .filter({ hasText: name })
            .getByRole('button', { name: 'Edit' })
            .click();
    }
    return page.getByRole('dialog', { name: name === null ? ADD_LABEL : 'Edit executor' });
}

async function addExecutor(page: Page, input: { name: string; agent: string; connection: string }) {
    const dialog = await openExecutorDialog(page, null);
    await dialog.getByLabel('Name', { exact: true }).fill(input.name);
    await dialog.getByLabel('Agent', { exact: true }).selectOption(input.agent);
    await dialog.getByLabel('Provider connection', { exact: true }).selectOption({ label: input.connection });
    await dialog.getByRole('button', { name: ADD_LABEL }).click();
    await expect(dialog).toHaveCount(0);
}

/** The executor's dialog shows `expected` as its selected connection, once the connection list has loaded. */
async function expectSelectedConnection(page: Page, executor: string, expected: string): Promise<void> {
    const dialog = await openExecutorDialog(page, executor);
    const select = dialog.getByLabel('Provider connection', { exact: true });
    await expect(select).not.toHaveValue('');
    // Until the list arrives the stored id renders as "Selected connection (not listed)": wait for the real label.
    await expect(select.locator('option:checked')).toHaveText(expected);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
}

/**
 * Opens a connection row's menu and picks `action`. The menu always opens below its trigger (web/src/anchor.ts) and a
 * click scrolls the trigger only to the viewport's edge, leaving the menu no room: the row comes to the middle first.
 */
async function chooseRowAction(page: Page, connection: string, action: string) {
    const trigger = page.getByRole('button', { name: `Actions for ${connection}` });
    await trigger.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await trigger.click();
    await page.getByRole('menu').getByRole('menuitem', { name: action }).click();
}

/** Removes the spec's executors and then its connections, through the routes. */
async function cleanUp(page: Page) {
    const workspace = (await (await page.request.get('/api/workspace')).json()) as {
        executors: { id: string; name: string }[];
    };
    for (const row of workspace.executors.filter((candidate) => candidate.name.startsWith('e2e-conn-'))) {
        await page.request.delete(`/api/workspace/executors/${row.id}`);
    }
    const listed = (await (await page.request.get('/api/provider-connections')).json()) as {
        connections: { id: string; name: string }[];
    };
    for (const row of listed.connections.filter((candidate) => [TEAM, OPENAI].includes(candidate.name))) {
        await page.request.delete(`/api/provider-connections/${row.id}`);
    }
}

test('two providers, two executors and a shared connection switch independently and persist', async ({ page }) => {
    // A long journey: three connection writes, three executors, a reload and a rotation.
    test.setTimeout(120_000);
    await stubProvider(page);
    await asAdmin(page);
    await cleanUp(page);
    try {
        // Two supported providers: an organization Anthropic key and a personal OpenAI key.
        await page.goto('/settings/model');
        await expect(section(page)).toBeVisible();
        await addConnection(page, { name: TEAM, provider: /^Anthropic/, key: 'sk-ant-api03-e2e-team', scope: 'org' });
        await addConnection(page, {
            name: OPENAI,
            provider: /^OpenAI/,
            key: 'sk-proj-e2e-personal',
            scope: 'personal',
        });
        await expect(connectionRow(page, TEAM)).toContainText('Organization');
        await expect(connectionRow(page, OPENAI)).toContainText('Personal');
        await page.screenshot({ path: `${SHOTS}/settings-model-connections.png`, fullPage: true });

        // Two executors on different providers, and a third sharing the first connection.
        await page.goto('/settings/executors');
        await addExecutor(page, { name: EXECUTORS.claude, agent: 'claude-code', connection: TEAM_OPTION });
        await addExecutor(page, { name: EXECUTORS.open, agent: 'opencode', connection: OPENAI_OPTION });
        await addExecutor(page, { name: EXECUTORS.shared, agent: 'opencode', connection: TEAM_OPTION });

        // The dialog explains what it leaves out: an OpenAI key cannot run Claude Code.
        const probe = await openExecutorDialog(page, null);
        await probe.getByLabel('Agent', { exact: true }).selectOption('claude-code');
        await expect(probe.getByRole('list', { name: 'Connections not offered' })).toContainText(OPENAI);
        await probe.getByRole('button', { name: 'Cancel' }).click();

        // The Model control lists the selected connection's live models.
        const editing = await openExecutorDialog(page, EXECUTORS.claude);
        await expect(editing.getByLabel('Provider connection', { exact: true })).toHaveValue(/.+/);
        await editing.getByRole('radio', { name: MODEL_CUSTOM_LABEL }).check();
        await expect(editing.getByText('2 models from ' + TEAM)).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/settings-executor-connection-dialog.png` });
        // The Model choice made the dialog dirty; a reload is the cleanest way out of it.
        await page.reload();
        await expect(page.getByRole('region', { name: 'Executors' })).toBeVisible();

        // Switching one executor to the other connection leaves the rest — and the connection itself — alone.
        const shared = await openExecutorDialog(page, EXECUTORS.shared);
        await shared.getByLabel('Provider connection', { exact: true }).selectOption({ label: OPENAI_OPTION });
        await shared.getByRole('button', { name: SAVE_LABEL }).click();
        await expect(shared).toHaveCount(0);

        // Reload: the references are what the board stored.
        await page.reload();
        await expect(page.getByRole('region', { name: 'Executors' })).toBeVisible();
        await expectSelectedConnection(page, EXECUTORS.claude, TEAM_OPTION);
        await expectSelectedConnection(page, EXECUTORS.open, OPENAI_OPTION);
        await expectSelectedConnection(page, EXECUTORS.shared, OPENAI_OPTION);
        await page.screenshot({ path: `${SHOTS}/settings-executors-connections.png`, fullPage: true });

        // Rotation says what happened, and the executors still reference the connection by name.
        await page.goto('/settings/model');
        await chooseRowAction(page, TEAM, 'Replace key');
        const rotate = page.getByRole('dialog', { name: 'Replace key' });
        await rotate.getByLabel('API key').fill('sk-ant-api03-e2e-rotated');
        await expect(rotate.getByRole('status', { name: 'Key check' })).toContainText('2 models available');
        await rotate.getByRole('button', { name: 'Replace key' }).click();
        await expect(rotate).toHaveCount(0);
        await expect(page.getByRole('status').filter({ hasText: `Replaced the key for “${TEAM}”.` })).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/settings-model-connection-rotated.png`, fullPage: true });

        // Removal is refused while executors select it, naming them.
        await chooseRowAction(page, TEAM, 'Remove');
        await page.getByRole('dialog').getByRole('button', { name: 'Remove connection' }).click();
        await expect(page.getByText(new RegExp(`“${TEAM}” is still used by .*${EXECUTORS.claude}`))).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/settings-model-connection-in-use.png`, fullPage: true });
    } finally {
        await cleanUp(page);
    }
});
