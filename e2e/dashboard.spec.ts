import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

const SHOTS = 'artifacts/ui';

/**
 * The four states the null-not-zero contract can produce on screen. A literal 'NaN' or
 * 'undefined' is what a missing null guard looks like to a reader, and neither type checking
 * nor the SSR smoke test catches it.
 */
const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

/**
 * The analytics anchor: the metric summary when the selection is ready, the one empty state
 * when it is not. Every state of the null-not-zero contract renders exactly one of these —
 * never a row of dash cards — so the anchor is what "the dashboard has answered" looks like.
 */
function analyticsAnchor(page: Page) {
    return page.locator('.usage-summary, .usage-empty').first();
}

function watchConsole(page: Page): string[] {
    const problems: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
        if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    return problems;
}

/** The dashboard answers 202 while the first read runs, so wait for the anchor, not for load. */
async function open(page: Page) {
    await page.goto('/');
    await expect(analyticsAnchor(page)).toBeVisible({ timeout: 60_000 });
}

/**
 * A preset that resolves to the query already on screen does not refetch — the hook keys on the
 * query string, not on the click. So the wait is for the specific range, and callers that expect
 * no request say so.
 */
async function selectPreset(page: Page, label: string, preset: string) {
    const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes(`range=${preset}`) && r.status() === 200),
        (async () => {
            await page.locator('#range-select').click();
            await page.getByRole('option', { name: label, exact: true }).click();
        })(),
    ]);
    const body = (await response.json()) as {
        meta: { range: { preset: string; from: string | null; to: string | null } };
    };
    return { url: new URL(response.url()), range: body.meta.range };
}

