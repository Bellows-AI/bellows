import { readFileSync } from 'node:fs';
import { ADMIN_ROLE, MEMBER_ROLE } from '@factory-ai/core';
import { expect, type Page, test } from '@playwright/test';
import postgres from 'postgres';
import {
    AUTH_DATABASE_URL,
    AUTH_PORT,
    E2E_LOGIN,
    GITLAB_CA_PATH,
    GITLAB_CONTROL_PORT,
    GITLAB_PORT,
} from '../playwright.config.js';
import { clearExecutors, contextChip, saveExecutor } from './executor.js';
import { setRole } from './roles.js';
import { throughSignIn } from './signin.js';

/**
 * Settings → Integrations → GitLab against the stub GitLab (e2e/stub-gitlab.mjs, the lanes' fake behind TLS): an admin
 * connects the instance with its CA bundle and activates it through the instance's own consent, picks the tracked
 * projects; a member links and reconnects their account; a start below Developer access is refused with the page's
 * link; a GitLab grant lost mid-run shows as a paused task (docs/gitlab.md). One serial story on one database.
 */

test.use({ ignoreHTTPSErrors: true });
test.describe.configure({ mode: 'serial' });

const SHOTS = 'artifacts/ui';
const HOST = `127.0.0.1:${GITLAB_PORT}`;
const PAGE = '/settings/integrations/gitlab';
const GROUP = 'e2e-group';
const TRACKED = `${GROUP}/web`;
const OTHER = `${GROUP}/api`;
const CLIENT = { clientId: 'e2e-gitlab-app', clientSecret: 'e2e-gitlab-secret' };
/** The member the fake signs every consent in as. */
const FAKE_LOGIN = 'lane-member';
const REPORTER = 20;

const control = async (path: string, body: object) => {
    const response = await fetch(`http://127.0.0.1:${GITLAB_CONTROL_PORT}/_control/gitlab/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(response.status, `fake GitLab ${path}`).toBe(200);
};

async function withSql<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(AUTH_DATABASE_URL, { max: 1 });
    try {
        return await run(sql);
    } finally {
        await sql.end();
    }
}

const memberOf = (sql: postgres.Sql) =>
    sql<{ userId: string; orgId: string }[]>`
        select u.id as "userId", m.org_id as "orgId"
        from app_user u join org_membership m on m.github_login = u.github_login
        where u.github_login = ${E2E_LOGIN} limit 1
    `;

/** Ends the member's GitLab grant the way a revocation does (`missing`), or wedges it (`broken`: needs reconnect). */
const spoilGrant = (how: 'missing' | 'broken') =>
    withSql(async (sql) => {
        const [member] = await memberOf(sql);
        if (how === 'missing') {
            await sql`update integration_grant set status = 'revoked'
                      where org_id = ${member!.orgId} and principal_user_id = ${member!.userId} and provider = ${`gitlab:${HOST}`}`;
        } else {
            await sql`update integration_grant set secret_wedged_at = now()
                      where org_id = ${member!.orgId} and principal_user_id = ${member!.userId} and provider = ${`gitlab:${HOST}`}`;
        }
    });

const account = (page: Page) => page.getByRole('region', { name: `Your account on ${HOST}` });
const instance = (page: Page) => page.getByRole('region', { name: HOST, exact: true });

test.beforeAll(async () => {
    await control('oauth-clients', {
        ...CLIENT,
        redirectUris: [`http://127.0.0.1:${AUTH_PORT}/api/forge-grants/gitlab/callback`],
    });
    await control('projects', { path: TRACKED });
    await control('projects', { path: OTHER });
});

test('an admin connects the instance, activates it with their own consent and tracks a project', async ({ page }) => {
    await throughSignIn(page);
    await setRole(ADMIN_ROLE);
    await page.goto(PAGE);

    await page.getByLabel('GitLab host').fill(HOST);
    await page.getByLabel('OAuth application ID').fill(CLIENT.clientId);
    await page.getByLabel('OAuth application secret').fill(CLIENT.clientSecret);
    await page.getByLabel('Allowed root groups').fill(GROUP);
    await page.getByLabel('CA bundle (optional)').fill(readFileSync(GITLAB_CA_PATH, 'utf8'));
    await page.getByRole('button', { name: 'Connect GitLab' }).click();

    await expect(instance(page).getByText('Pending')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/gitlab-pending.png`, fullPage: true });

    // The consent happens on the instance; its callback lands back here with the outcome.
    await instance(page).getByRole('button', { name: 'Activate' }).click();
    await expect(page.getByText('GitLab connection activated.')).toBeVisible();
    await expect(instance(page).getByText('Active')).toBeVisible();

    await instance(page).getByRole('button', { name: 'Load projects' }).click();
    await expect(page.getByRole('checkbox', { name: OTHER })).toBeVisible();
    await page.getByRole('checkbox', { name: TRACKED }).check();
    await page.getByRole('button', { name: 'Save tracked projects' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/gitlab-tracking.png`, fullPage: true });
});

