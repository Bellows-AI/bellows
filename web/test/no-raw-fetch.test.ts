import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** the data layer has ONE `fetch` — `request()`; a second one re-grows the 47 hand-rolled 401 branches. */
const API_DIR = join(import.meta.dirname, '..', 'src', 'api');

describe('web/src/api', () => {
    it('calls fetch( only inside request.ts', () => {
        const offenders = readdirSync(API_DIR)
            .filter((file) => file.endsWith('.ts') && file !== 'request.ts')
            .filter((file) =>
                /\bfetch\(/.test(readFileSync(join(API_DIR, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ''))
            );
        expect(offenders).toEqual([]);
    });
});
