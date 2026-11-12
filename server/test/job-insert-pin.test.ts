import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Class guard: a job row made by any path other than create and follow-up must still carry a skill pin
 * (docs/skills.md). Every `insert into job` under `src/db` names `skill_pin` in its column list, so a new insert path
 * cannot silently default to an empty pin. The same rule holds for `skill_hidden`, the row's visibility decision.
 */
const DB = new URL('../src/db/', import.meta.url).pathname;

const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return sources(path);
        return path.endsWith('.ts') ? [path] : [];
    });

const INSERT = /insert\s+into\s+job\s*\(([^)]*)\)/gi;

describe('every insert into job', () => {
    it('names skill_pin and skill_hidden in its column list', () => {
        const found: { file: string; columns: string }[] = [];
        for (const file of sources(DB)) {
            for (const match of readFileSync(file, 'utf8').matchAll(INSERT)) {
                found.push({ file: file.slice(DB.length), columns: match[1]! });
            }
        }

        expect(found.length).toBeGreaterThanOrEqual(5);
        const unnamed = (column: RegExp) =>
            found.filter((insert) => !column.test(insert.columns)).map((insert) => insert.file);
        expect(unnamed(/\bskill_pin\b/)).toEqual([]);
        expect(unnamed(/\bskill_hidden\b/)).toEqual([]);
    });
});
