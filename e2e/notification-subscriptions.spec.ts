import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { watchConsole } from './page-health.js';

/**
 * The notification subscriptions of the Organization and Workspace settings pages, through the real
 * board: create with a fake but valid webhook, edit with the webhook left blank, toggle Enabled, test
 * send, delete behind its confirmation. On the `chromium` (open board) project, whose local caller is
 * the seeded admin.
 *
 * Only the test send is faked (`page.route`): the offline server registers the real Discord
 * connector, and a real test send would leave the machine. The route itself is
 * server/test-db/notification-subscriptions.routes.test.ts's. The rows carry a repo filter no task
 * matches, so the board's own delivery never picks them up, and each test deletes what it creates.
 */

const SHOTS = 'artifacts/ui';
const WEBHOOK = 'https://discord.com/api/webhooks/00000000000000000/e2e-fake-token';
const REPO = 'e2e-org/no-such-repo';
const PERSONAL_ONLY_REPO = 'e2e-org/personal-only';
const DELIVERED = 'Test notification delivered.';

interface Scope {
    name: string;
    page: string;
    api: string;
    heading: string;
    tableLabel: string;
    shot: string;
}

const ORG: Scope = {
    name: 'organization',
    page: '/settings/organization',
    api: '/api/org/notification-subscriptions',
    heading: 'Organization notifications',
    tableLabel: 'Organization notification subscriptions',
    shot: 'notifications-org',
};
const PERSONAL: Scope = {
    name: 'personal',
    page: '/settings/workspace',
    api: '/api/workspace/notification-subscriptions',
    heading: 'My notifications',
    tableLabel: 'My notification subscriptions',
    shot: 'notifications-personal',
};

const table = (page: Page, scope: Scope) => page.getByRole('table', { name: scope.tableLabel });
const rowOf = (page: Page, scope: Scope, repo: string) => table(page, scope).getByRole('row').filter({ hasText: repo });

async function open(page: Page, scope: Scope) {
    await page.goto(scope.page);
    await expect(page.getByRole('heading', { name: scope.heading })).toBeVisible();
    // The first read confirms the caller can write here: the open board answers as the seeded admin.
    await expect(page.getByRole('button', { name: 'Add notification' })).toBeVisible();
}

async function create(page: Page, scope: Scope, repo: string) {
    await page.getByRole('button', { name: 'Add notification' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add notification' });
    await dialog.getByLabel('Webhook URL').fill(WEBHOOK);
    await dialog.getByLabel(/Repositories/).fill(repo);
    await page.screenshot({ path: `${SHOTS}/${scope.shot}-dialog.png` });
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(rowOf(page, scope, repo)).toBeVisible();
}

async function remove(page: Page, scope: Scope, repo: string) {
    await rowOf(page, scope, repo)
        .getByRole('button', { name: /^Actions for/ })
        .click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete notification' });
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(confirm).toBeHidden();
    await expect(rowOf(page, scope, repo)).toHaveCount(0);
}

/** The whole lifecycle of one row in one scope. */
async function lifecycle(page: Page, scope: Scope) {
    const problems = watchConsole(page);
    await open(page, scope);
    await create(page, scope, REPO);
    const row = rowOf(page, scope, REPO);
    await expect(row).toContainText('Discord');
    await expect(row).toContainText('Task ready');
    await expect(row.getByRole('checkbox', { name: /^Enabled/ })).toBeChecked();
    await expect(page.getByText(WEBHOOK)).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/${scope.shot}-list.png`, fullPage: true });

    // Edit with the webhook left blank: the stored one stays, so the save needs no credential.
    await row.getByRole('button', { name: /^Actions for/ }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const editor = page.getByRole('dialog', { name: 'Edit notification' });
    await expect(editor.getByLabel('Webhook URL')).toHaveValue('');
    await editor.getByRole('checkbox', { name: 'Admin action on a task' }).check();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toBeHidden();
    await expect(rowOf(page, scope, REPO)).toContainText('Admin action on a task');

    // A click, not `uncheck()`: the box is controlled, so it flips only once the write and re-read land.
    await rowOf(page, scope, REPO)
        .getByRole('checkbox', { name: /^Enabled/ })
        .click();
    await expect(rowOf(page, scope, REPO).getByRole('checkbox', { name: /^Enabled/ })).not.toBeChecked();
    await page.reload();
    await expect(rowOf(page, scope, REPO).getByRole('checkbox', { name: /^Enabled/ })).not.toBeChecked();

    // Test send, faked at the browser: the request goes to this scope's row, and the verdict reads as a sentence.
    const tested: string[] = [];
    await page.route('**/notification-subscriptions/*/test', async (route) => {
        tested.push(new URL(route.request().url()).pathname);
        await route.fulfill({ json: { result: { status: 'delivered' } } });
    });
    await rowOf(page, scope, REPO).getByRole('button', { name: 'Send test notification' }).click();
    await expect(page.getByText(DELIVERED)).toBeVisible();
    expect(tested).toHaveLength(1);
    expect(tested[0]).toMatch(new RegExp(`^${scope.api}/[0-9a-f-]{36}/test$`));
    await page.screenshot({ path: `${SHOTS}/${scope.shot}-tested.png`, fullPage: true });

    await remove(page, scope, REPO);
    expect(problems).toEqual([]);
}

test('the organization notifications: create, edit, toggle, test and delete', async ({ page, request }) => {
    // A personal row exists while the organization's lifecycle runs: it must never appear in the org table.
    const made = await request.post(PERSONAL.api, {
        data: {
            connectorKind: 'discord',
            connectorConfig: {},
            credential: WEBHOOK,
            eventKinds: ['task.ready'],
            repos: [PERSONAL_ONLY_REPO],
            enabled: true,
        },
    });
    expect(made.status()).toBe(201);
    const { id } = (await made.json()) as { id: string };
    try {
        await open(page, ORG);
        await expect(rowOf(page, ORG, PERSONAL_ONLY_REPO)).toHaveCount(0);
        await lifecycle(page, ORG);
    } finally {
        await request.delete(`${PERSONAL.api}/${id}`);
    }
});

test('my notifications: create, edit, toggle, test and delete', async ({ page }) => {
    await lifecycle(page, PERSONAL);
});
