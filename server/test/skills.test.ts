import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveClaimSkills } from '../src/db/jobs/job-store-claim.js';
import { skillRoutes } from '../src/routes/skills.js';
import { readSkillCatalog, skillCatalog } from '../src/skills.js';
import { staticRegistry } from './helpers.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function skillsDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name));
        writeFileSync(join(dir, name, 'SKILL.md'), text);
    }
    return dir;
}

describe('readSkillCatalog', () => {
    it('loads the shipped skills with their declared requirements', () => {
        const byName = Object.fromEntries(readSkillCatalog().map((skill) => [skill.name, skill]));
        expect(Object.keys(byName).sort()).toEqual([
            'factory-fix',
            'factory-gates',
            'factory-github',
            'factory-jira',
            'factory-pr-land',
            'factory-review',
            'factory-task-title',
        ]);
        expect(byName['factory-task-title']?.requires).toEqual({ tools: [], connections: [] });
        expect(byName['factory-pr-land']?.requires).toEqual({ tools: ['gh'], connections: ['github'] });
        expect(byName['factory-jira']?.requires).toEqual({ tools: [], connections: ['jira'] });
        // The gates skill calls the image's factory-gate wrapper, not curl.
        expect(byName['factory-gates']?.requires).toEqual({ tools: [], connections: [] });
        expect(skillCatalog()).toEqual(readSkillCatalog());
    });

    it('throws naming the path when a SKILL.md cannot be read', () => {
        const dir = skillsDir({ broken: '---\nname: other\ndescription: x\n---\n' });
        expect(() => readSkillCatalog(dir)).toThrow(join(dir, 'broken', 'SKILL.md'));
    });

    it('throws naming the directory when it is missing', () => {
        const dir = join(tmpdir(), 'no-such-skills-dir');
        expect(() => readSkillCatalog(dir)).toThrow(dir);
    });
});

describe('resolveClaimSkills', () => {
    it('is null for no selection, and for a held connection', () => {
        expect(resolveClaimSkills([], undefined)).toBeNull();
        expect(resolveClaimSkills(['factory-github'], undefined, ['github'])).toBeNull();
    });

    it('asks for the App, never a member token, when the org holds no installation', () => {
        const sentence = resolveClaimSkills(['factory-github'], { GITHUB_TOKEN: 'x' });
        expect(sentence).toBe(
            '[skills unavailable] skill "factory-github" needs the github connection: install the GitHub App on this organization. Fix this, then retry the task.'
        );
    });
});

describe('GET /api/skills', () => {
    it('lists each skill with its requirements and env names, never the instructions', async () => {
        const app = Fastify();
        await app.register(skillRoutes(readSkillCatalog, staticRegistry()));
        const response = await app.inject({ method: 'GET', url: '/api/skills' });

        expect(response.statusCode).toBe(200);
        const { skills } = response.json() as { skills: { name: string; requires: unknown }[] };
        const jira = skills.find((skill) => skill.name === 'factory-jira');
        expect(jira?.requires).toEqual({
            tools: [],
            connections: [{ name: 'jira', env: [], selectedBy: 'connections' }],
        });
        // github is the App's: no env names and no body field selects it.
        expect(skills.find((skill) => skill.name === 'factory-github')?.requires).toEqual({
            tools: ['gh'],
            connections: [{ name: 'github', env: [], selectedBy: null }],
        });
        const body = readFileSync(join(root, 'docker/skills/factory-jira/SKILL.md'), 'utf8').split('\n---\n')[1] ?? '';
        expect(body.length).toBeGreaterThan(100);
        expect(response.body).not.toContain(body.trim().slice(0, 80));
    });

    it('fails registration when the catalog cannot load', async () => {
        const app = Fastify();
        await expect(
            app.register(
                skillRoutes(() => {
                    throw new Error('catalog broken');
                }, staticRegistry())
            )
        ).rejects.toThrow('catalog broken');
    });
});

describe('the runtime image', () => {
    // server/dist/skills.js resolves ../../docker/skills; in the image that is /app/docker/skills.
    it('carries docker/skills where server/dist resolves it', () => {
        const dockerfile = readFileSync(join(root, 'docker/Dockerfile'), 'utf8');
        const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
        expect(runtime).toMatch(/^COPY docker\/skills docker\/skills$/m);
    });
});
