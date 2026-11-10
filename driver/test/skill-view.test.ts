import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The shared skill-view builder both executor entrypoints run. Claude: a pinned workspace skill is linked into the
 * managed view, which outranks a same-name checkout skill. Opencode: the checkout's own skill folders are switched off
 * and re-offered through a view in which the workspace copy is the only one of its name.
 */
const SCRIPT = join(import.meta.dirname, '..', '..', 'docker', 'executor-common', 'skill-view.cjs');
const REFUSED = 78;

let root: string;
let skills: string;
let view: string;
let repo: string;

const skillAt = (dir: string, name: string, withManifest = true) => {
    mkdirSync(join(dir, name), { recursive: true });
    if (withManifest) writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
};

const run = (args: string[], env: Record<string, string | undefined>) => {
    const child = spawnSync('node', [SCRIPT, ...args], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, FACTORY_SKILLS_PATH: skills, ...env },
    });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
};

const entries = () => readdirSync(view).sort();
const target = (name: string) => readlinkSync(join(view, name));

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'skill-view-')));
    skills = join(root, 'skills');
    view = join(root, 'view');
    repo = join(root, 'repo');
    mkdirSync(skills);
    mkdirSync(view);
    mkdirSync(join(repo, '.git'), { recursive: true });
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('claude mode', () => {
    it('links each workspace skill to the skills volume and opens the view to every uid', () => {
        chmodSync(view, 0o700);
        const got = run(['claude', view], { FACTORY_WORKSPACE_SKILLS: 'ws-a,ws-b' });
        expect(got.status).toBe(0);
        expect(entries()).toEqual(['ws-a', 'ws-b']);
        expect(target('ws-a')).toBe(join(skills, 'ws-a'));
        expect(target('ws-b')).toBe(join(skills, 'ws-b'));
        expect(statSync(view).mode & 0o777).toBe(0o755);
        expect(JSON.parse(got.stdout.trim())).toEqual({ linked: ['ws-a', 'ws-b'] });
    });

    it('links a name whose bundle is not installed yet', () => {
        expect(run(['claude', view], { FACTORY_WORKSPACE_SKILLS: 'ws-a' }).status).toBe(0);
        expect(existsSync(join(view, 'ws-a'))).toBe(false);
        expect(lstatSync(join(view, 'ws-a')).isSymbolicLink()).toBe(true);
    });

    it('is idempotent and never replaces an entry that is already there', () => {
        symlinkSync('/usr/local/share/factory-skills/factory-fix', join(view, 'factory-fix'));
        expect(run(['claude', view], { FACTORY_WORKSPACE_SKILLS: 'ws-a' }).status).toBe(0);
        expect(run(['claude', view], { FACTORY_WORKSPACE_SKILLS: 'ws-a' }).status).toBe(0);
        expect(target('factory-fix')).toBe('/usr/local/share/factory-skills/factory-fix');
        expect(entries()).toEqual(['factory-fix', 'ws-a']);
    });

    it('refuses an entry of the same name that points elsewhere', () => {
        symlinkSync('/elsewhere/ws-a', join(view, 'ws-a'));
        expect(run(['claude', view], { FACTORY_WORKSPACE_SKILLS: 'ws-a' }).status).toBe(REFUSED);
        expect(target('ws-a')).toBe('/elsewhere/ws-a');
    });

    it.each([
        ['a built-in name', 'ws-a,factory-x'],
        ['an empty element', 'a,,b'],
        ['an upper-case name', 'Bad'],
        ['a path', '../x'],
    ])('refuses %s with one stderr line and links nothing', (_label, list) => {
        const got = run(['claude', view], { FACTORY_WORKSPACE_SKILLS: list });
        expect(got.status).toBe(REFUSED);
        expect(got.stderr.trim().split('\n')).toHaveLength(1);
        expect(entries()).toEqual([]);
    });

    it('refuses a workspace list without the skills directory', () => {
        const got = run(['claude', view], { FACTORY_WORKSPACE_SKILLS: 'ws-a', FACTORY_SKILLS_PATH: '' });
        expect(got.status).toBe(REFUSED);
        expect(entries()).toEqual([]);
    });

    it('links nothing for an unset or empty list', () => {
        expect(run(['claude', view], {}).status).toBe(0);
        expect(run(['claude', view], { FACTORY_WORKSPACE_SKILLS: '' }).status).toBe(0);
        expect(entries()).toEqual([]);
    });
});

