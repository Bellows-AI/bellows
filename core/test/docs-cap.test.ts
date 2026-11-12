import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The doc cap, enforced (`.claude/skills/doc-maintenance/SKILL.md`): a doc is at most 60 lines, 120
 * for an area with several independent surfaces, and a runbook of literal commands is exempt. A
 * table cell is at most 300 characters, because a long cell dodges the line cap. Every file path a
 * doc names, in backticks or a link, resolves from the repo root.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS = join(ROOT, 'docs');
const LINE_CAP = 60;
const WIDE_CAP = 120;
const WIDE = new Set(['auth.md', 'design-system.md', 'jobs.md', 'kubernetes.md']);
const RUNBOOKS = new Set(['eks-runbook.md', 'jira-app-runbook.md']);
const CELL_CAP = 300;
const EXT = 'ts|tsx|mts|mjs|cjs|js|sql|sh|md|yaml|yml|json|grit|tpl|toml|mdx';
const PATH = new RegExp(`^[\\w.@/{},-]+\\.(${EXT})$`);

const files = readdirSync(DOCS)
    .filter((name) => name.endsWith('.md'))
    .sort();
const read = (name: string): string => readFileSync(join(DOCS, name), 'utf8');
const linesOf = (text: string): string[] => text.replace(/\n$/, '').split('\n');

const expandBraces = (path: string): string[] => {
    const m = /\{([^{}]+)\}/.exec(path);
    if (!m) return [path];
    return (m[1] ?? '').split(',').flatMap((alt) => expandBraces(path.replace(m[0], alt)));
};

const pathsIn = (text: string): string[] => {
    const found: string[] = [];
    for (const [, span] of text.matchAll(/`([^`\s]+)`/g)) {
        const bare = (span ?? '').replace(new RegExp(`(\\.(?:${EXT})):[\\w.:-]*$`), '$1');
        if (bare.includes('/') && PATH.test(bare)) found.push(...expandBraces(bare));
    }
    return found;
};

const linksIn = (text: string): string[] =>
    [...text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)]
        .map((m) => m[1] ?? '')
        .filter((target) => target !== '' && !/^[a-z]+:/i.test(target));

describe('docs cap', () => {
    it('scans the real docs directory, so an empty sweep cannot pass', () => {
        expect(files.length).toBeGreaterThan(20);
        expect(files).toContain('jobs.md');
    });

    it('names only docs that exist in its allowlists', () => {
        for (const name of [...WIDE, ...RUNBOOKS]) expect(files, name).toContain(name);
    });

    it.each(files)('%s stays within its line cap', (name) => {
        if (RUNBOOKS.has(name)) return;
        expect(linesOf(read(name)).length).toBeLessThanOrEqual(WIDE.has(name) ? WIDE_CAP : LINE_CAP);
    });

    it.each(files)('%s has no table cell over the cell cap', (name) => {
        const long = linesOf(read(name))
            .filter((line) => line.startsWith('|'))
            .flatMap((line) => line.replace(/^\||\|$/g, '').split(/(?<!\\)\|/))
            .filter((cell) => cell.trim().length > CELL_CAP)
            .map((cell) => `${cell.trim().length}: ${cell.trim().slice(0, 60)}`);
        expect(long).toEqual([]);
    });

    it.each(files)('%s names only paths that resolve from the repo root', (name) => {
        const text = read(name);
        const missing = pathsIn(text).filter((path) => !existsSync(join(ROOT, path)));
        const brokenLinks = linksIn(text).filter((target) => !existsSync(join(dirname(join(DOCS, name)), target)));
        expect([...new Set(missing)]).toEqual([]);
        expect([...new Set(brokenLinks)]).toEqual([]);
    });
});
