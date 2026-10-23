import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { containerScript } from '../src/container-scripts.js';
import { driverSources } from './fixtures/driver-sources.js';
import { REPO_ROOT } from './fixtures/repo-files.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SCRIPTS = join(SRC, 'scripts');

/**
 * Container scripts are read relative to the module that loads them (`import.meta.url`), so a module
 * that moves a directory deeper loses its scripts only inside the container. The two loaders stay at
 * the `src/` root beside `scripts/`; the area folders call `containerScript` and never read by path.
 */
describe('container script paths resolve', () => {
    it('reads every file under driver/src/scripts through containerScript', () => {
        const names = readdirSync(SCRIPTS);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) expect(containerScript(name), name).toBe(readFileSync(join(SCRIPTS, name), 'utf8'));
    });

    it('names only scripts that exist, wherever in driver/src the call sits', () => {
        const named = driverSources().flatMap(([file, text]) =>
            [...text.matchAll(/\b(?:containerScript|script)\('([^']+)'\)/g)].map((m) => [file, m[1] as string] as const)
        );
        expect(named.length).toBeGreaterThan(10);
        for (const [file, name] of named) expect(existsSync(join(SCRIPTS, name)), `${file}: ${name}`).toBe(true);
    });

    it('keeps the load-time readers beside scripts/ and out of the area folders', () => {
        const readers = driverSources().filter(([, text]) =>
            /new URL\([^)]*scripts\/[^)]*import\.meta\.url/.test(text)
        );
        expect(readers.map(([file]) => file).sort()).toEqual(['container-scripts.ts', 'helpers.ts']);
        for (const file of ['container-scripts.ts', 'helpers.ts']) expect(existsSync(join(SRC, file)), file).toBe(true);
    });

    it('copies the directory into dist as the build step', () => {
        const build = (
            JSON.parse(readFileSync(join(REPO_ROOT, 'driver/package.json'), 'utf8')) as { scripts: { build: string } }
        ).scripts.build;
        expect(build).toContain('cp -R src/scripts/. dist/scripts/');
    });
});
