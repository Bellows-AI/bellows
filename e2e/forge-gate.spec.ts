import { expect, test } from '@playwright/test';
import postgres from 'postgres';
import { AUTH_DATABASE_URL, E2E_LOGIN } from '../playwright.config.js';
import { clearExecutors, saveExecutor } from './executor.js';
import { revokeGitHubAuthorization } from './forge-grant.js';
import { throughSignIn } from './signin.js';

/**
 * The forge start gate in a real browser (docs/connections.md): a member whose GitHub grant broke is refused at the
 * start form with a Connect GitHub link, and the link is the silent sign-in that makes the next start work; a queued
 * task held on the grant says so on its page, offers the starter the reconnect, and the wait clears when the grant is
 * live again.
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

/** A queued task of the signed-in member, waiting on their GitHub grant. */
const seedHeld = () =>
    withSql(async (sql) => {
        const [member] = await sql<{ userId: string; orgId: string }[]>`
            select u.id as "userId", m.org_id as "orgId"
            from app_user u join org_membership m on m.github_login = u.github_login
            where u.github_login = ${E2E_LOGIN} limit 1
        `;
        const id = crypto.randomUUID();
        await sql`
            insert into job (org_id, id, root_job_id, command, status, attempts, created_by, execution_user_id, repo)
            values (${member!.orgId}, ${id}, ${id}, ${`held on github ${id.slice(0, 8)}`}, 'queued', 0,
                    ${member!.userId}, ${member!.userId}, 'e2e-owner/web')
        `;
        await sql`
            insert into job_integration_requirement (org_id, root_job_id, provider, reason, source, target)
            values (${member!.orgId}, ${id}, 'forge', 'reconnect', 'create', 'github')
        `;
        return id;
    });

const openRequirements = (id: string) =>
    withSql((sql) => sql`select 1 from job_integration_requirement where root_job_id = ${id} and satisfied_at is null`);

test.beforeEach(async ({ page }) => {
    await throughSignIn(page);
    // A task cannot start without an executor profile; the board's own create is what the second start reaches.
    await saveExecutor(page);
});

// The tasks this file queued must not show in the sidebar of the specs that follow.
test.afterEach(async ({ page }) => {
    await clearExecutors(page);
    await withSql(
        (sql) => sql`delete from job where command in ('tidy the changelog') or command like 'held on github %'`
    );
});

test('a broken grant is refused at the start form, and the Connect GitHub link makes the next start work', async ({
    page,
}) => {
    await revokeGitHubAuthorization(page);

    await page.goto('/tasks/new');
    const prompt = page.getByLabel('What should the agent do?');
    await prompt.fill('tidy the changelog');
    await page.getByRole('button', { name: 'Start task' }).click();

    const alert = page.locator('.composer').getByRole('alert');
    await expect(alert).toContainText('GitHub connection needs reconnecting');
    await expect(prompt).toHaveValue('tidy the changelog');
    await page.screenshot({ path: `${SHOTS}/forge-gate-start-form.png`, fullPage: true });

    // The link is the sign-in itself: silent for a member who already consented, back on the form, grant live.
    await alert.getByRole('link', { name: 'Connect GitHub' }).click();
    await expect(page).toHaveURL(/\/tasks\/new/);
    await page.getByLabel('What should the agent do?').fill('tidy the changelog');
    await page.getByRole('button', { name: 'Start task' }).click();
    await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]{36}/);
});

test('a task held on the grant says so, offers the starter the reconnect, and the wait clears when it is live', async ({
    page,
}) => {
    await revokeGitHubAuthorization(page);
    const id = await seedHeld();

    await page.goto(`/tasks/${id}`);
    const wait = page.getByRole('region', { name: 'GitHub connection needed' });
    await expect(wait).toContainText('its GitHub connection needs to be reconnected');
    await expect(wait.getByRole('button', { name: 'Continue without it' })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/forge-gate-task-wait.png`, fullPage: true });

    await wait.getByRole('link', { name: 'Reconnect GitHub' }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${id}`));
    await expect(wait).toHaveCount(0);
    await expect.poll(async () => (await openRequirements(id)).length).toBe(0);
});
