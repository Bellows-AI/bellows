import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { BATCH_DETAIL_STATES, BatchBoard } from './fixtures/batch-board.js';
import { FORBIDDEN, useTheme, watchConsole } from './page-health.js';
import { COMPOSER_SHOT, DASHBOARD_SHOT, ENTRY_SHOTS, INBOX_SHOT, SETTINGS_SHOTS, SLOW, type Shot } from './routes.js';
import { THEMES } from './screenshot-matrix.js';
import { controlsOutsideViewport, noHorizontalOverflow } from './viewport.js';

/**
 * The route × state × theme × width regression matrix, read from the DOM (no screenshots, no
 * baselines). matrix.spec.ts walks overflow per width in one theme and the assistive passes;
 * the org page's states are org-states.spec.ts's; the batch detail's gallery states are
 * baseline.spec.ts's. This file fills what none of them assert:
 *
 *  - every major open-board route in the LIGHT theme as well, at desktop and phone width, with the
 *    same fit contract (no page overflow, no control past the viewport, no NaN/undefined text) and
 *    a clean console;
 *  - the batches list, the new-batch draft and the batch monitor, which matrix.spec.ts omits;
 *  - the loading and error states of the routes whose read can be held or refused: loading is
 *    never an alert, an error is always one (a refused read never passes for an empty page), and
 *    both fit the viewport;
 *  - the batches list's empty state.
 *
 * Tagged `@nightly` (about five minutes for the matrix): `npm run verify:ui:nightly` runs it.
 *
 * Every id comes from the board or a fixture; the forced failures are the only console errors
 * expected, and each cell names them.
 */

const WIDTHS = [1440, 390] as const;
const HEIGHT = 900;
const BATCH_ID_STATE = 'verification-failed';

/** What every settled cell must satisfy, whatever its state. */
async function assertFits(page: Page, width: number): Promise<void> {
    await noHorizontalOverflow(page);
    expect(await controlsOutsideViewport(page, width), 'controls past the viewport').toEqual([]);
    const text = await page.locator('main').innerText();
    for (const token of FORBIDDEN) expect(text, `page contains ${token}`).not.toContain(token);
}

/** A refused read the test forced on purpose logs a failed-resource console error; nothing else may. */
const unexpected = (problems: string[]) =>
    problems.filter((problem) => !/Failed to load resource: the server responded with a status of 500/.test(problem));

interface Cell {
    label: string;
    shot: Shot;
}

async function walk(page: Page, cell: Cell, width: number, theme: (typeof THEMES)[number]) {
    await page.setViewportSize({ width, height: HEIGHT });
    const ready = await cell.shot.open(page);
    await expect(ready).toBeVisible({ timeout: SLOW });
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.evaluate(() => document.fonts.ready);
    await assertFits(page, width);
}

const batchShot = (route: string, state: string, open: (page: Page) => Promise<Locator>): Shot => ({
    route,
    state,
    fixture: 'e2e/fixtures/batch-board.ts',
    open,
});

const BATCH_LIST: Shot = batchShot('batches', 'list', async (page) => {
    const board = new BatchBoard(page);
    await board.install();
    const { record, report } = BATCH_DETAIL_STATES[BATCH_ID_STATE]!;
    board.adopt(record, report);
    await page.goto('/batches');
    return page.locator('table.data');
});

const BATCH_DRAFT: Shot = batchShot('batches', 'new-draft', async (page) => {
    await page.goto('/batches/new');
    return page.getByLabel('Title');
});

const BATCH_MONITOR: Shot = batchShot('batches', 'monitor', async (page) => {
    const board = new BatchBoard(page);
    await board.install();
    const { record, report } = BATCH_DETAIL_STATES[BATCH_ID_STATE]!;
    board.adopt(record, report);
    await page.goto(`/batches/${record.id}`);
    return page.getByRole('heading', { level: 1 });
});

const BATCHES_EMPTY: Shot = batchShot('batches', 'empty', async (page) => {
    await page.route(/\/api\/batches(\?|$)/, (route) => route.fulfill({ status: 200, json: { batches: [] } }));
    await page.goto('/batches');
    return page.getByRole('heading', { level: 1, name: 'Batches' });
});

