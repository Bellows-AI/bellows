import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../playwright.config.js';
import nightly, { SPECIMEN_PORT } from '../../playwright.nightly.config.js';
import specimenConfig, { specimenPort } from '../../e2e/specimen/vite.config.js';

/**
 * The browser suite's wiring, pinned offline: `verify:ui` needs a browser and two databases, so a
 * spec routed to the wrong project, or a specimen server on a port the project does not browse,
 * would otherwise surface only as a timeout in someone's full run.
 */
const project = (name: string, from = nightly) => {
    const found = from.projects?.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no ${name} project`);
    return found;
};

const matches = (patterns: unknown, file: string): boolean =>
    [patterns].flat().some((pattern) => pattern instanceof RegExp && pattern.test(file));

const SPEC = '/repo/e2e/specimen.spec.ts';

const specimenServers = (from: typeof config) =>
    [from.webServer ?? []].flat().filter((server) => server.command.includes('e2e/specimen/vite.config.ts'));

describe('the nightly split: playwright.config.ts vs playwright.nightly.config.ts', () => {
    it('hides @nightly from verify:ui and boots no specimen server there', () => {
        expect(config.projects?.map((candidate) => candidate.name).sort()).toEqual(['auth', 'chromium']);
        expect(String(config.grepInvert)).toBe('/@nightly/');
        expect(specimenServers(config)).toHaveLength(0);
    });

    it('runs only @nightly on the board, plus the specimen, on the same boards', () => {
        expect(nightly.projects?.map((candidate) => candidate.name).sort()).toEqual(['chromium', 'specimen']);
        expect(nightly.grepInvert).toBeUndefined();
        expect(String(project('chromium').grep)).toBe('/@nightly/');
        expect(project('specimen').grep).toBeUndefined();
        expect([nightly.webServer].flat()).toEqual(expect.arrayContaining([config.webServer].flat()));
    });

    it('tags the heavy captures that gate nothing', () => {
        const spec = (file: string) => readFileSync(new URL(`../../e2e/${file}`, import.meta.url), 'utf8');
        expect(spec('baseline.spec.ts')).toContain("test.describe('baseline gallery', { tag: '@nightly' }");
        expect(spec('json-editor.spec.ts')).toMatch(/'seeded gremlins[^']*',\s*\{\s*tag: '@nightly'/);
    });
});

describe('the specimen in playwright.nightly.config.ts (#275)', () => {
    it('routes specimen.spec.ts to the specimen project only', () => {
        expect(matches(project('specimen').testMatch, SPEC)).toBe(true);
        expect(matches(project('specimen').testMatch, '/repo/e2e/dashboard.spec.ts')).toBe(false);
        expect(matches(project('chromium').testIgnore, SPEC)).toBe(true);
        expect(matches(project('chromium', config).testIgnore, SPEC)).toBe(true);
        expect(matches(project('chromium', config).testIgnore, '/repo/e2e/auth.spec.ts')).toBe(true);
        expect(matches(project('chromium', config).testIgnore, '/repo/e2e/dashboard.spec.ts')).toBe(false);
        expect(matches(project('auth', config).testMatch, SPEC)).toBe(false);
    });

    it('browses the port its Vite server is told to bind', () => {
        expect(project('specimen').use?.baseURL).toBe(`http://127.0.0.1:${SPECIMEN_PORT}`);
        const specimen = specimenServers(nightly);
        expect(specimen).toHaveLength(1);
        expect(specimen[0]!.url).toBe(`http://127.0.0.1:${SPECIMEN_PORT}/`);
        expect(specimen[0]!.env).toEqual({ SPECIMEN_PORT: String(SPECIMEN_PORT) });
    });
});

describe('e2e/specimen/vite.config.ts (#275)', () => {
    it('derives its port from E2E_PORT_BASE the way playwright.nightly.config.ts does', () => {
        expect(specimenPort({})).toBe(8126);
        expect(specimenPort({ E2E_PORT_BASE: '8143' })).toBe(8146);
        expect(specimenPort({ E2E_PORT_BASE: '8143', SPECIMEN_PORT: '9000' })).toBe(9000);
    });

    it('serves e2e/specimen with the app stylesheet and fonts reachable, and builds nothing', () => {
        expect(specimenConfig.root).toMatch(/\/e2e\/specimen\/$/);
        expect(specimenConfig.publicDir).toMatch(/\/web\/public$/);
        expect(specimenConfig.server?.strictPort).toBe(true);
        expect(specimenConfig.server?.host).toBe('127.0.0.1');
        expect(specimenConfig.server?.fs?.allow).toEqual(
            expect.arrayContaining([expect.stringMatching(/\/web\/src$/), expect.stringMatching(/\/node_modules$/)])
        );
        // A build would write somewhere; the specimen is only ever served.
        expect(specimenConfig.build).toBeUndefined();
    });
});
