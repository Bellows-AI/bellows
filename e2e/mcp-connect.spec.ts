import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { AUTH_PORT } from '../playwright.config.js';
import { throughSignIn } from './signin.js';

/**
 * The whole MCP connect journey (BEL-108) against the auth board with `MCP_ENABLED` on: a real SDK client is
 * refused with the resource-metadata challenge, discovers the authorization server from it, registers itself,
 * is sent to the real consent page where the signed-in member allows it in the browser, exchanges the code, and
 * calls `create_task`, `wait_task` and `read_job_log`. Disconnect on the account page then makes its next call 401.
 *
 * The consent screen's own states are oauth-consent.spec.ts's. No driver runs on this board, so the task it creates
 * stays queued: `wait_task` is asserted to say so within its bounded wait, and `read_job_log` to say there is
 * nothing to read yet. Neither is faked into a settled run.
 */

const SHOTS = 'artifacts/ui';
const BASE = `http://127.0.0.1:${AUTH_PORT}`;
const RESOURCE = new URL(`${BASE}/api/mcp`);
const MODERN = '2026-07-28';
const HTTP_UNAUTHORIZED = 401;
/** A loopback redirect (RFC 8252); the spec fulfils the navigation itself. Not one of Chromium's restricted ports. */
const REDIRECT_PORT = 59174;
const REDIRECT = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const CLIENT_NAME = 'E2E MCP Connect';
const WAIT_SECONDS = 1;
const NARROW_WIDTH = 390;

/** An in-memory OAuth client: what the SDK needs to run discovery, registration, PKCE and the token exchange. */
function memoryProvider(): OAuthClientProvider & { authorizationUrl: URL | undefined } {
    let information: Awaited<ReturnType<NonNullable<OAuthClientProvider['clientInformation']>>>;
    let tokens: Awaited<ReturnType<OAuthClientProvider['tokens']>>;
    let verifier = '';
    let discovery: unknown;
    const provider = {
        authorizationUrl: undefined as URL | undefined,
        redirectUrl: REDIRECT,
        clientMetadata: {
            client_name: CLIENT_NAME,
            redirect_uris: [REDIRECT],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: 'factory:read factory:write',
        },
        state: () => 'e2e-connect-state',
        clientInformation: () => information,
        saveClientInformation: (value: typeof information) => {
            information = value;
        },
        tokens: () => tokens,
        saveTokens: (value: typeof tokens) => {
            tokens = value;
        },
        redirectToAuthorization: (url: URL) => {
            provider.authorizationUrl = url;
        },
        saveDiscoveryState: (value: unknown) => {
            discovery = value;
        },
        discoveryState: () => discovery,
        saveCodeVerifier: (value: string) => {
            verifier = value;
        },
        codeVerifier: () => verifier,
    };
    return provider as OAuthClientProvider & { authorizationUrl: URL | undefined };
}

const transportFor = (provider: OAuthClientProvider) =>
    new StreamableHTTPClientTransport(RESOURCE, { authProvider: provider });

const newClient = () =>
    new Client({ name: 'e2e-connect', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });

/** Shapes the tools answer with: `structuredContent` when the tool has an output schema, else the text. */
const dataOf = (result: { structuredContent?: unknown; content?: unknown }): Record<string, unknown> =>
    (result.structuredContent ?? {}) as Record<string, unknown>;

