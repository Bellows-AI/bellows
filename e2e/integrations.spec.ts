import { expect, test } from '@playwright/test';

/**
 * The Integrations pages for the local caller on the open board (AUTH_MODE=none): the overview answers
 * with an actionable empty state, and the catalog says Jira is not configured on a board that has no
 * Atlassian application, offering no Connect. The connect flow itself is jira-connections.spec.ts's.
 */

test('the overview is empty and points at Browse integrations', async ({ page }) => {
    await page.goto('/settings/integrations');
    await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
    await expect(page.getByText('No integrations connected yet.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse integrations' }).first()).toBeVisible();
});

test('the catalog says Jira is not configured here and offers no Connect', async ({ page }) => {
    await page.goto('/settings/integrations/available');
    const jira = page.getByRole('listitem', { name: 'Jira' });
    await expect(jira.getByText('Not configured on this deployment')).toBeVisible();
    await expect(jira.getByRole('button', { name: /Connect/ })).toHaveCount(0);
    await expect(page.getByRole('listitem', { name: 'Slack' }).getByText('Planned')).toBeVisible();
});
