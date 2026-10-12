import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import base, { NIGHTLY_TAG, PORT_BASE, SPECIMEN_SPEC } from './playwright.config.js';

/**
 * The nightly browser run (`npm run verify:ui:nightly`, `.github/workflows/ui-nightly.yml`): what
 * `verify:ui` hides behind NIGHTLY_TAG, on the same boards, plus the specimen and its own server.
 * None of it gates a merge.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const SPECIMEN_PORT_OFFSET = 3;
/** The component-state specimen's test-only Vite server (#275): no database, nothing built. */
export const SPECIMEN_PORT = PORT_BASE + SPECIMEN_PORT_OFFSET;

const chromium = base.projects?.find((project) => project.name === 'chromium');
if (!chromium) throw new Error('playwright.config.ts has no chromium project');
// The one thing not inherited: the filter that hides @nightly from verify:ui.
const { grepInvert: _hidesNightly, ...shared } = base;

export default defineConfig({
    ...shared,
    projects: [
        { ...chromium, grep: NIGHTLY_TAG },
        {
            // The design-system reference sheet (redesign plan §1.7): real primitives on a Vite
            // server outside web/, because the API serves only web/dist and a second entry there
            // would ship publicly.
            name: 'specimen',
            testMatch: SPECIMEN_SPEC,
            use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${SPECIMEN_PORT}` },
        },
    ],
    webServer: [
        ...[base.webServer ?? []].flat(),
        {
            // Served, never built: nothing it renders reaches web/dist. Playwright starts every
            // webServer whatever --project says, so `--project specimen` still boots the boards;
            // for a look without them, run this command by hand.
            command: 'npx vite --config e2e/specimen/vite.config.ts',
            url: `http://127.0.0.1:${SPECIMEN_PORT}/`,
            cwd: root,
            env: { SPECIMEN_PORT: String(SPECIMEN_PORT) },
            reuseExistingServer: false,
            stdout: 'ignore',
            stderr: 'pipe',
        },
    ],
});
