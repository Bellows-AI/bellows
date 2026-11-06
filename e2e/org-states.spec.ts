import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ADMIN_ROLE, type Role } from '@factory-ai/core';
import { MEMBER_NOTE, NO_SUBSCRIPTIONS_NOTE } from '../web/src/panels/NotificationSubscriptionsPanel.js';
import { FORBIDDEN, useTheme, watchConsole } from './page-health.js';
import { controlsOutsideViewport, noHorizontalOverflow } from './viewport.js';

/**
 * The Organization page's states as the DOM reports them, at desktop and phone width in both themes
 * (no screenshots, no baselines): the admin view with a roster, notifications, long names and a Core
 * editor holding a stored secret, and the member view with an empty notification list. The board's
 * session, roster, notification list and env read are served by `page.route`, because the open
 * board has no role to switch; every id and name below is minted here, none is a real one.
 *
 * The roster, notification and env code paths are web/test/members.dom.test.tsx,
 * notification-subscriptions.dom.test.tsx and env.dom.test.tsx's; this spec owns what only a real
 * browser shows: no page-level horizontal overflow, no control past the viewport, the named controls
 * present or absent by role, and the secret never in the page.
 */

const WIDTHS = [1440, 390] as const;
const THEMES = ['dark', 'light'] as const;

const UNBROKEN = 'segment'.repeat(12);
const LONG_ORG = `Long Organization Name ${UNBROKEN}`;
const LONG_LOGIN = `member-${UNBROKEN}`;
const SECRET_NAME = 'E2E_ORG_STATE_SECRET';
const VARIABLE_NAME = 'E2E_ORG_STATE_VARIABLE';
const VARIABLE_VALUE = 'plain-visible-value';
const STAMP = '2026-01-01T00:00:00.000Z';

function session(role: Role) {
    return {
        authenticated: true,
        user: { id: 'u-self', login: LONG_LOGIN, name: null, githubUserId: 4242, avatarUrl: null },
        role,
        membership: { invitedAt: STAMP, claimedAt: STAMP },
        account: { createdAt: STAMP, lastLoginAt: STAMP },
        organization: { id: 'org-e2e', name: LONG_ORG },
        organizations: [{ id: 'org-e2e', name: LONG_ORG }],
        mode: 'github',
        mcp: false,
        batches: false,
    };
}

const subscription = {
    id: 'sub-e2e',
    connectorKind: 'discord',
    connectorConfig: {},
    eventKinds: ['task.ready', 'task.blocked', 'task.question'],
    repos: [`org-${UNBROKEN}/repo-${UNBROKEN}`],
    enabled: true,
    createdAt: STAMP,
    updatedAt: STAMP,
};

async function serveOrg(page: Page, role: Role, subscriptions: object[]) {
    const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('**/api/auth/me', (route) => route.fulfill(json(session(role))));
    await page.route('**/api/org/members', (route) =>
        route.fulfill(
            json({
                members: [
                    {
                        githubLogin: LONG_LOGIN,
                        userId: 'u-self',
                        role,
                        invitedAt: STAMP,
                        claimedAt: STAMP,
                        lastLoginAt: STAMP,
                    },
                    {
                        githubLogin: 'teammate',
                        userId: 'u-mate',
                        role: 'member',
                        invitedAt: null,
                        claimedAt: null,
                        lastLoginAt: null,
                    },
                ],
            })
        )
    );
    await page.route('**/api/org/notification-subscriptions', (route) =>
        route.request().method() === 'GET'
            ? route.fulfill(json({ subscriptions, connectorKinds: ['discord'] }))
            : route.continue()
    );
    await page.route('**/api/env', (route) =>
        route.request().method() === 'GET'
            ? route.fulfill(
                  json({
                      org: [
                          { name: VARIABLE_NAME, value: VARIABLE_VALUE, isSecret: false, updatedAt: STAMP },
                          { name: SECRET_NAME, value: null, isSecret: true, updatedAt: STAMP },
                      ],
                      workspace: [],
                      repos: [],
                  })
              )
            : route.continue()
    );
}