async function assertRendersCleanly(page: Page, name: string) {
    await expect(analyticsAnchor(page)).toBeVisible();
    // A ready selection stands on its panels; the empty selection is the one empty state.
    if (await page.locator('.usage-summary').count()) {
        expect(await page.locator('section.panel').count()).toBeGreaterThan(2);
    }

    const text = await page.locator('main').innerText();
    for (const token of FORBIDDEN) expect(text, `${name} contains ${token}`).not.toContain(token);

    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.describe('date range selector', () => {
    test('every preset re-renders the whole dashboard cleanly', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        // 'All time' is the default, so it is selected last: clicking it first would change no
        // query and fire no request.
        await expect(page.locator('#range-select')).toHaveText('All time');
        // All time is what the page opens on, so no click is needed to read the baseline.
        const allTime = await page.locator('.usage-summary strong').allInnerTexts();

        for (const [label, preset] of [
            ['Today', 'day'],
            ['7 days', 'week'],
            ['14 days', '2w'],
            ['30 days', 'month'],
            ['All time', 'all'],
        ] as const) {
            const { url, range } = await selectPreset(page, label, preset);
            expect(url.searchParams.get('range'), label).toBe(preset);
            expect(range.preset, label).toBe(preset);
            await expect(page.locator('#range-select')).toHaveText(label);
            if (preset === 'day') {
                // A narrowed range changes the numbers. A sparse day may render the one empty
                // state instead of the summary — that is a different screen, not the same
                // numbers, and both satisfy "changed". The poll rides out the gap between the
                // response reaching the test and React committing the payload.
                await expect
                    .poll(async () => page.locator('.usage-summary strong').allInnerTexts())
                    .not.toEqual(allTime);
            }
            await assertRendersCleanly(page, preset);
        }

        expect(problems.join('\n')).toBe('');
    });

    test('the custom range dialog stays inside the viewport and restores focus to the trigger on a narrow phone', async ({
        page,
    }) => {
        await open(page);
        await page.setViewportSize({ width: 360, height: 844 });

        // The dialog centers over the dimmed page rather than anchoring to the trigger, so it
        // never has to flip or clip — the containment the closeout audit (issue 190) demands of
        // every floating surface still holds, just by a different mechanism.
        await page.locator('#range-select').click();
        await page.getByRole('option', { name: 'Custom', exact: true }).click();
        const dialog = page.locator('.range-dialog');
        await expect(dialog).toBeVisible();
        const box = (await dialog.boundingBox())!;
        expect(box.x, 'range dialog left edge').toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, 'range dialog right edge').toBeLessThanOrEqual(361);
        await page.screenshot({ path: `${SHOTS}/matrix/dashboard_range-dialog-open_dark_360.png` });

        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(page.locator('#range-select'), 'escape hands focus back to the Range trigger').toBeFocused();
    });

    test('the chart tooltip stays inside the viewport when a bucket is focused', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await open(page);

        // The last bucket of the all-time chart: the readout clamps inside the SVG, but the SVG
        // rides the chart wrap's horizontal scroll — focusing the far end must still leave the
        // tooltip inside what the reader can see.
        const bucket = page.locator('.bucket-hit').last();
        await bucket.focus();
        const tooltip = page.locator('.chart-tooltip').last();
        await expect(tooltip).toBeVisible();
        const box = (await tooltip.boundingBox())!;
        expect(box.x, 'chart tooltip left edge').toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, 'chart tooltip right edge').toBeLessThanOrEqual(1441);
    });

    test('the page carries no pull-request vocabulary', async ({ page }) => {
        await open(page);
        const text = (await page.locator('main').innerText()) + (await page.locator('.appbar').innerText());
        expect(text).not.toMatch(/pull requests?/i);
        expect(text).not.toMatch(/revert rate/i);
        expect(text).not.toMatch(/merged into/i);
    });

    test('month buckets daily, all-time falls back to weeks, and the per-task figures render', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);

        // The month preset spans 30 days: day buckets, and the caption says so.
        await selectPreset(page, '30 days', 'month');
        await expect(page.getByText('Input and output tokens by day')).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/daily-month.png`, fullPage: true });

        // All-time spans the seeded half-year: the weekly fallback, named as such — in the
        // caption, and by the calculation disclosure once it is opened.
        await selectPreset(page, 'All time', 'all');
        await expect(page.getByText('Input and output tokens by ISO week')).toBeVisible();
        await page.locator('section.panel', { hasText: 'AI token usage' }).locator('.chart-disclosure summary').click();
        await expect(page.getByText('longer windows render ISO weeks')).toBeVisible();

        // The per-task panel: one table now, every row labeled with its kind, each figure under
        // its Average/Median/P95 header with its measured count beside it.
        const panel = page.locator('section.panel', { hasText: 'Per-task usage' });
        await expect(panel).toBeVisible();
        for (const label of ['Average', 'Median', 'P95', 'Measured tasks']) {
            await expect(panel.getByRole('button', { name: label })).toBeVisible();
        }
        for (const label of ['Tokens per task', 'Runs per task', 'Agent turns per task']) {
            await expect(panel.getByText(label)).toBeVisible();
        }
        await page.screenshot({ path: `${SHOTS}/per-task.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});

