import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * The Connected apps table fits its card whatever the app name: no cell clips its text, Disconnect
 * is inside both the card and the viewport, and neither the table's wrapper nor the page scrolls
 * sideways. Shared by the specs that register an app, so a long name is checked wherever one is.
 */
export async function expectRowFits(page: Page, row: Locator): Promise<void> {
    const clipped = await row
        .locator('td')
        .evaluateAll((cells) =>
            cells.filter((cell) => cell.scrollWidth > cell.clientWidth).map((cell) => cell.getAttribute('data-label'))
        );
    expect(clipped, 'no cell clips its text').toEqual([]);
    const box = await row.getByRole('button', { name: /^Disconnect / }).boundingBox();
    expect(box, 'the Disconnect button is rendered').not.toBeNull();
    const right = (box?.x ?? 0) + (box?.width ?? 0);
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(right, 'Disconnect is inside the viewport').toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
    const card = await page.locator('section.panel', { has: page.getByLabel('Connected apps list') }).boundingBox();
    expect(right, 'Disconnect is inside its card').toBeLessThanOrEqual((card?.x ?? 0) + (card?.width ?? 0));
    const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(pageOverflow, 'the page does not scroll sideways').toBeLessThanOrEqual(0);
    const wrap = await page.getByLabel('Connected apps list').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(wrap, 'the table fits its card without its own scroll').toBeLessThanOrEqual(0);
}
