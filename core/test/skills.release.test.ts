import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The release skill is an instruction artifact: nothing compiles it, so this file keeps it on the
 * repository it drives — every npm script it runs exists, every file and workflow it names
 * resolves, and the sibling skills it hands work to are real.
 */

const root = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');

const skill = read('.claude/skills/release/SKILL.md');
const scripts = Object.keys((JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts);

describe('the release skill', () => {
    it('is named after its directory and hands work to skills that exist', () => {
        expect(skill).toMatch(/^---\nname: release\n/);
        for (const sibling of ['fix', 'batch-control']) {
            expect(skill).toContain(`\`${sibling}\``);
            expect(existsSync(new URL(`.claude/skills/${sibling}/SKILL.md`, root))).toBe(true);
        }
    });

    it('runs only npm scripts the root package.json defines', () => {
        const named = [...skill.matchAll(/npm run ([a-z0-9:]+)/g)].map(([, script]) => script!);
        expect(named).toContain('release');
        for (const script of named) expect(scripts).toContain(script);
    });

    it('names only files and workflows that exist', () => {
        const paths = [
            ...skill.matchAll(/`((?:scripts|server|\.github\/workflows|charts)\/[^`*<\s]+?\.(?:sh|ts|yml|js))`/g),
        ].map(([, path]) => path!);
        expect(paths).toEqual(expect.arrayContaining(['scripts/release.sh', '.github/workflows/release-image.yml']));
        for (const path of paths) expect(existsSync(new URL(path, root)), path).toBe(true);
        expect(skill).toContain('release-image.yml');
    });

    it('confirms before the steps that publish or merge for real', () => {
        expect(skill.match(/\*\*Confirm\*\*/g)?.length).toBeGreaterThanOrEqual(3);
        expect(skill).toContain('never move or\ndelete a pushed tag');
    });
});
