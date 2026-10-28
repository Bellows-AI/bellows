import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    INTEGRATION_PROVIDERS,
    parseSkillFrontmatter,
    requiredProviders,
    RUNNER_TOOLS,
    selectedBy,
    SKILL_CONNECTIONS,
    skillSelectionProblems,
    type Skill,
} from '../src/skills.js';

const SKILLS_DIR = new URL('../../docker/skills/', import.meta.url);
const skillNames = readdirSync(SKILLS_DIR);
const read = (name: string) => readFileSync(new URL(`${name}/SKILL.md`, SKILLS_DIR), 'utf8');

const head = (extra = '') => `---\nname: demo\ndescription: Does a thing.\n${extra}---\n\n# Body\n`;

describe('parseSkillFrontmatter', () => {
    it('reads name, description and the metadata requirement lists', () => {
        const skill = parseSkillFrontmatter(
            head('metadata:\n  requires-tools: gh, curl\n  requires-connections: github\n'),
            'demo'
        );
        expect(skill).toEqual({
            name: 'demo',
            description: 'Does a thing.',
            requires: { tools: ['gh', 'curl'], connections: ['github'] },
        });
    });

    it('treats a skill with no metadata as having no requirements', () => {
        expect(parseSkillFrontmatter(head(), 'demo').requires).toEqual({ tools: [], connections: [] });
    });

    it.each([
        ['an unknown top-level key', head('allowed-tools: Bash\n')],
        ['an unknown metadata key', head('metadata:\n  requires-secrets: x\n')],
        ['an unknown tool', head('metadata:\n  requires-tools: hammer\n')],
        ['an unknown connection', head('metadata:\n  requires-connections: slack\n')],
        ['a name that differs from its directory', head().replace('name: demo', 'name: other')],
        ['a missing description', head().replace('description: Does a thing.\n', '')],
        ['no frontmatter', '# Body\n'],
        ['an unclosed frontmatter', '---\nname: demo\n'],
    ])('refuses %s', (_label, text) => {
        expect(() => parseSkillFrontmatter(text, 'demo')).toThrow();
    });
});

describe('the shipped skills', () => {
    it.each(skillNames)('%s parses and names its own directory', (name) => {
        expect(parseSkillFrontmatter(read(name), name).name).toBe(name);
    });

    it('declares the connection the github and jira skills need', () => {
        expect(parseSkillFrontmatter(read('github'), 'github').requires.connections).toEqual(['github']);
        expect(parseSkillFrontmatter(read('jira'), 'jira').requires.connections).toEqual(['jira']);
    });

    it.each(skillNames)('%s carries no credential-looking literal', (name) => {
        expect(read(name)).not.toMatch(
            /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|ATATT[A-Za-z0-9]|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abprs]-|(?:fat|oat)_[A-Za-z0-9]{16,}/
        );
    });

    it.each(['claude-executor', 'opencode-executor'])('%s ships every tool a skill may require', (image) => {
        const dockerfile = readFileSync(new URL(`../../docker/${image}/Dockerfile`, import.meta.url), 'utf8');
        for (const tool of RUNNER_TOOLS) {
            expect(dockerfile, `${image} installs ${tool}`).toMatch(
                new RegExp(`(apt-get install[^\\n]*\\b${tool}\\b|${tool} --version|/usr/local/bin/${tool}\\b)`)
            );
        }
    });
});

describe('skillSelectionProblems', () => {
    const catalog: Skill[] = [
        { name: 'jira', description: 'j', requires: { tools: ['curl'], connections: ['jira'] } },
        { name: 'gates', description: 'g', requires: { tools: ['curl'], connections: [] } },
    ];
    const githubSkill: Skill = {
        name: 'github',
        description: 'g',
        requires: { tools: ['gh'], connections: ['github'] },
    };

    it('is empty when every requirement is met: the managed connection selected', () => {
        expect(skillSelectionProblems(catalog, ['jira', 'gates'], {}, ['jira'])).toEqual([]);
    });

    it('names an unknown skill and what is installed', () => {
        const [problem] = skillSelectionProblems(catalog, ['nope'], {});
        expect(problem).toContain('"nope" is not installed');
        expect(problem).toContain('jira, gates');
    });

    it('asks for the managed connection by its body field when the task selected none', () => {
        const [problem] = skillSelectionProblems(catalog, ['jira'], {});
        expect(problem).toBe(
            'skill "jira" needs the jira connection: select one with `connections` when creating the task'
        );
    });

    it('never lets env names stand in for a managed connection', () => {
        const reserved = { ATLASSIAN_SITE: 's', ATLASSIAN_EMAIL: 'e', ATLASSIAN_API_TOKEN: 't' };
        expect(skillSelectionProblems(catalog, ['jira'], reserved)).toHaveLength(1);
    });

    it('asks for the GitHub App when the org holds no installation, never a value', () => {
        const [problem] = skillSelectionProblems([githubSkill], ['github'], { OTHER: 'secret-other-value' });
        expect(problem).toBe('skill "github" needs the github connection: install the GitHub App on this organization');
        expect(problem).not.toContain('secret-other-value');
    });

    it('never lets a member GitHub token stand in for the App', () => {
        expect(skillSelectionProblems([githubSkill], ['github'], { GITHUB_TOKEN: 't', GH_TOKEN: 't' })).toHaveLength(1);
        expect(skillSelectionProblems([githubSkill], ['github'], {}, ['github'])).toEqual([]);
    });

    it('lets a skill without connections run on an empty env', () => {
        expect(skillSelectionProblems(catalog, ['gates'], {})).toEqual([]);
    });

    it('keeps the connection catalog to names', () => {
        expect(
            Object.values(SKILL_CONNECTIONS)
                .flat()
                .every((key) => /^[A-Z][A-Z0-9_]*$/.test(key))
        ).toBe(true);
    });
});

describe('integration providers', () => {
    const skill = (name: string, connections: string[]): Skill => ({
        name,
        description: 'd',
        requires: { tools: [], connections },
    });
    const catalog = [skill('jira', ['jira']), skill('github', ['github']), skill('gates', [])];

    it('github is a legacy repository capability and never selectable', () => {
        expect(INTEGRATION_PROVIDERS.github.kind).toBe('legacy-repository-capability');
        expect(selectedBy('github')).toBeNull();
    });

    it('jira is selected by connections', () => {
        expect(INTEGRATION_PROVIDERS.jira.kind).toBe('connection');
        expect(selectedBy('jira')).toBe('connections');
        expect(selectedBy('nope')).toBeNull();
    });

    it('requiredProviders lists the bindable providers the selected skills need, github never', () => {
        expect(requiredProviders(catalog, ['jira', 'github', 'gates'])).toEqual(['jira']);
        expect(requiredProviders(catalog, ['github', 'gates'])).toEqual([]);
        expect(requiredProviders(catalog, ['jira', 'jira', 'unknown'])).toEqual(['jira']);
    });
});
