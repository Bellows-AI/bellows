import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { READ_TRANSPORT } from '@factory-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalPlanReader, LOCAL_ORIGINS_DIR } from '../src/github/local-origin-plan.js';

/*
 * The offline board's plan source (issue #799): the `none` arm has no App client, so it reads a
 * repository's `.bellows.yaml` from a bare mirror under `<workspace root>/.origins` — the one the
 * `test:jobs` lane keeps — through the same validation production uses.
 */
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (args: string[], cwd?: string) =>
    execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    }).trim();

/** A bare origin for `owner/name` under a fresh origins dir, with one commit per entry of `commits` on `branch`. */
function mirror(repo: string, commits: (string | null)[], branch = 'main') {
    const dir = mkdtempSync(join(tmpdir(), 'origins-'));
    roots.push(dir);
    const bare = join(dir, `${repo}.git`);
    mkdirSync(bare, { recursive: true });
    git(['init', '-q', '--bare', '-b', branch, bare]);
    const tree = mkdtempSync(join(tmpdir(), 'seed-'));
    roots.push(tree);
    git(['init', '-q', '-b', branch, tree]);
    for (const bellows of commits) {
        if (bellows !== null) {
            writeFileSync(join(tree, '.bellows.yaml'), bellows);
            git(['add', '.bellows.yaml'], tree);
        }
        git(['-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'c'], tree);
    }
    git(['push', '-q', bare, `${branch}:${branch}`], tree);
    return { dir, tip: git(['rev-parse', 'HEAD'], tree) };
}

const SERVICE = 'services:\n  - name: stub-svc\n    image: factory-jobs-smoke-svc\n';
const MALFORMED = 'services:\n  - name: db\n    image: postgres\n    ports: ["5432:5432"]\n';

describe('the local origin plan reader', () => {
    it('reads the plan at the branch tip, pinned to its revision', async () => {
        const { dir, tip } = mirror('acme/web', [null, SERVICE]);

        const plan = await createLocalPlanReader(dir).read('acme/web', 'main');

        expect(plan).toMatchObject({ revision: tip, error: null });
        expect(plan.services.map((service) => service.name)).toEqual(['stub-svc']);
    });

    it('reads the default branch when the thread has no base branch', async () => {
        const { dir, tip } = mirror('acme/web', [SERVICE], 'trunk');

        expect(await createLocalPlanReader(dir).read('acme/web', null)).toMatchObject({ revision: tip, error: null });
    });

    it('answers a malformed file with the refusal production gives', async () => {
        const { dir } = mirror('acme/web', [MALFORMED]);

        const plan = await createLocalPlanReader(dir).read('acme/web', 'main');

        expect(plan.error).toContain('.bellows.yaml');
        expect(plan.services).toEqual([]);
    });

    it('refuses a file over the size the App path refuses', async () => {
        const { dir } = mirror('acme/web', [`${SERVICE}# ${'x'.repeat(70_000)}\n`]);

        expect((await createLocalPlanReader(dir).read('acme/web', 'main')).error).toContain(
            '.bellows.yaml is larger than 65536 bytes'
        );
    });

    it('answers no plan, with the revision, for a commit without the file', async () => {
        const { dir, tip } = mirror('acme/web', [null]);

        expect(await createLocalPlanReader(dir).read('acme/web', 'main')).toMatchObject({
            revision: tip,
            error: null,
            services: [],
            config: null,
        });
    });

    it('refuses a branch the mirror does not have', async () => {
        const { dir } = mirror('acme/web', [SERVICE]);

        expect((await createLocalPlanReader(dir).read('acme/web', 'release')).error).toContain('acme/web');
    });

    it('refuses a revision expression as a branch name instead of resolving it', async () => {
        const { dir } = mirror('acme/web', [SERVICE, null]);

        expect(await createLocalPlanReader(dir).read('acme/web', 'main~1')).toMatchObject({
            revision: null,
            services: [],
            error: expect.stringContaining('acme/web'),
        });
    });

    it('rejects as an outage when the mirror path cannot be checked', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'origins-'));
        roots.push(dir);
        mkdirSync(join(dir, 'acme'));
        symlinkSync('web.git', join(dir, 'acme', 'web.git'));

        await expect(createLocalPlanReader(dir).read('acme/web', 'main')).rejects.toMatchObject({
            kind: READ_TRANSPORT,
        });
    });

    it('rejects as an outage when git cannot read the mirror, for either branch form', async () => {
        const { dir } = mirror('acme/web', [SERVICE]);
        rmSync(join(dir, 'acme/web.git', 'HEAD'));

        for (const branch of ['main', null]) {
            await expect(createLocalPlanReader(dir).read('acme/web', branch)).rejects.toMatchObject({
                kind: READ_TRANSPORT,
            });
        }
    });

    it('rejects as an outage when the branch tip tree cannot be read', async () => {
        const { dir, tip } = mirror('acme/web', [SERVICE]);
        const gitDir = join(dir, 'acme/web.git');
        const tree = git(['--git-dir', gitDir, 'rev-parse', `${tip}^{tree}`]);
        rmSync(join(gitDir, 'objects', tree.slice(0, 2), tree.slice(2)));

        await expect(createLocalPlanReader(dir).read('acme/web', 'main')).rejects.toMatchObject({
            kind: READ_TRANSPORT,
        });
    });

    // Every other offline harness (verify:ui, the route tests) mirrors nothing: there a claim
    // carries no plan, exactly as before the reader existed — never a refusal.
    it('answers no plan and no refusal for a repository nothing mirrored', async () => {
        const { dir } = mirror('acme/web', [SERVICE]);

        expect(await createLocalPlanReader(dir).read('acme/other', 'main')).toMatchObject({
            revision: null,
            error: null,
            services: [],
            config: null,
        });
    });

    it('never resolves a repository label outside the origins dir', async () => {
        const { dir } = mirror('acme/web', [SERVICE]);

        for (const repo of ['../acme/web', 'acme/../acme/web', 'acme', '/etc/passwd']) {
            expect((await createLocalPlanReader(dir).read(repo, 'main')).error).toContain(repo);
        }
    });
});

describe('the offline board wiring', () => {
    it('reads plans from the origins mirror only in the code-only none arm', () => {
        const orgs = readFileSync(new URL('../src/orgs.ts', import.meta.url), 'utf8');
        // The App client first; the mirror only for the none arm; the reader handed to the job store.
        expect(orgs.replace(/\s+/g, ' ')).toContain(
            "const planReader = client ? createPlanReader(client) : config.github.mode === 'none' && config.workspaceRoot ? createLocalPlanReader(join(config.workspaceRoot, LOCAL_ORIGINS_DIR)) : null;"
        );
        expect(orgs).toContain('...(planReader ? { plan: { readFor: planReader.read } } : {}),');
        expect(LOCAL_ORIGINS_DIR).toBe('.origins');
    });
});
