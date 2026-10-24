import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Every `.ts` under `driver/src/`, area folders included, keyed by base name: `[name, text]`. */
export const driverSources = (): readonly (readonly [string, string])[] => {
    const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory()
                ? walk(join(dir, entry.name))
                : entry.name.endsWith('.ts')
                  ? [join(dir, entry.name)]
                  : []
        );
    return walk(SRC).map((path) => [path.slice(path.lastIndexOf('/') + 1), readFileSync(path, 'utf8')] as const);
};
