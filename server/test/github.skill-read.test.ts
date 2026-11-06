import { READ_BINDING, READ_FORBIDDEN, READ_NOT_FOUND } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { GitHubReadError } from '../src/github/pr-read.js';
import {
    CONTENTS_LISTING_LIMIT,
    MAX_REPO_SKILLS,
    parseRepoSkillFrontmatter,
    readRepoSkills,
} from '../src/github/skill-read.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
let counter = 0;
/** A repo name no other test shares, so the revision-keyed cache never crosses tests. */
const freshRepo = () => {
    counter += 1;
    return `acme/skills-${counter}`;
};

type Answer = unknown | GitHubReadError | ((signal?: AbortSignal) => Promise<unknown>);

/** A fake `call` answering by path prefix (query stripped), recording every request. */
function fakeCall(answers: Record<string, Answer>) {
    const paths: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const call = async (path: string, signal?: AbortSignal): Promise<unknown> => {
        paths.push(path);
        signals.push(signal);
        const answer = answers[path.split('?')[0] as string];
        if (answer === undefined) throw new GitHubReadError(`no stub for ${path}`, READ_NOT_FOUND);
        if (answer instanceof GitHubReadError) throw answer;
        if (typeof answer === 'function') return (answer as (s?: AbortSignal) => Promise<unknown>)(signal);
        return answer;
    };
    return { call, paths, signals };
}

