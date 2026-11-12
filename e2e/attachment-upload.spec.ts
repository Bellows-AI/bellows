import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { AUTH_PORT } from '../playwright.config.js';
import { throughSignIn } from './signin.js';

/**
 * The browser upload page an MCP client hands out (docs/mcp.md): `<origin>/attachments/upload#fcu_…`. The
 * link is minted through the server as a signed-in member, then opened in a fresh, signed-out browser context: the
 * capability in the fragment is the only credential. The page's states are web/test/AttachmentUploadPage.dom.test.tsx's.
 *
 * On the `auth` project: minting needs a member; the upload deliberately does not.
 */

const SHOTS = 'artifacts/ui';
const BASE = `http://127.0.0.1:${AUTH_PORT}`;
const HTTP_CREATED = 201;
/** A valid 1x1 PNG: the sniffed type must agree with the bytes. */
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
);

/** Different bytes: identical bytes replay the stored file (201) by contract, so only these prove the link is spent. */
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([0])]);

async function mint(page: Page): Promise<string> {
    const response = await page.request.post('/api/attachments/upload-requests', { data: {} });
    expect(response.status(), await response.text()).toBe(HTTP_CREATED);
    const { pageUrl } = (await response.json()) as { pageUrl: string };
    expect(new URL(pageUrl).hash).toMatch(/^#fcu_/);
    return pageUrl;
}

/** A browser with no cookies: the page must stand on the link alone. */
async function signedOut(browser: Browser) {
    const context = await browser.newContext({ baseURL: BASE });
    return { context, page: await context.newPage() };
}

test('a signed-out browser uploads one file through the link, sees its id, and the link is then spent', async ({
    page,
    browser,
}) => {
    await throughSignIn(page);
    const pageUrl = await mint(page);

    const guest = await signedOut(browser);
    const referers: string[] = [];
    guest.page.on('request', (r) => {
        const referer = r.headers().referer;
        if (referer) referers.push(referer);
    });
    await guest.page.goto(pageUrl);
    await expect(guest.page.getByRole('heading', { level: 1, name: 'Upload a file to Bellows' })).toBeVisible();
    // The capability is read once and then dropped from the address bar.
    await expect.poll(() => new URL(guest.page.url()).hash).toBe('');
    await guest.page.screenshot({ path: `${SHOTS}/attachment-upload-choose.png`, fullPage: true });

    const put = guest.page.waitForResponse((r) => r.url().includes('/api/attachments/uploads/'));
    await guest.page
        .getByTestId('upload-input')
        .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
    expect((await put).status()).toBe(HTTP_CREATED);
    await expect(guest.page.getByText(/return to your app/i)).toBeVisible();
    const id = (await guest.page.locator('code').innerText()).trim();
    expect(id).not.toBe('');
    await guest.page.screenshot({ path: `${SHOTS}/attachment-upload-done.png`, fullPage: true });

    // The member's side sees the stored file under that id.
    const stored = await page.request.get(`/api/attachments/${id}`);
    expect(stored.status()).toBe(200);
    expect(referers.filter((r) => r.includes('fcu_'))).toEqual([]);

    // The link takes one file: the same page, a second time, says it was used.
    // A fresh page: a fragment-only goto on the open page would be a same-document navigation, not a reload.
    const again = await guest.context.newPage();
    await again.goto(pageUrl);
    await again
        .getByTestId('upload-input')
        .setInputFiles({ name: 'again.png', mimeType: 'image/png', buffer: OTHER_PNG });
    await expect(again.getByRole('alert')).toContainText(/already used/);
    await again.screenshot({ path: `${SHOTS}/attachment-upload-spent.png`, fullPage: true });
    await guest.context.close();
});

test('a link the board does not know says so and takes nothing', async ({ browser }) => {
    const guest = await signedOut(browser);
    await guest.page.goto(`/attachments/upload#fcu_${'z'.repeat(43)}`);
    await guest.page
        .getByTestId('upload-input')
        .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: PNG });
    await expect(guest.page.getByRole('alert')).toContainText(/not valid/);
    await expect(guest.page.getByTestId('upload-input')).toHaveCount(0);
    await guest.page.screenshot({ path: `${SHOTS}/attachment-upload-invalid.png`, fullPage: true });
    await guest.context.close();
});

test('the page cannot be framed', async ({ request }) => {
    const response = await request.get(`${BASE}/attachments/upload`);
    expect(response.status()).toBe(200);
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
});
