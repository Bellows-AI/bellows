import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { AUTH_DATABASE_URL, E2E_LOGIN, IDP_PORT } from '../playwright.config.js';
import { throughSignIn } from './signin.js';

/**
 * The Connect block's two ways out against the real OAuth flow and the Atlassian stand-in
 * (`e2e/stub-idp.mjs`), as a signed-in member: Connect Jira goes through consent and returns to
 * the task with the requirement bound, and an existing connection is picked and bound. The block's
 * renders and Continue without it are task-connect.spec.ts's (no sign-in needed).
 */

const SHOTS = 'artifacts/ui';

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(AUTH_DATABASE_URL, { max: 1 });
    try {
        return await run(sql);
    } finally {
        await sql.end();
    }
}

async function disconnectAll(page: Page) {
    const listed = await page.request.get('/api/connections');
    const { connections } = (await listed.json()) as { connections: Array<{ id: string }> };
    for (const row of connections) await page.request.delete(`/api/connections/${row.id}`);
}

const consentAs = (page: Page, account: 'a' | 'b') =>
    page.request.post(`http://127.0.0.1:${IDP_PORT}/atlassian/_control`, { data: { account, deny: false } });

/** A queued task of the signed-in member, held by one open Jira requirement. */
const seedHeld = (reason: 'missing' | 'ambiguous') =>
    withSql(async (sql) => {
        const [member] = await sql<{ userId: string; orgId: string }[]>`
            select u.id as "userId", m.org_id as "orgId"
            from app_user u join org_membership m on m.github_login = u.github_login
            where u.github_login = ${E2E_LOGIN} limit 1
        `;
        const id = crypto.randomUUID();
        await sql`
            insert into job (org_id, id, root_job_id, command, status, attempts, created_by, execution_user_id)
            values (${member!.orgId}, ${id}, ${id}, ${`needs jira ${id.slice(0, 8)}`}, 'queued', 0, ${member!.userId},
                    ${member!.userId})
        `;
        await sql`
            insert into job_integration_requirement (org_id, root_job_id, provider, reason, source, asked_job_id)
            values (${member!.orgId}, ${id}, 'jira', ${reason}, 'runtime', ${id})
        `;
        return id;
    });

const outcomeOf = (id: string) =>
    withSql(async (sql) => {
        const [row] = await sql<{ outcome: string | null }[]>`
            select outcome from job_integration_requirement where root_job_id = ${id} and provider = 'jira'
        `;
        return row?.outcome ?? null;
    });

test.beforeEach(async ({ page }) => {
    await throughSignIn(page);
    await disconnectAll(page);
    await consentAs(page, 'a');
});

test.afterEach(async ({ page }) => {
    await disconnectAll(page);
});

test('Connect Jira goes through consent, returns to the task and binds the requirement', async ({ page }) => {
    const id = await seedHeld('missing');
    await page.goto(`/tasks/${id}`);
    const block = page.getByRole('region', { name: 'Jira connection needed' });
    await block.getByRole('button', { name: 'Connect Jira' }).click();

    await expect(page).toHaveURL(new RegExp(`/tasks/${id}`));
    await expect(block).toHaveCount(0);
    await expect.poll(() => outcomeOf(id)).toBe('bound');
    await page.screenshot({ path: `${SHOTS}/task-connect-bound.png`, fullPage: true });
});

test('an existing connection is listed, picked and bound', async ({ page }) => {
    await page.goto('/settings/workspace');
    await page.getByRole('button', { name: 'Connect Jira' }).click();
    await page
        .getByRole('dialog', { name: 'Connect Jira' })
        .getByRole('button', { name: 'Continue to Atlassian' })
        .click();
    await expect(page.getByText('Jira connected.')).toBeVisible();

    const id = await seedHeld('ambiguous');
    await page.goto(`/tasks/${id}`);
    const block = page.getByRole('region', { name: 'Jira connection needed' });
    await expect(block.getByRole('radio')).toHaveCount(1);
    await block.getByRole('radio').check();
    await page.screenshot({ path: `${SHOTS}/task-connect-picker.png`, fullPage: true });
    await block.getByRole('button', { name: 'Use selected connection' }).click();

    await expect(block).toHaveCount(0);
    await expect.poll(() => outcomeOf(id)).toBe('bound');
});