test.describe('the analytics dashboard layout (issue 283)', () => {
    test('the toolbar is one 64px panel carrying range, scope, coverage and freshness', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page);

        const toolbar = page.locator('.analytics-toolbar');
        const box = (await toolbar.boundingBox())!;
        expect(box.height, 'toolbar height at 1440').toBeGreaterThanOrEqual(64);
        expect(box.height, 'toolbar height at 1440').toBeLessThanOrEqual(72);
        await expect(toolbar.locator('#range-select')).toBeVisible();
        await expect(toolbar.locator('#range-select svg.icon')).toHaveCount(1);
        await expect(toolbar.locator('.updated-at')).toContainText('Updated');
        // Coverage is text with a dot, never a selector.
        await expect(toolbar.locator('.toolbar-coverage')).toHaveText(/\d+ (tracked )?repositor(y|ies)/);
        await expect(toolbar.locator('.toolbar-coverage-dot')).toHaveCount(1);
        await expect(toolbar.locator('.toolbar-coverage button')).toHaveCount(0);
        // Open mode has no personal scope — the "unavailable identity" case: a read-only value,
        // never a dead dropdown.
        await expect(page.locator('#scope-select')).toHaveCount(0);
        await expect(toolbar.locator('.toolbar-value')).toHaveText('Organization');
        // Every item shares one row: the legends sit inline beside their controls.
        const range = (await toolbar.locator('#range-select').boundingBox())!;
        const stamp = (await toolbar.locator('.updated-at').boundingBox())!;
        expect(Math.abs(range.y + range.height / 2 - (stamp.y + stamp.height / 2))).toBeLessThan(4);
        await toolbar.screenshot({ path: `${SHOTS}/dashboard-toolbar-1440.png` });

        // The primary content begins in the first viewport. Measured once the analytics have
        // landed (open() waits on the anchor): the board panels mount before the telemetry read
        // resolves, so the first paint's first `main section` is a task panel further down.
        const first = await page.locator('main section').first().boundingBox();
        expect(first).not.toBeNull();
        expect(first!.y).toBeLessThan(900);

        // The precise freshness stamp opens inside the viewport from the toolbar edge.
        const stampInside = async (width: number) => {
            await page.locator('.updated-at').focus();
            const full = (await page.locator('.updated-at-full').boundingBox())!;
            expect(full.x, `${width}px: stamp left edge`).toBeGreaterThanOrEqual(0);
            expect(full.x + full.width, `${width}px: stamp right edge`).toBeLessThanOrEqual(width);
        };
        await stampInside(1440);

        // Usage by user and Recent tasks sit side by side from 1200px and stack below.
        const byUser = page.locator('section.panel', { hasText: 'Usage by user' });
        const recent = page.locator('section.panel', { hasText: 'Recent tasks' });
        const [a, b] = [(await byUser.boundingBox())!, (await recent.boundingBox())!];
        expect(Math.abs(a.y - b.y), 'same row at 1440').toBeLessThan(2);
        expect(b.x).toBeGreaterThan(a.x + a.width);
        await page.setViewportSize({ width: 1024, height: 900 });
        const [c, d] = [(await byUser.boundingBox())!, (await recent.boundingBox())!];
        expect(d.y, 'stacked at 1024').toBeGreaterThanOrEqual(c.y + c.height);

        await page.setViewportSize({ width: 390, height: 900 });
        await stampInside(390);
    });

    test('four metric cards, no decorative trend, comparison or cost', async ({ page }) => {
        await open(page);

        await expect(page.locator('.usage-summary .usage-group')).toHaveCount(4);
        await expect(page.locator('.usage-summary .usage-disc')).toHaveCount(4);
        for (const label of ['Sessions', 'Total input tokens', 'Active time', 'Edit acceptance']) {
            await expect(page.locator('.usage-summary .usage-label', { hasText: label })).toBeVisible();
        }
        const text = await page.locator('main').innerText();
        expect(text).not.toMatch(/vs\.? previous|↑|↓|estimated cost/i);
        await expect(page.getByRole('button', { name: /weekly|bar chart|line chart/i })).toHaveCount(0);
    });

    test('the main chart plots at 360px on the desktop', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page);

        const svg = page.locator('section.panel', { hasText: 'AI token usage' }).locator('.chart-wrap svg').first();
        const box = (await svg.boundingBox())!;
        // 360px of plot plus the axis padding, drawn near 1:1 at this width.
        expect(box.height).toBeGreaterThanOrEqual(400);
        expect(box.height).toBeLessThanOrEqual(432);
    });

    test('a partial period is hatched and keyed in the caption', async ({ page }) => {
        await open(page);

        const panel = page.locator('section.panel', { hasText: 'AI token usage' });
        await expect(panel.locator('pattern#partial-hatch')).toHaveCount(1);
        await expect(panel.getByText('The hatched bucket is a partial period.')).toBeVisible();
    });

    test('a failed refresh keeps the last good data and recovers on the next read', async ({ page }) => {
        test.slow();
        await open(page);

        await page.route('**/api/stats**', (route) => route.fulfill({ status: 500, body: 'boom' }));
        await expect(page.getByText('showing the last successful')).toBeVisible({ timeout: 90_000 });
        await expect(page.locator('.usage-summary')).toBeVisible();

        await page.unroute('**/api/stats**');
        await expect(page.getByText('showing the last successful')).toHaveCount(0, { timeout: 90_000 });
        await expect(page.locator('.usage-summary')).toBeVisible();
    });
});
