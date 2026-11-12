import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface TsConfig {
    include?: string[];
    references?: { path: string }[];
}

const readConfig = (path: string): TsConfig => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as TsConfig;

// vitest strips types, so a test directory left out of `tsc -b` drifts from the types it exercises unnoticed.
describe('npm run typecheck covers every test directory', () => {
    const references = (readConfig('tsconfig.json').references ?? []).map((ref) => ref.path);

    it.each(['core', 'server', 'web', 'driver', 'cli'])('%s/test is in a referenced project', (pkg) => {
        expect(references).toContain(`./${pkg}/tsconfig.test.json`);
        const include = readConfig(`${pkg}/tsconfig.test.json`).include ?? [];
        expect(include).toContain('test/**/*.ts');
    });

    it('the driver container scripts that opt in with // @ts-check are checked by npm run typecheck', () => {
        const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
            scripts: { typecheck: string };
        };
        expect(scripts.scripts.typecheck).toContain('tsc -p driver/tsconfig.scripts.json');
        expect(readConfig('driver/tsconfig.scripts.json').include).toContain('src/scripts/*.cjs');
    });

    it('web/test covers its .tsx tests', () => {
        expect(readConfig('web/tsconfig.test.json').include).toContain('test/**/*.tsx');
    });
});
