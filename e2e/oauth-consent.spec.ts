import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { AUTH_PORT } from '../playwright.config.js';
import { expectRowFits } from './connected-apps.js';
import { throughSignIn } from './signin.js';

/**
 * The MCP consent screen and the connected-apps panel, in a real browser against the auth board with
 * `MCP_ENABLED` on (playwright.config.ts): a dynamically registered client runs the authorize round trip, the member
 * allows or denies on `/oauth/consent`, and Disconnect on the account page makes the next MCP call 401.
 *
 * On the `auth` project: the authorize endpoint needs the signed-in member's cookie. The screen's states and the
 * panel's refusals are web/test/OAuthConsent.dom.test.tsx's and ConnectedAppsPanel.dom.test.tsx's.
 */

const SHOTS = 'artifacts/ui';
const BASE = `http://127.0.0.1:${AUTH_PORT}`;
const RESOURCE = `${BASE}/api/mcp`;
/** A loopback redirect (RFC 8252): nothing listens here; the spec answers the navigation itself. */
/** Not Chromium's restricted ports (port 9 is on that list and the navigation would fail unsafe-port). */
const REDIRECT_PORT = 59173;
const REDIRECT = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const MODERN = '2026-07-28';
const HTTP_UNAUTHORIZED = 401;

const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** Registers a client the way an MCP SDK would (RFC 7591) and answers its generated id. */
async function register(page: Page, name: string): Promise<string> {
    const response = await page.request.post('/api/oauth/register', {
        data: { client_name: name, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
    });
    expect(response.status()).toBe(201);
    return ((await response.json()) as { client_id: string }).client_id;
}

/** Opens an authorization request as the signed-in member; the browser ends on the consent screen. Answers the consent URL the redirect carried. */
async function authorize(page: Page, clientId: string, challenge: string): Promise<string> {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'factory:read',
        state: 'e2e-state',
        resource: RESOURCE,
    });
    const redirected = page.waitForResponse((r) => r.url().includes('/api/oauth/authorize'));
    await page.goto(`/api/oauth/authorize?${params.toString()}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Connect an app to Bellows' })).toBeVisible();
    const location = (await redirected).headers().location ?? '';
    expect(location).toContain('#id=');
    // The transaction is read once and then dropped from the address bar.
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    return new URL(location, BASE).toString();
}

/** The redirect the page navigates to after a decision; nothing listens there, so the spec fulfils it. */
async function captureRedirect(page: Page, decide: () => Promise<void>): Promise<URL> {
    await page.route(`http://127.0.0.1:${REDIRECT_PORT}/**`, (route) => route.fulfill({ status: 200, body: 'ok' }));
    const navigated = page.waitForURL(new RegExp(`127\\.0\\.0\\.1:${REDIRECT_PORT}/callback`));
    await decide();
    await navigated;
    return new URL(page.url());
}

test.beforeEach(async ({ page }) => {
    await throughSignIn(page);
});

test('the consent page cannot be framed', async ({ page }) => {
    const response = await page.request.get('/oauth/consent');
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});

test('Allow returns a code, the connected app lists, and Disconnect makes the next MCP call 401', async ({
    page,
    request,
}) => {
    // One unbroken token as well: a registered name need not have spaces to wrap at.
    const name = `E2E Planner ${Date.now()} planner-for-a-registered-client-with-no-spaces-anywhere-x`;
    const { verifier, challenge } = pkce();
    const clientId = await register(page, name);
    await authorize(page, clientId, challenge);

    await expect(page.getByText(name).first()).toBeVisible();
    await expect(page.getByText(/unverified/i)).toBeVisible();
    await expect(page.getByText(`127.0.0.1:${REDIRECT_PORT}`)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/oauth-consent.png`, fullPage: true });

    const back = await captureRedirect(page, () => page.getByRole('button', { name: 'Allow' }).click());
    expect(back.searchParams.get('state')).toBe('e2e-state');
    expect(back.searchParams.get('iss')).toBe(BASE);
    const code = back.searchParams.get('code') ?? '';
    expect(code).not.toBe('');

    const token = await request.post(`${BASE}/api/oauth/token`, {
        form: {
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            redirect_uri: REDIRECT,
            code_verifier: verifier,
            resource: RESOURCE,
        },
    });
    expect(token.status()).toBe(200);
    const { access_token: accessToken } = (await token.json()) as { access_token: string };

    const mcp = new Client({ name: 'e2e', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await mcp.connect(
        new StreamableHTTPClientTransport(new URL(RESOURCE), {
            requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
        })
    );
    expect((await mcp.callTool({ name: 'whoami', arguments: {} })).isError).toBeFalsy();
    await mcp.close();

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/account');
    const row = page.getByRole('row', { name: new RegExp(name) });
    await expect(row).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/account-connected-apps.png`, fullPage: true });
    await expectRowFits(page, row);
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(row).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/account-connected-apps-narrow.png`, fullPage: true });
    await expectRowFits(page, row);
    await page.setViewportSize({ width: 1280, height: 720 });
    await row.getByRole('button', { name: `Disconnect ${name}` }).click();
    const revoked = page.waitForResponse((r) => r.url().includes('/revoke') && r.request().method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
    expect((await revoked).status()).toBe(200);
    await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);

    const after = await fetch(RESOURCE, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'whoami', arguments: {} },
        }),
    });
    expect(after.status, await after.text()).toBe(HTTP_UNAUTHORIZED);
});

test('Deny returns access_denied with the state, no code, and connects nothing', async ({ page }) => {
    const name = `E2E Denied ${Date.now()}`;
    const clientId = await register(page, name);
    await authorize(page, clientId, pkce().challenge);

    const back = await captureRedirect(page, () => page.getByRole('button', { name: 'Deny' }).click());
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('e2e-state');
    expect(back.searchParams.get('iss')).toBe(BASE);
    expect(back.searchParams.has('code')).toBe(false);

    await page.goto('/account');
    await expect(page.getByRole('heading', { name: 'Connected apps' })).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);
});

test('a spent request says it is no longer valid and offers no Allow', async ({ page }) => {
    const clientId = await register(page, `E2E Spent ${Date.now()}`);
    const consentUrl = await authorize(page, clientId, pkce().challenge);
    await captureRedirect(page, () => page.getByRole('button', { name: 'Deny' }).click());

    await page.goto(consentUrl);
    await expect(page.getByRole('alert')).toContainText('no longer valid');
    await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
});
