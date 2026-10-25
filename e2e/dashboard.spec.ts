import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { FORBIDDEN, watchConsole } from './page-health.js';

const SHOTS = 'artifacts/ui';

/**
 * The analytics anchor: the metric summary when the selection is ready, the one empty state
 * when it is not. Every state of the null-not-zero contract renders exactly one of these —
 * never a row of dash cards — so the anchor is what "the dashboard has answered" looks like.
 */
function analyticsAnchor(page: Page) {
    return page.locator('.usage-summary, .usage-empty').first();
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
        for (const label of ['Uncached input per task', 'Output per task', 'Runs per task', 'Agent turns per task']) {
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

    test('the main chart plots at 360px on the desktop', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await open(page);

        const svg = page.locator('section.panel', { hasText: 'AI token usage' }).locator('.chart-wrap svg').first();
        const box = (await svg.boundingBox())!;
        // 360px of plot plus the axis padding, drawn near 1:1 at this width.
        expect(box.height).toBeGreaterThanOrEqual(400);
        expect(box.height).toBeLessThanOrEqual(432);
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

test.describe('token accounting (the usage specimen)', () => {
    test('the by-user selector ranks by Total input, re-ranks by Output and shows an unmeasured user as a dash', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await open(page);
        const panel = page.locator('section.panel', { hasText: 'Usage by user' });
        const selector = panel.getByLabel('Rank by');
        await expect(selector).toHaveValue('inputSide');
        await expect(panel.getByRole('button', { name: 'Total input' })).toBeVisible();

        await selector.selectOption('output');
        const header = panel.locator('th[aria-sort="descending"]');
        await expect(header).toContainText('Output');
        // The input-only specimen author measured no output: its Output is a dash with no bar.
        const noUser = panel.locator('tbody tr', { hasText: 'Specimen Input Only' });
        await expect(noUser).toHaveCount(1);
        await expect(noUser.locator('.usage-bar')).toHaveCount(0);
        await expect(noUser.locator('td').nth(2)).toHaveText('—');
        // A ranked user does carry a bar, and the ranking column is named after the selection.
        await expect(panel.locator('tbody tr .usage-bar').first()).toBeVisible();
        await page.screenshot({ path: `${SHOTS}/by-user-output.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('the summary breakdown expands to query sources without moving a figure', async ({ page }) => {
        const problems = watchConsole(page);
        await open(page);
        const summary = page.locator('.usage-summary');
        const figures = async () => summary.locator('.usage-groups').innerText();
        const before = await figures();
        await summary.locator('.usage-by-model summary').click();
        await summary.getByRole('button', { name: 'Show query sources for model-a' }).click();
        await expect(summary.locator('.usage-child-row').first()).toBeVisible();
        expect(await figures()).toBe(before);
        // What the totals leave out is its own readout, never inside the headline.
        const diagnostics = summary.locator('.usage-diagnostics');
        await expect(diagnostics).toContainText('usage whose time is unknown');
        await expect(summary.locator('.usage-groups')).not.toContainText('usage whose time is unknown');
        await page.screenshot({ path: `${SHOTS}/models-expanded.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });

    test('per-task usage shows one row per token type with contributors, partials and a model selector', async ({
        page,
    }) => {
        const problems = watchConsole(page);
        await open(page);
        const panel = page.locator('section.panel', { hasText: 'Per-task usage' });
        for (const label of ['Uncached input', 'Cache read', 'Cache write', 'Output']) {
            await expect(panel.getByText(`${label} per task`)).toBeVisible();
        }
        await expect(panel).toContainText('partial');
        await expect(panel).toContainText('Figures describe observed usage, not guaranteed complete consumption');
        const before = await panel.locator('tbody').innerText();
        await panel.getByLabel('Model').selectOption('model-a');
        expect(await panel.locator('tbody').innerText()).not.toBe(before);
        await expect(panel).toContainText('Includes');
        await page.screenshot({ path: `${SHOTS}/per-task-model.png`, fullPage: true });
        expect(problems.join('\n')).toBe('');
    });
});
