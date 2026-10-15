import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webTest = fileURLToPath(new URL('.', import.meta.url));

/**
 * The node project runs with `isolate: false`, so a `web/src` module is one instance per fork.
 * `vi.spyOn(namespace, …)` patches that instance for every later file in the fork until it is
 * restored; a do-nothing spy on `reportUnauthenticated` that outlives its test silences
 * `session-listener.test.ts`. Observe a module through its public API instead
 * (`subscribeUnauthenticated` for the 401).
 */
describe('web suites never spy on a shared src module', () => {
    it('no `vi.spyOn` targets a namespace imported from ../src', () => {
        const hits: string[] = [];
        for (const file of readdirSync(webTest, { recursive: true, encoding: 'utf8' })) {
            if (!/\.test\.tsx?$/.test(file)) continue;
            const source = readFileSync(join(webTest, file), 'utf8');
            const namespaces = [...source.matchAll(/import \* as (\w+) from '(?:\.\.\/)+src\//g)].map((m) => m[1]);
            source.split('\n').forEach((line, i) => {
                for (const ns of namespaces) {
                    if (line.includes(`vi.spyOn(${ns},`)) hits.push(`${file}:${i + 1}`);
                }
            });
        }
        expect(hits).toEqual([]);
    });
});
