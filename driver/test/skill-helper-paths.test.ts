import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Issue #1006: the claude executor's CLAUDE_CONFIG_DIR is 0700 and node-owned, while the agent's
 * shell runs as the tool uid (#814). A skill helper invoked through the config directory is EACCES
 * there, so every helper under docker/skills/ is installed at a fixed root-owned path in both
 * images and its SKILL.md names that path.
 */
const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SKILLS = join(ROOT, 'docker', 'skills');
const FIXED_ROOT = '/usr/local/share/factory-skills';
const PRIVATE_DIRS = ['/home/node/.claude', '/home/node/.config/opencode'];
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const helpers = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) walk(path);
            else if (entry !== 'SKILL.md') out.push(relative(SKILLS, path));
        }
    };
    walk(SKILLS);
    return out;
};

describe('skill helper scripts reach the tool uid', () => {
    it('there is at least one helper to check', () => {
        expect(helpers()).toContain('pr-land/pr-status.sh');
        expect(helpers()).toContain('jira/jira.cjs');
    });

    it.each(['docker/claude-executor/Dockerfile', 'docker/opencode-executor/Dockerfile'])(
        '%s installs docker/skills root-owned and world-readable outside the config directory',
        (dockerfile) => {
            const text = read(dockerfile);
            expect(text).toContain(`COPY --from=skills --chown=root:root . ${FIXED_ROOT}/\n`);
            expect(text).toContain(`RUN chmod -R u=rwX,go=rX ${FIXED_ROOT}\n`);
            for (const dir of PRIVATE_DIRS) expect(FIXED_ROOT.startsWith(dir)).toBe(false);
        }
    );

    it('every helper is referenced by its fixed path, never through the skill directory', () => {
        for (const helper of helpers()) {
            const skill = read(`docker/skills/${helper.split('/')[0]}/SKILL.md`);
            expect(skill, helper).toContain(`${FIXED_ROOT}/${helper}`);
            expect(skill, helper).not.toMatch(/<this skill directory>|next to this file/);
        }
    });
});