describe('opencode mode', () => {
    const opencode = (
        workdir: string,
        env: Record<string, string | undefined> = { FACTORY_WORKSPACE_SKILLS: 'ws-a' }
    ) => run(['opencode', view, workdir, repo], env);

    it('offers the workspace copy as the only one of its name, and the checkout’s other skills beside it', () => {
        skillAt(join(repo, '.claude', 'skills'), 'ws-a');
        skillAt(join(repo, '.claude', 'skills'), 'other');
        skillAt(join(repo, '.agents', 'skills'), 'ag');
        const got = opencode(repo);
        expect(got.status).toBe(0);
        expect(entries()).toEqual(['ag', 'other', 'ws-a']);
        expect(target('ws-a')).toBe(join(skills, 'ws-a'));
        expect(target('other')).toBe(join(repo, '.claude', 'skills', 'other'));
        expect(target('ag')).toBe(join(repo, '.agents', 'skills', 'ag'));
        expect(JSON.parse(got.stdout.trim()).linked.sort()).toEqual(['ag', 'other', 'ws-a']);
    });

    it('also reads the skills of every directory from the workdir up to the worktree root', () => {
        const sub = join(repo, 'packages', 'app');
        mkdirSync(sub, { recursive: true });
        skillAt(join(repo, '.claude', 'skills'), 'at-root');
        skillAt(join(sub, '.claude', 'skills'), 'at-sub');
        expect(opencode(sub).status).toBe(0);
        expect(entries()).toEqual(['at-root', 'at-sub', 'ws-a']);
    });

    it('prefers the nearer directory when two repo skills share a name', () => {
        const sub = join(repo, 'packages', 'app');
        skillAt(join(repo, '.claude', 'skills'), 'dup');
        skillAt(join(sub, '.claude', 'skills'), 'dup');
        expect(opencode(sub).status).toBe(0);
        expect(target('dup')).toBe(join(sub, '.claude', 'skills', 'dup'));
    });

    it('does not read above the worktree root', () => {
        skillAt(join(root, '.claude', 'skills'), 'outside');
        expect(opencode(repo).status).toBe(0);
        expect(entries()).toEqual(['ws-a']);
    });

    it('skips an entry without a SKILL.md and a plain file', () => {
        skillAt(join(repo, '.claude', 'skills'), 'empty', false);
        writeFileSync(join(repo, '.claude', 'skills', 'README.md'), 'x');
        expect(opencode(repo).status).toBe(0);
        expect(entries()).toEqual(['ws-a']);
    });

    it('treats a missing skills directory as none, not as an error', () => {
        expect(opencode(repo).status).toBe(0);
        expect(entries()).toEqual(['ws-a']);
    });

    it.skipIf(process.getuid?.() === 0)('refuses a skills directory it cannot read, and does not call it empty', () => {
        skillAt(join(repo, '.claude', 'skills'), 'other');
        chmodSync(join(repo, '.claude', 'skills'), 0o000);
        try {
            const got = opencode(repo);
            expect(got.status).toBe(REFUSED);
            expect(got.stderr.trim().split('\n')).toHaveLength(1);
        } finally {
            chmodSync(join(repo, '.claude', 'skills'), 0o755);
        }
    });

    it('never replaces a built-in entry already in the view', () => {
        symlinkSync('/usr/local/share/factory-skills/factory-fix', join(view, 'factory-fix'));
        skillAt(join(repo, '.claude', 'skills'), 'factory-fix');
        expect(opencode(repo).status).toBe(0);
        expect(target('factory-fix')).toBe('/usr/local/share/factory-skills/factory-fix');
    });

    it('refuses a bad list before reading the checkout', () => {
        skillAt(join(repo, '.claude', 'skills'), 'other');
        expect(opencode(repo, { FACTORY_WORKSPACE_SKILLS: 'factory-x' }).status).toBe(REFUSED);
        expect(entries()).toEqual([]);
    });

    it('refuses a missing workdir or worktree root argument', () => {
        const got = run(['opencode', view], { FACTORY_WORKSPACE_SKILLS: 'ws-a' });
        expect(got.status).toBe(REFUSED);
        expect(entries()).toEqual([]);
    });
});

describe('arguments', () => {
    it('refuses an unknown mode', () => {
        expect(run(['codex', view], { FACTORY_WORKSPACE_SKILLS: 'ws-a' }).status).toBe(REFUSED);
    });
});