const file = (text: string) => ({
    type: 'file',
    encoding: 'base64',
    content: Buffer.from(text).toString('base64'),
    size: text.length,
});
const dirs = (...names: string[]) => names.map((name) => ({ type: 'dir', name }));
const skillMd = (name: string, description: string, extra = '') =>
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nbody\n`;

function repoWith(repo: string, entries: Record<string, string>, listing = dirs(...Object.keys(entries))) {
    const answers: Record<string, Answer> = {
        [`/repos/${repo}/commits/main`]: { sha: SHA },
        [`/repos/${repo}/contents/.claude/skills`]: listing,
    };
    for (const [dir, text] of Object.entries(entries)) {
        answers[`/repos/${repo}/contents/.claude/skills/${dir}/SKILL.md`] = file(text);
    }
    return answers;
}

describe('readRepoSkills', () => {
    it('lists name+description per SKILL.md at the tip sha', async () => {
        const repo = freshRepo();
        const { call, paths } = fakeCall(
            repoWith(repo, { fix: skillMd('fix', 'Fix an issue'), plan: skillMd('plan', 'Plan work') })
        );
        const read = await readRepoSkills(call, repo, 'main');
        expect(read.revision).toBe(SHA);
        expect(read.skills).toEqual([
            { name: 'fix', description: 'Fix an issue' },
            { name: 'plan', description: 'Plan work' },
        ]);
        expect(read.unreadable).toEqual([]);
        expect(paths).toContain(`/repos/${repo}/contents/.claude/skills?ref=${SHA}`);
        expect(paths).toContain(`/repos/${repo}/contents/.claude/skills/fix/SKILL.md?ref=${SHA}`);
    });

    it('a 404 skills dir is no repo skills', async () => {
        const repo = freshRepo();
        const answers = repoWith(repo, {});
        answers[`/repos/${repo}/contents/.claude/skills`] = new GitHubReadError('nf', READ_NOT_FOUND);
        const read = await readRepoSkills(fakeCall(answers).call, repo, 'main');
        expect(read).toEqual({ revision: SHA, skills: [], unreadable: [], complete: true });
    });

    it('a 404 tip is an error, not an empty list', async () => {
        const repo = freshRepo();
        const answers = repoWith(repo, {});
        answers[`/repos/${repo}/commits/main`] = new GitHubReadError('nf', READ_NOT_FOUND);
        await expect(readRepoSkills(fakeCall(answers).call, repo, 'main')).rejects.toMatchObject({
            kind: READ_NOT_FOUND,
        });
    });

    it('a forbidden skills dir is an error, not an empty list', async () => {
        const repo = freshRepo();
        const answers = repoWith(repo, {});
        answers[`/repos/${repo}/contents/.claude/skills`] = new GitHubReadError('no', READ_FORBIDDEN);
        await expect(readRepoSkills(fakeCall(answers).call, repo, 'main')).rejects.toMatchObject({
            kind: READ_FORBIDDEN,
        });
    });

    it('a non-array dir body throws', async () => {
        const repo = freshRepo();
        const answers = repoWith(repo, {});
        answers[`/repos/${repo}/contents/.claude/skills`] = { type: 'file' };
        await expect(readRepoSkills(fakeCall(answers).call, repo, 'main')).rejects.toMatchObject({
            kind: READ_BINDING,
        });
    });

    it('a malformed SKILL.md lands in unreadable', async () => {
        const repo = freshRepo();
        const answers = repoWith(repo, { good: skillMd('good', 'ok'), bad: 'no frontmatter at all', gone: 'x' });
        answers[`/repos/${repo}/contents/.claude/skills/gone/SKILL.md`] = new GitHubReadError('nf', READ_NOT_FOUND);
        const read = await readRepoSkills(fakeCall(answers).call, repo, 'main');
        expect(read.skills).toEqual([{ name: 'good', description: 'ok' }]);
        expect([...read.unreadable].sort()).toEqual(['bad', 'gone']);
    });

    it('a failed SKILL.md read other than 404 is an error, not unreadable', async () => {
        const repo = freshRepo();
        const answers = repoWith(repo, { good: skillMd('good', 'ok') });
        answers[`/repos/${repo}/contents/.claude/skills/good/SKILL.md`] = new GitHubReadError('rl', READ_FORBIDDEN);
        await expect(readRepoSkills(fakeCall(answers).call, repo, 'main')).rejects.toBeInstanceOf(GitHubReadError);
    });

    it('a SKILL.md with allowed-tools/other keys parses (name+description)', async () => {
        const repo = freshRepo();
        const text = skillMd(
            'fix',
            'Fix a thing',
            'allowed-tools: Bash, Read\nargument-hint: "[issue]"\nmetadata:\n  tools: gh\n'
        );
        const read = await readRepoSkills(fakeCall(repoWith(repo, { fix: text })).call, repo, 'main');
        expect(read.skills).toEqual([{ name: 'fix', description: 'Fix a thing' }]);
        expect(read.unreadable).toEqual([]);
    });

    it('caps at 50 entries', async () => {
        const repo = freshRepo();
        const entries: Record<string, string> = {};
        for (let i = 0; i < MAX_REPO_SKILLS + 10; i += 1) entries[`s${i}`] = skillMd(`s${i}`, 'd');
        const { call, paths } = fakeCall(repoWith(repo, entries));
        const read = await readRepoSkills(call, repo, 'main');
        expect(MAX_REPO_SKILLS).toBe(50);
        expect(read.skills).toHaveLength(MAX_REPO_SKILLS);
        expect(read.complete).toBe(false);
        expect(paths.filter((p) => p.includes('SKILL.md'))).toHaveLength(MAX_REPO_SKILLS);
    });

    it('exactly the cap is complete; a directory entry with no usable name is not', async () => {
        const repo = freshRepo();
        const entries: Record<string, string> = {};
        for (let i = 0; i < MAX_REPO_SKILLS; i += 1) entries[`s${i}`] = skillMd(`s${i}`, 'd');
        const full = await readRepoSkills(fakeCall(repoWith(repo, entries)).call, repo, 'main');
        expect(full.complete).toBe(true);
        const other = freshRepo();
        const listing = [...dirs('fix'), { type: 'dir' }] as ReturnType<typeof dirs>;
        const odd = await readRepoSkills(
            fakeCall(repoWith(other, { fix: skillMd('fix', 'd') }, listing)).call,
            other,
            'main'
        );
        expect(odd.complete).toBe(false);
    });

    it.each([
        ['an entry with no type', [{ name: 'repo-only' }]],
        ['an entry with no name', [{ type: 'dir' }]],
        ['a non-object element', ['repo-only']],
        ['a null element', [null]],
        ['an unknown entry type', [{ name: 'repo-only', type: 'mystery' }]],
    ])('a listing with %s is incomplete', async (_label, listing) => {
        const repo = freshRepo();
        const read = await readRepoSkills(
            fakeCall(repoWith(repo, {}, listing as unknown as ReturnType<typeof dirs>)).call,
            repo,
            'main'
        );
        expect(read.complete).toBe(false);
    });

    it('well-formed files, symlinks and submodules are skipped without losing completeness', async () => {
        const repo = freshRepo();
        const listing = [
            ...dirs('fix'),
            { type: 'file', name: 'README.md' },
            { type: 'symlink', name: 'link' },
            { type: 'submodule', name: 'sub' },
        ] as ReturnType<typeof dirs>;
        const read = await readRepoSkills(
            fakeCall(repoWith(repo, { fix: skillMd('fix', 'd') }, listing)).call,
            repo,
            'main'
        );
        expect(read.complete).toBe(true);
    });

    it('a listing at the contents API entry limit is incomplete: entries past it are not listed', async () => {
        const repo = freshRepo();
        const files = Array.from({ length: CONTENTS_LISTING_LIMIT }, (_, i) => ({ type: 'file', name: `f${i}.md` }));
        const read = await readRepoSkills(
            fakeCall(repoWith(repo, {}, files as ReturnType<typeof dirs>)).call,
            repo,
            'main'
        );
        expect(read.complete).toBe(false);
    });

    it('a listing that is not an array throws, and an unreadable SKILL.md makes the read incomplete', async () => {
        const repo = freshRepo();
        const notList = repoWith(repo, {}, { type: 'file' } as unknown as ReturnType<typeof dirs>);
        await expect(readRepoSkills(fakeCall(notList).call, repo, 'main')).rejects.toThrow();
        const other = freshRepo();
        const read = await readRepoSkills(
            fakeCall(repoWith(other, { fix: skillMd('fix', 'd') }, dirs('fix', 'broken'))).call,
            other,
            'main'
        );
        expect(read.unreadable).toEqual(['broken']);
        expect(read.complete).toBe(false);
    });

    it('the deadline aborts in-flight reads and throws', async () => {
        const repo = freshRepo();
        const answers = repoWith(repo, { fix: skillMd('fix', 'd') });
        let aborted = false;
        answers[`/repos/${repo}/contents/.claude/skills/fix/SKILL.md`] = (signal?: AbortSignal) =>
            new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => {
                    aborted = true;
                    reject(new Error('aborted'));
                });
            });
        await expect(readRepoSkills(fakeCall(answers).call, repo, 'main', { deadlineMs: 30 })).rejects.toThrow();
        expect(aborted).toBe(true);
    });

    it('a caller signal aborts the read', async () => {
        const repo = freshRepo();
        const controller = new AbortController();
        controller.abort();
        const { call } = fakeCall(repoWith(repo, { fix: skillMd('fix', 'd') }));
        await expect(readRepoSkills(call, repo, 'main', { signal: controller.signal })).rejects.toThrow();
    });

    it('a second call at the same sha issues only the tip request', async () => {
        const repo = freshRepo();
        const { call, paths } = fakeCall(repoWith(repo, { fix: skillMd('fix', 'd') }));
        const first = await readRepoSkills(call, repo, 'main');
        const before = paths.length;
        const second = await readRepoSkills(call, repo, 'main');
        expect(second).toEqual(first);
        expect(paths.slice(before)).toEqual([`/repos/${repo}/commits/main`]);
    });

    it('reads the default branch tip when no branch is named', async () => {
        const repo = freshRepo();
        const answers = repoWith(repo, {});
        answers[`/repos/${repo}/commits/HEAD`] = { sha: SHA };
        const read = await readRepoSkills(fakeCall(answers).call, repo, null);
        expect(read.revision).toBe(SHA);
    });
});

describe('parseRepoSkillFrontmatter', () => {
    it('reads quoted and folded descriptions, ignoring every other key', () => {
        const text =
            '---\nname: "fix"\nallowed-tools: [Bash]\ndescription: >-\n  Fix a thing\n  end to end\nmodel: x\n---\n';
        expect(parseRepoSkillFrontmatter(text)).toEqual({ name: 'fix', description: 'Fix a thing end to end' });
    });

    it('is null without frontmatter, name or description', () => {
        expect(parseRepoSkillFrontmatter('hello')).toBeNull();
        expect(parseRepoSkillFrontmatter('---\nname: x\n---\n')).toBeNull();
        expect(parseRepoSkillFrontmatter('---\ndescription: x\n---\n')).toBeNull();
        expect(parseRepoSkillFrontmatter('---\nname: x\ndescription: y\n')).toBeNull();
    });
});