test('a member links their account and reconnects it once the grant broke', async ({ page }) => {
    await throughSignIn(page);
    await setRole(MEMBER_ROLE);
    await spoilGrant('missing');
    await page.goto(PAGE);

    await expect(page.getByLabel('GitLab host')).toHaveCount(0);
    await expect(account(page).getByText('Not linked')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/gitlab-member-unlinked.png`, fullPage: true });
    await account(page).getByRole('button', { name: 'Link GitLab account' }).click();
    await expect(page.getByText('GitLab account linked.')).toBeVisible();
    await expect(account(page).getByText('Linked')).toBeVisible();

    // A live grant offers no unlink, only the same link flow, which replaces it.
    await expect(account(page).getByRole('button', { name: /unlink|disconnect/i })).toHaveCount(0);
    await page.screenshot({ path: `${SHOTS}/gitlab-member-linked.png`, fullPage: true });
    await account(page).getByRole('button', { name: 'Link a different account' }).click();
    await expect(page.getByText('GitLab account linked.')).toBeVisible();
    await expect(account(page).getByText('Linked')).toBeVisible();

    await spoilGrant('broken');
    await page.reload();
    await expect(account(page).getByText('Needs reconnect')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/gitlab-member-reconnect.png`, fullPage: true });
    await account(page).getByRole('button', { name: 'Reconnect GitLab account' }).click();
    await expect(page.getByText('GitLab account linked.')).toBeVisible();
    await expect(account(page).getByText('Linked')).toBeVisible();
});

test('a start below Developer access is refused with a link to the GitLab settings', async ({ page }) => {
    await throughSignIn(page);
    await setRole(MEMBER_ROLE);
    await saveExecutor(page);
    await control('members', { project: TRACKED, login: FAKE_LOGIN, projectAccess: REPORTER });

    await page.goto('/tasks/new');
    await contextChip(page, 'Repository').click();
    await page.getByRole('option', { name: new RegExp(TRACKED) }).click();
    await page.getByLabel('What should the agent do?').fill('tidy the changelog');
    await page.getByRole('button', { name: 'Start task' }).click();

    const alert = page.locator('.composer').getByRole('alert');
    await expect(alert).toContainText(`does not have Developer access to ${TRACKED}`);
    await expect(alert).toContainText('link a different account');
    await page.screenshot({ path: `${SHOTS}/gitlab-access-denied.png`, fullPage: true });
    await alert.getByRole('link', { name: 'Open GitLab settings' }).click();
    await expect(page).toHaveURL(new RegExp(`${PAGE}`));
    await clearExecutors(page);
});

test('a task paused on a lost GitLab grant offers the reconnect', async ({ page }) => {
    await throughSignIn(page);
    await setRole(MEMBER_ROLE);
    const id = await withSql(async (sql) => {
        const [member] = await memberOf(sql);
        const jobId = crypto.randomUUID();
        await sql`
            insert into job (org_id, id, root_job_id, command, status, attempts, created_by, execution_user_id, repo, forge, host)
            values (${member!.orgId}, ${jobId}, ${jobId}, ${`paused on gitlab ${jobId.slice(0, 8)}`}, 'queued', 1,
                    ${member!.userId}, ${member!.userId}, ${TRACKED}, 'gitlab', ${HOST})
        `;
        await sql`
            insert into job_integration_requirement (org_id, root_job_id, provider, reason, source, target, asked_job_id)
            values (${member!.orgId}, ${jobId}, 'forge', 'reconnect', 'runtime', ${`gitlab:${HOST}`}, ${jobId})
        `;
        return jobId;
    });
    try {
        await page.goto(`/tasks/${id}`);
        const wait = page.getByRole('region', { name: /GitLab .* connection needed/ });
        await expect(wait).toContainText('This task is paused');
        await page.screenshot({ path: `${SHOTS}/gitlab-task-paused.png`, fullPage: true });
        await wait.getByRole('link', { name: /Reconnect GitLab/ }).click();
        await expect(page).toHaveURL(new RegExp(PAGE));
    } finally {
        await withSql((sql) => sql`delete from job where id = ${id}`);
    }
});
