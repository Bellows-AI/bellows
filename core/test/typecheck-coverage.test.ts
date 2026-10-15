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

    it('web/test covers its .tsx tests', () => {
        expect(readConfig('web/tsconfig.test.json').include).toContain('test/**/*.tsx');
    });
});
