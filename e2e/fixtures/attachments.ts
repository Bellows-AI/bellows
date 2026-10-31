import type { Page } from '@playwright/test';

/**
 * The board's attachment routes, answered in the page: the composer only offers files when
 * `GET /api/attachments/limits` answers, and an open e2e board has no object storage.
 * `failFirst` names files whose first upload is refused with a 503, so a spec can retry them.
 */
export interface StubbedAttachments {
    /** The display names uploaded, in order, one entry per request. */
    uploads: string[];
    /** The completed id the stub handed each name (its latest upload). */
    ids: Map<string, string>;
}

const LIMITS = {
    maxFilesPerRequest: 10,
    maxFileBytes: 20 * 1024 * 1024,
    maxRequestBytes: 50 * 1024 * 1024,
    maxImageSide: 16384,
    maxImagePixels: 64_000_000,
    formats: [
        { mediaType: 'image/png', extensions: ['.png'], kind: 'image' },
        { mediaType: 'text/plain', extensions: ['.txt'], kind: 'text' },
    ],
};

export async function stubAttachments(
    page: Page,
    options: { failFirst?: readonly string[] } = {}
): Promise<StubbedAttachments> {
    const seen: StubbedAttachments = { uploads: [], ids: new Map() };
    const failed = new Set<string>();
    await page.route('**/api/attachments/limits', (route) => route.fulfill({ json: LIMITS }));
    await page.route('**/api/attachments', (route) => {
        const request = route.request();
        if (request.method() !== 'POST') return route.fallback();
        const name = decodeURIComponent(request.headers()['x-attachment-name'] ?? '');
        seen.uploads.push(name);
        if ((options.failFirst ?? []).includes(name) && !failed.has(name)) {
            failed.add(name);
            return route.fulfill({
                status: 503,
                json: { error: 'Storage is busy, try again', code: 'ATTACHMENTS_UNAVAILABLE' },
            });
        }
        const id = `00000000-0000-4000-8000-${String(seen.uploads.length).padStart(12, '0')}`;
        seen.ids.set(name, id);
        return route.fulfill({
            status: 201,
            json: {
                id,
                name,
                mediaType: name.endsWith('.png') ? 'image/png' : 'text/plain',
                size: 5,
                sha256: 'ab',
                state: 'pending',
            },
        });
    });
    await page.route('**/api/attachments/*', (route) =>
        route.request().method() === 'DELETE' ? route.fulfill({ status: 204 }) : route.fallback()
    );
    return seen;
}
