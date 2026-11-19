import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The real `scripts/test-changed.mjs` in a throwaway repository: which base a task is measured against
 * decides what the gates run. Tree: two store modules, each imported by one DB suite.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/test-changed.mjs', import.meta.url));

interface Planned {
    changed: string[];
    steps: { label: string; run?: string[]; vitest?: string[] }[];
}

let repo: string;
let env: NodeJS.ProcessEnv;

const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
        cwd: repo,
        env,
        encoding: 'utf8',
    }).trim();
const write = (file: string, text: string) => {
    mkdirSync(join(repo, dirname(file)), { recursive: true });
    writeFileSync(join(repo, file), text);
};
const commit = (file: string, text: string) => {
    write(file, text);
    git('add', file);
    git('commit', '-q', '-m', `change ${file}`);
};
const selector = (...args: string[]) => spawnSync('node', [SCRIPT, ...args], { cwd: repo, env, encoding: 'utf8' });
const planned = (...args: string[]): Planned => {
    const result = selector(...args, '--plan');
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Planned;
};
const dbRuns = (out: Planned) => out.steps.map((step) => step.run?.join(' '));

beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'test-changed-git-'));
    env = {
        PATH: process.env.PATH,
        HOME: repo,
        GIT_CONFIG_GLOBAL: join(repo, '.gitconfig-none'),
        GIT_CONFIG_NOSYSTEM: '1',
    };
    git('init', '-q', '-b', 'main');
    write('server/test-db/harness.ts', 'export const harness = 1;\n');
    write('server/test-db/a.test.ts', "import { a } from '../src/db/a.js';\n");
    write('server/test-db/b.test.ts', "import { b } from '../src/db/b.js';\n");
    write('server/src/db/a.ts', 'export const a = 1;\n');
    write('server/src/db/b.ts', 'export const b = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'tree');
    git('checkout', '-q', '-b', 'project-x');
    commit('server/src/db/b.ts', 'export const b = 2;\n');
    git('checkout', '-q', '-b', 'task');
    commit('server/src/db/a.ts', 'export const a = 2;\n');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('update-ref', 'refs/remotes/origin/project-x', 'project-x');
});

describe('test:changed --db against a real repository', () => {
    it('measures a task on a project branch against that branch, not main', () => {
        const out = planned('origin/project-x', '--db');
        expect(out.changed).toEqual(['server/src/db/a.ts']);
        expect(dbRuns(out)).toEqual(['npm run test:db -- server/test-db/a.test.ts']);
    });

    it('measures the same task against main as the project branch plus the task', () => {
        const out = planned('origin/main', '--db');
        expect(dbRuns(out)).toEqual(['npm run test:db -- server/test-db/a.test.ts server/test-db/b.test.ts']);
    });

    it("charges a follow-up with its parent's unmerged commits", () => {
        commit('docs/x.md', '# x\n');
        const out = planned('origin/main', '--db');
        expect([...out.changed].sort()).toEqual(['docs/x.md', 'server/src/db/a.ts', 'server/src/db/b.ts']);
        expect(dbRuns(out)).toEqual(['npm run test:db -- server/test-db/a.test.ts server/test-db/b.test.ts']);
    });

    it('does not charge a task with commits its base gained after it branched', () => {
        git('checkout', '-q', 'main');
        commit('server/migrations/001.sql', 'select 1;\n');
        git('update-ref', 'refs/remotes/origin/main', 'main');
        git('checkout', '-q', 'task');
        const out = planned('origin/main', '--db');
        expect(out.changed).not.toContain('server/migrations/001.sql');
        expect(dbRuns(out)).toEqual(['npm run test:db -- server/test-db/a.test.ts server/test-db/b.test.ts']);
    });

    it('runs the whole DB suite for a migration on the branch', () => {
        commit('server/migrations/001.sql', 'select 1;\n');
        expect(dbRuns(planned('origin/project-x', '--db'))).toEqual(['npm run test:db']);
    });

    it('plans no step when nothing reaches a DB suite', () => {
        commit('docs/x.md', '# x\n');
        git('update-ref', 'refs/remotes/origin/task', 'task~1');
        expect(planned('origin/task', '--db').steps).toEqual([]);
    });

    it('fails, printing no plan, when the base does not resolve', () => {
        const result = selector('origin/gone', '--db', '--plan');
        expect(result.status).not.toBe(0);
        expect(result.stdout).toBe('');
    });

    it('measures unit mode from the merge base with the given base', () => {
        const out = planned('origin/project-x');
        const graph = out.steps.find((step) => step.vitest?.includes('--changed'))?.vitest ?? [];
        expect(graph[graph.indexOf('--changed') + 1]).toBe(git('merge-base', 'origin/project-x', 'HEAD'));
    });
});
