import type { Page } from '@playwright/test';
import type { Theme } from './screenshot-matrix.js';

/**
 * What a missing null guard looks like to a reader. A literal 'NaN' or 'undefined' on screen is
 * caught by neither type checking nor the SSR smoke test.
 */
export const FORBIDDEN = ['NaN', 'undefined', 'Infinity', '[object Object]'];

/** Every console error, uncaught page error and failed request the page raises, as it raises them. */
export function watchConsole(page: Page): string[] {
    const problems: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
    return problems;
}

/** Both theme mechanisms the bootstrap reads — the stored preference and the OS scheme — so the
 *  real before-paint path picks the theme on both origins and across every navigation. */
export async function useTheme(page: Page, theme: Theme): Promise<void> {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript((t) => localStorage.setItem('factory.theme', t), theme);
}