/** Settled pages, both themes. The anonymous entry pages need no sign-in; the signed-in account does. */
const SETTLED: readonly Cell[] = [
    DASHBOARD_SHOT,
    INBOX_SHOT,
    COMPOSER_SHOT,
    BATCH_LIST,
    BATCH_DRAFT,
    BATCH_MONITOR,
    BATCHES_EMPTY,
    ...SETTINGS_SHOTS,
    ...ENTRY_SHOTS.filter((shot) => shot.route !== 'account'),
].map((shot) => ({ label: `${shot.route}/${shot.state}`, shot }));

/** A route whose primary read the matrix can hold (loading) or refuse (error). */
interface Held {
    route: string;
    path: string;
    read: RegExp;
    /** False where the page shows a refused read as plain text, not an alert: a defect BEL-241 owns. The
     *  cell still holds those pages to the fit contract in the error state. */
    announces: boolean;
}

const HELD: readonly Held[] = [
    { route: 'dashboard', path: '/', read: /\/api\/stats/, announces: false },
    { route: 'inbox', path: '/tasks', read: /\/api\/tasks/, announces: true },
    { route: 'batches', path: '/batches', read: /\/api\/batches(\?|$)/, announces: true },
    { route: 'settings-repos', path: '/settings/repos', read: /\/api\/repos/, announces: false },
    { route: 'settings-workspace', path: '/settings/workspace', read: /\/api\/workspace(\?|$)/, announces: false },
    { route: 'settings-executors', path: '/settings/executors', read: /\/api\/workspace\/executors/, announces: false },
    { route: 'settings-integrations', path: '/settings/integrations', read: /\/api\/connections/, announces: true },
    { route: 'settings-organization', path: '/settings/organization', read: /\/api\/env/, announces: true },
];

for (const theme of THEMES) {
    test.describe(`settled routes, ${theme}`, { tag: '@nightly' }, () => {
        test.beforeEach(async ({ page }) => {
            await useTheme(page, theme);
        });

        for (const cell of SETTLED) {
            test(`${cell.label} fits at desktop and phone width with a clean console`, async ({ page }) => {
                const problems = watchConsole(page);
                for (const width of WIDTHS) {
                    await page.unrouteAll({ behavior: 'ignoreErrors' });
                    await walk(page, cell, width, theme);
                }
                expect(problems).toEqual([]);
            });
        }
    });

    test.describe(`held and refused reads, ${theme}`, { tag: '@nightly' }, () => {
        test.beforeEach(async ({ page }) => {
            await useTheme(page, theme);
        });

        for (const held of HELD) {
            test(`${held.route}: a held read is never an alert, a refused one always is`, async ({ page }) => {
                const problems = watchConsole(page);
                for (const width of WIDTHS) {
                    await page.setViewportSize({ width, height: HEIGHT });

                    // Loading: the read never answers, so the page must hold its place without alarming.
                    await page.unrouteAll({ behavior: 'ignoreErrors' });
                    await page.route(held.read, () => new Promise(() => {}));
                    await page.goto(held.path);
                    await expect(page.locator('main')).toBeVisible({ timeout: SLOW });
                    await expect(page.getByRole('alert'), 'loading is not an error').toHaveCount(0);
                    await assertFits(page, width);

                    // Error: the read is refused, so the page must say so — an error never reads as empty.
                    await page.unrouteAll({ behavior: 'ignoreErrors' });
                    await page.route(held.read, (route) =>
                        route.fulfill({ status: 500, json: { error: 'Matrix refusal' } })
                    );
                    await page.goto(held.path);
                    if (held.announces) {
                        await expect(page.getByRole('alert').first(), 'a refused read is announced').toBeVisible({
                            timeout: SLOW,
                        });
                    } else {
                        await expect(page.locator('main')).toBeVisible({ timeout: SLOW });
                    }
                    await assertFits(page, width);
                }
                expect(unexpected(problems)).toEqual([]);
            });
        }
    });
}