/** The consent page the SDK's authorization URL leads to: allow it and answer the callback parameters. */
async function approve(page: Page, authorizationUrl: URL): Promise<URLSearchParams> {
    await page.route(`http://127.0.0.1:${REDIRECT_PORT}/**`, (route) => route.fulfill({ status: 200, body: 'ok' }));
    await page.goto(authorizationUrl.toString());
    await expect(page.getByRole('heading', { level: 1, name: 'Connect an app to Bellows' })).toBeVisible();
    await expect(page.getByText(CLIENT_NAME).first()).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/mcp-connect-consent.png`, fullPage: true });
    const navigated = page.waitForURL(new RegExp(`127\\.0\\.0\\.1:${REDIRECT_PORT}/callback`));
    await page.getByRole('button', { name: 'Allow' }).click();
    await navigated;
    return new URL(page.url()).searchParams;
}

/** The grant's Access text wraps instead of overflowing, and Disconnect is on screen with no page scroll. */
async function expectRowFits(page: Page, row: Locator): Promise<void> {
    const access = row.locator('td[data-label="Access"]');
    const overflow = await access.evaluate((cell) => cell.scrollWidth - cell.clientWidth);
    expect(overflow, 'the Access cell does not clip its text').toBeLessThanOrEqual(0);
    const box = await row.getByRole('button', { name: /^Disconnect / }).boundingBox();
    const viewport = page.viewportSize();
    expect(box, 'the Disconnect button is rendered').not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0), 'Disconnect is inside the viewport').toBeLessThanOrEqual(
        viewport?.width ?? 0
    );
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(pageOverflow, 'the page does not scroll sideways').toBeLessThanOrEqual(0);
    const wrap = await page.getByLabel('Connected apps list').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(wrap, 'the table fits its card without its own scroll').toBeLessThanOrEqual(0);
}

test.beforeEach(async ({ page }) => {
    await throughSignIn(page);
});

test('an SDK client is challenged, connects through the consent page, runs the task tools, and is cut off on Disconnect', async ({
    page,
}) => {
    // 1. Unauthenticated: the challenge names the protected-resource metadata the client discovers from.
    const challenge = await fetch(RESOURCE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(challenge.status).toBe(HTTP_UNAUTHORIZED);
    expect(challenge.headers.get('www-authenticate')).toMatch(/resource_metadata="[^"]+oauth-protected-resource/);

    // 2. The SDK discovers, registers and builds the authorization request; the browser takes it from there.
    const provider = memoryProvider();
    await expect(newClient().connect(transportFor(provider))).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.authorizationUrl, 'the SDK reached the authorization step').toBeDefined();
    const authorizationUrl = provider.authorizationUrl as URL;
    expect(authorizationUrl.pathname).toBe('/api/oauth/authorize');
    expect(authorizationUrl.searchParams.get('resource')).toBe(RESOURCE.toString());

    // 3. The member allows it; the SDK exchanges the code and reconnects with the token.
    const callback = await approve(page, authorizationUrl);
    expect(callback.get('state')).toBe('e2e-connect-state');
    const transport = transportFor(provider);
    await transport.finishAuth(callback);
    const mcp = newClient();
    await mcp.connect(transportFor(provider));

    // 4. The task tools.
    const repos = dataOf(await mcp.callTool({ name: 'list_repos', arguments: {} }));
    const repo = (repos.repos as { repo: string }[])[0]?.repo;
    expect(repo, 'the seeded stored repository is visible to the member').toBeDefined();

    const createdResult = await mcp.callTool({
        name: 'create_task',
        arguments: { command: 'Say hello from the e2e connect journey.', repo },
    });
    expect(createdResult.isError, JSON.stringify(createdResult.content)).toBeFalsy();
    const taskId = dataOf(createdResult).id as string;
    expect(taskId).toMatch(/^[0-9a-f-]{36}$/);

    // No driver claims the task here, so the bounded wait ends on its budget instead of a settlement.
    const waited = await mcp.callTool({ name: 'wait_task', arguments: { taskId, budgetSeconds: WAIT_SECONDS } });
    expect(waited.isError).toBeFalsy();
    expect(dataOf(waited).result).toBe('timeout');

    const log = await mcp.callTool({ name: 'read_job_log', arguments: { jobId: taskId } });
    expect(log.isError).toBeFalsy();
    expect(dataOf(log).complete).toBe(false);
    await mcp.close();

    // 5. Disconnect on the account page, then the same token is refused.
    await page.goto('/account');
    const row = page.getByRole('row', { name: new RegExp(CLIENT_NAME) });
    await expect(row).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/mcp-connect-connected-apps.png`, fullPage: true });
    await expectRowFits(page, row);
    await page.setViewportSize({ width: NARROW_WIDTH, height: 800 });
    await expect(row).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/mcp-connect-connected-apps-narrow.png`, fullPage: true });
    await expectRowFits(page, row);
    await page.setViewportSize({ width: 1280, height: 720 });
    await row.getByRole('button', { name: `Disconnect ${CLIENT_NAME}` }).click();
    const revoked = page.waitForResponse((r) => r.url().includes('/revoke') && r.request().method() === 'POST');
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
    expect((await revoked).status()).toBe(200);
    await expect(page.getByRole('row', { name: new RegExp(CLIENT_NAME) })).toHaveCount(0);

    const token = (await provider.tokens())?.access_token ?? '';
    const after = await fetch(RESOURCE, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'whoami', arguments: {} },
        }),
    });
    expect(after.status, await after.text()).toBe(HTTP_UNAUTHORIZED);
});

/** Names the missing capability, not a ticket: nothing in the board yet parks a task on a missing integration. */
const INTEGRATION_SKIP =
    'the board has no durable integration-requirement flow (a typed blocked interaction, a safe browser link, resume after connect) to drive end to end';

test('a task created without a connected integration parks with a typed blocked interaction and resumes after the member connects it', () => {
    console.log(`mcp-connect: skipped — ${INTEGRATION_SKIP}`);
    // biome-ignore lint/suspicious/noSkippedTests: the scenario needs a board capability that does not exist yet; the reason is printed above.
    test.skip(true, INTEGRATION_SKIP);
});
