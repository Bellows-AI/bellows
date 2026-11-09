import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFrontmatter, type Skill } from '@factory-ai/core';

const SKILLS_DIR = new URL('../../docker/skills/', import.meta.url);

/**
 * The skills the runner images bake: `docker/skills/*` at a depth that resolves the same from
 * `src/` and `dist/` — the checkout's directory locally, `/app/docker/skills` in the image. A
 * missing directory or an unreadable SKILL.md throws, so a board never advertises a catalog it
 * cannot check requirements against.
 */
export function readSkillCatalog(dir: string | URL = SKILLS_DIR): Skill[] {
    const root = dir instanceof URL ? fileURLToPath(dir) : dir;
    let names: string[];
    try {
        names = readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch (error) {
        throw new Error(`cannot read the skills directory at ${root}`, { cause: error });
    }
    return names.map((name) => {
        const path = `${root}/${name}/SKILL.md`;
        try {
            return parseSkillFrontmatter(readFileSync(path, 'utf8'), name);
        } catch (error) {
            throw new Error(`cannot load the skill at ${path}`, { cause: error });
        }
    });
}

export type BuiltinSkillView = { skillMd: string; files: { path: string; size: number }[] };

function listFiles(root: string, rel: string, out: { path: string; size: number }[]): void {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
        const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
        const stat = lstatSync(join(root, path));
        if (stat.isDirectory()) listFiles(root, path, out);
        else if (stat.isFile()) out.push({ path, size: stat.size });
        else throw new Error(`${path} is neither a regular file nor a directory`);
    }
}

/**
 * A baked skill's SKILL.md and every file under it. The caller has already checked the name against
 * the catalog; any fs error here, ENOENT included, or a non-regular entry throws, so an unreadable
 * skill is never shown as an empty one.
 */
export function readBuiltinSkill(name: string, dir: string | URL = SKILLS_DIR): BuiltinSkillView {
    const base = dir instanceof URL ? fileURLToPath(dir) : dir;
    const root = join(base, name);
    const files: { path: string; size: number }[] = [];
    listFiles(root, '', files);
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { skillMd: readFileSync(join(root, 'SKILL.md'), 'utf8'), files };
}

let catalog: Skill[] | null = null;

/** The shipped catalog, read once per process. */
export function skillCatalog(): Skill[] {
    catalog ??= readSkillCatalog();
    return catalog;
}