async function assertFits(page: Page, width: number) {
    await noHorizontalOverflow(page);
    expect(await controlsOutsideViewport(page, width), 'controls past the viewport').toEqual([]);
    const text = await page.locator('main').innerText();
    for (const token of FORBIDDEN) expect(text, `page contains ${token}`).not.toContain(token);
}

for (const width of WIDTHS) {
    for (const theme of THEMES) {
        test.describe(`organization page, ${width}px, ${theme}`, () => {
            test.beforeEach(async ({ page }) => {
                await page.setViewportSize({ width, height: 900 });
                await useTheme(page, theme);
            });

            test('admin view: roster, populated notifications, long names, masked secret', async ({ page }) => {
                const problems = watchConsole(page);
                await serveOrg(page, ADMIN_ROLE, [subscription]);
                await page.goto('/settings/organization');

                const identity = page.locator('.org-identity');
                await expect(identity).toContainText(LONG_ORG);
                await expect(identity.locator('.pill')).toHaveText('Admin');

                const roster = page.getByRole('region', { name: 'Organization members' });
                await expect(roster).toBeVisible();
                await expect(roster.getByRole('combobox', { name: `Role for ${LONG_LOGIN}` })).toBeEnabled();
                await expect(roster.getByRole('combobox', { name: 'Role for teammate' })).toBeEnabled();

                const notifications = page.getByRole('region', { name: 'Organization notifications' });
                await expect(notifications.getByRole('button', { name: 'Add notification' })).toBeVisible();
                await expect(
                    notifications.getByRole('table', { name: 'Organization notification subscriptions' })
                ).toBeVisible();
                await expect(notifications.getByText(MEMBER_NOTE)).toHaveCount(0);

                const editor = page.locator('section.env-editor', {
                    has: page.getByRole('heading', { name: 'Organization variables' }),
                });
                // The variable's value reads in its row; the secret's never does.
                await expect(editor.getByText(VARIABLE_VALUE)).toBeVisible();
                await editor.getByRole('tab', { name: /^Secrets/ }).click();
                await expect(editor.getByText('Set', { exact: true })).toBeVisible();
                await editor.getByRole('button', { name: `Edit ${SECRET_NAME}` }).click();
                const secretValue = editor.getByLabel('Secret new value');
                await expect(secretValue).toHaveAttribute('type', 'password');
                await expect(secretValue).toHaveValue('');
                await assertFits(page, width);
                await page.keyboard.press('Escape');
                await expect(secretValue).toBeHidden();

                await assertFits(page, width);
                expect(problems).toEqual([]);
            });

            test('member view: no roster, read-only empty notifications', async ({ page }) => {
                const problems = watchConsole(page);
                let rosterReads = 0;
                page.on('request', (request) => {
                    if (request.url().endsWith('/api/org/members')) rosterReads += 1;
                });
                await serveOrg(page, 'member', []);
                await page.goto('/settings/organization');

                const identity = page.locator('.org-identity');
                await expect(identity).toContainText(LONG_ORG);
                await expect(identity.locator('.pill')).toHaveText('Member');

                await expect(page.getByText(/Member roles are managed by your organization/)).toBeVisible();
                await expect(page.getByRole('region', { name: 'Organization members' })).toHaveCount(0);

                const notifications = page.getByRole('region', { name: 'Organization notifications' });
                await expect(notifications.getByText(MEMBER_NOTE)).toBeVisible();
                await expect(notifications.getByText(NO_SUBSCRIPTIONS_NOTE)).toBeVisible();
                await expect(notifications.getByRole('button', { name: 'Add notification' })).toHaveCount(0);
                await expect(page.getByRole('heading', { name: 'Organization variables' })).toBeVisible();

                await assertFits(page, width);
                expect(rosterReads, 'a member never reads the roster').toBe(0);
                expect(problems).toEqual([]);
            });
        });
    }
}
