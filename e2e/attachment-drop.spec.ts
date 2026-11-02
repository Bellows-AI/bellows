import { expect, test } from '@playwright/test';
import { stubAttachments } from './fixtures/attachments.js';
import { dragFiles, gradientPng } from './fixtures/files.js';
import { authoredBy, failedGateThread, routeThread, sessionAuthor } from './fixtures/threads.js';
import { watchConsole } from './page-health.js';

const SHOTS = 'artifacts/ui';

test.describe('files on the task page', () => {
    test('a drop anywhere on the conversation attaches to the follow-up; the overlay shows while dragging', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        const me = await sessionAuthor(page);
        await stubAttachments(page);
        await routeThread(page, authoredBy(failedGateThread, me));
        await page.goto(`/tasks/${failedGateThread[0]!.id}`);
        const conversation = page.locator('.task-conversation');
        const overlay = page.getByText('Drop files to attach');
        await expect(page.getByLabel('Ask for a follow-up')).toBeVisible();

        await dragFiles(conversation, 'dragenter', ['convo.txt']);
        await expect(overlay).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/task-detail-drop-overlay.png`, fullPage: true });
        await dragFiles(conversation, 'drop', ['convo.txt']);
        await expect(page.getByRole('list', { name: 'Attached files' }).getByText('convo.txt')).toBeVisible();
        await expect(overlay).toHaveCount(0);
        expect(problems.join('\n')).toBe('');
    });

    test('the history lists a request’s image and file as tiles, in both themes', async ({ page }) => {
        const me = await sessionAuthor(page);
        const png = gradientPng();
        const meta = (id: string, name: string, mediaType: string, size: number) => ({
            id,
            name,
            mediaType,
            size,
            sha256: 'ab',
            state: 'bound' as const,
        });
        const thread = authoredBy(failedGateThread, me).map((j, i) => ({
            ...j,
            attachments:
                i === 0
                    ? [
                          meta('00000000-0000-4000-8000-0000000000c1', 'shot.png', 'image/png', png.length),
                          meta(
                              '00000000-0000-4000-8000-0000000000c2',
                              'a-rather-long-notes-file.txt',
                              'text/plain',
                              24
                          ),
                      ]
                    : [],
        }));
        await routeThread(page, thread);
        await page.route('**/api/attachments/*/content*', (route) =>
            route.fulfill({ status: 200, body: png, headers: { 'content-type': 'image/png' } })
        );
        await page.goto(`/tasks/${thread[0]!.id}`);
        const files = page.getByRole('list', { name: 'Files on this request' }).first();
        await expect(files.getByText('a-rather-long-notes-file.txt')).toBeVisible();
        await expect
            .poll(() => files.locator('img.attachment-preview').evaluate((i: HTMLImageElement) => i.naturalWidth))
            .toBeGreaterThan(0);
        // Tiles sit side by side in one wrapping row, not stacked full-width rows.
        const boxes = await files
            .locator('.attachment-chip')
            .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
        expect(new Set(boxes).size).toBe(1);
        await expect(files.getByRole('link', { name: 'Download shot.png' })).toBeVisible();
        for (const theme of ['light', 'dark']) {
            await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
            await page.screenshot({ path: `${SHOTS}/task-detail-attachment-tiles_${theme}.png`, fullPage: true });
        }
        await page.evaluate(() => document.documentElement.removeAttribute('data-theme'));
    });
});
