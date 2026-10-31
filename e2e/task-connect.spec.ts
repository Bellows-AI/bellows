import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import postgres from 'postgres';
import { E2E_DATABASE_URL } from '../playwright.config.js';

/**
 * The Connect block on the task page, against the real board: a queued task held by an
 * open connection requirement, seeded through the database like the other task-detail specs, acted
 * on as the AUTH_MODE=none stand-in member, `Local`. The OAuth hand-off and the bind are
 * task-connect-auth.spec.ts's (they need a signed-in caller); the provider-generic and read-only
 * renders are web/test/task-connect.*.test.tsx's.
 */

const SHOTS = 'artifacts/ui';

const sql = postgres(E2E_DATABASE_URL, { max: 1 });
let orgId: string;
let localId: string;

test.beforeAll(async () => {
    const [row] = await sql<{ orgId: string }[]>`select org_id as "orgId" from job limit 1`;
    orgId = row!.orgId;
    const [local] = await sql<{ id: string }[]>`select id from app_user where github_login = '__local__'`;
    localId = local!.id;
});

test.afterAll(async () => {
    await sql.end();
});

interface Held {
    source: 'create' | 'runtime';
    executionUser?: string;
}

/** One queued task and the open Jira requirement holding it. Ids are fresh per seed. */
async function seedHeld({ source, executionUser = localId }: Held): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        insert into job (org_id, id, root_job_id, command, status, attempts, created_by, execution_user_id)
        values (${orgId}, ${id}, ${id}, ${`needs a connection ${id.slice(0, 8)}`}, 'queued', 0, ${localId},
                ${executionUser})
    `;
    await sql`
        insert into job_integration_requirement (org_id, root_job_id, provider, reason, source, asked_job_id)
        values (${orgId}, ${id}, 'jira', 'missing', ${source}, ${source === 'runtime' ? id : null})
    `;
    return id;
}

async function open(page: Page, id: string, theme: 'light' | 'dark' = 'light'): Promise<Locator> {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem('factory.theme', t), theme);
    await page.goto(`/tasks/${id}`);
    const block = page.getByRole('region', { name: 'Jira connection needed' });
    await expect(block).toBeVisible();
    return block;
}

const shoot = (block: Locator, name: string) =>
    block.locator('xpath=ancestor::article').screenshot({ path: `${SHOTS}/task-connect-${name}.png` });

test.describe('the Connect block', () => {
    test('a run that asked for Jira reads paused and offers Connect and Continue without it', async ({ page }) => {
        const block = await open(page, await seedHeld({ source: 'runtime' }));
        await expect(block).toContainText('The run is paused');
        await expect(block.getByRole('button', { name: 'Connect Jira' })).toBeEnabled();
        await expect(block.getByRole('button', { name: 'Continue without it' })).toBeEnabled();
        await expect(block.getByRole('radio')).toHaveCount(0);
        await shoot(block, 'runtime-light');
    });

    test('the same block in the dark theme', async ({ page }) => {
        const block = await open(page, await seedHeld({ source: 'runtime' }), 'dark');
        await shoot(block, 'runtime-dark');
    });

    test('a creation-time requirement says the task has not started', async ({ page }) => {
        const block = await open(page, await seedHeld({ source: 'create' }));
        await expect(block).toContainText('This task has not started');
        await shoot(block, 'creation-light');
    });

    test('Continue without it dismisses the requirement and the block goes', async ({ page }) => {
        const id = await seedHeld({ source: 'runtime' });
        const block = await open(page, id);
        await block.getByRole('button', { name: 'Continue without it' }).click();
        await expect(block).toHaveCount(0);
        const [row] = await sql<{ outcome: string }[]>`
            select outcome from job_integration_requirement where root_job_id = ${id} and provider = 'jira'
        `;
        expect(row?.outcome).toBe('dismissed');
        // A dismissed task is claimable again; task-detail.spec.ts claims "the only queued task" next.
        await sql`delete from job where org_id = ${orgId} and id = ${id}`;
    });

    test('another member sees it read-only and is told who has to act', async ({ page }) => {
        const [owner] = await sql<{ id: string }[]>`
            insert into app_user (github_user_id, github_login, display_name)
            values (${Date.now()}, ${`owner-${Date.now()}`}, 'Octo Owner')
            returning id
        `;
        const block = await open(page, await seedHeld({ source: 'runtime', executionUser: owner!.id }));
        await expect(block).toContainText('Waiting for Octo Owner');
        await expect(block.getByRole('button')).toHaveCount(0);
        await shoot(block, 'read-only-light');
    });
});
