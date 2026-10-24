import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PACKAGES = ['core', 'server', 'web', 'driver', 'cli'];
const TEST_FILE = /\.test\.tsx?$/;

const read = (file: string) => readFileSync(join(root, file), 'utf8');
const spawnList = () => (JSON.parse(read('vitest.spawn-tests.json')) as { tests: string[] }).tests;

/** Every file under `<pkg>/test`, as a repo-relative path. */
const testTreeFiles = (): string[] =>
    PACKAGES.flatMap((pkg) =>
        existsSync(join(root, pkg, 'test'))
            ? readdirSync(join(root, pkg, 'test'), { recursive: true, withFileTypes: true })
                  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
                  .map((entry) => relative(root, join(entry.parentPath, entry.name)))
            : []
    ).sort();

/** The relative imports of `file` that resolve to another file of the test tree. */
const relativeImports = (file: string, tree: Set<string>): string[] =>
    [...read(file).matchAll(/(?:from|import\()\s*'(\.[^']*)'/g)].flatMap(([, specifier = '']) => {
        const target = relative(root, join(root, dirname(file), specifier.replace(/\.js$/, '')));
        return [`${target}.ts`, `${target}.tsx`, join(target, 'index.ts')].filter((candidate) => tree.has(candidate));
    });

/** A test file spawns when it, or a test-tree helper it imports, imports `child_process`. */
const spawningTests = (): string[] => {
    const files = testTreeFiles();
    const tree = new Set(files);
    const memo = new Map<string, boolean>();
    const spawns = (file: string, path: Set<string>): boolean => {
        const known = memo.get(file);
        if (known !== undefined) return known;
        if (path.has(file)) return false;
        const found =
            /child_process/.test(read(file)) ||
            relativeImports(file, tree).some((dep) => spawns(dep, new Set([...path, file])));
        memo.set(file, found);
        return found;
    };
    return files.filter((file) => TEST_FILE.test(file) && spawns(file, new Set()));
};

interface Listed {
    file: string;
    projectName: string;
}

/** The files vitest itself resolves per project from `vitest.config.ts`, no test run. */
const listProjects = (): Promise<Listed[]> =>
    new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [join(root, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json'],
            {
                cwd: root,
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (status) => {
            if (status !== 0) return reject(new Error(`vitest list exited ${status}: ${stderr}`));
            const listed = (JSON.parse(stdout) as Listed[]).map((entry) => ({
                ...entry,
                file: relative(root, entry.file),
            }));
            resolve(listed);
        });
    });

describe('vitest projects', () => {
    it('lists exactly the files that spawn a process in the spawn tier', () => {
        expect(spawnList()).toEqual([...spawnList()].sort());
        expect(spawnList()).toEqual(spawningTests());
    });

    it('runs every test file of the tree in exactly one project', async () => {
        const onDisk = testTreeFiles().filter((file) => TEST_FILE.test(file));
        const listed = await listProjects();
        expect(listed.map((entry) => entry.file).sort()).toEqual(onDisk);
    });

    it('keeps the spawn tier and the package projects apart', async () => {
        const listed = await listProjects();
        const spawnProject = listed.filter((entry) => entry.projectName === 'spawn').map((entry) => entry.file);
        expect(spawnProject.sort()).toEqual(spawnList());
        const packageOf = (file: string) => file.split('/')[0];
        for (const entry of listed.filter((item) => item.projectName !== 'spawn')) {
            expect(spawnList()).not.toContain(entry.file);
            expect(entry.projectName === 'dom' ? 'web' : entry.projectName).toBe(packageOf(entry.file));
        }
    });
});
