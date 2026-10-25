import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { gitHardenScript } from '../src/container-scripts.js';
import { supervisorLiterals } from '../src/supervisor-plan.js';
import { SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import { boardJob } from './fixtures/board-job.js';
import { readRepoFile } from './fixtures/repo-files.js';

/*
 * Every driver-side step reaches `git` through the supervisor's hardened one (`scripts/git-harden.cjs`,
 * pinned vector by vector in git-harden.test.ts). This pins the seams that carry it: both executors
 * hand the supervisor the script, the supervisor puts it first on each step's PATH, and no helper
 * script names a git of its own or moves PATH out from under it.
 */
process.env.SUPERVISOR_NO_MAIN = '1';
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '../src/scripts');
const config = loadDriverConfig({} as NodeJS.ProcessEnv);

describe('the hardened git of the supervisor’s steps', () => {
    it('is handed to the supervisor of every group shape, by content', () => {
        const job = { ...boardJob(), repo: 'acme/widgets' } as BoardJob;
        const shapes = [
            { exporting: true },
            { exporting: false, agentless: true },
            { exporting: false, gated: true },
            { exporting: false, reviewing: true },
        ];

        for (const shape of shapes) {
            const env = Object.fromEntries(supervisorLiterals(config, job, shape));
            expect(env[SUPERVISOR_ENV.gitHardenScript]).toBe(gitHardenScript);
        }
        expect(gitHardenScript).toBe(readFileSync(join(SCRIPTS, 'git-harden.cjs'), 'utf8'));
    });

    it('is the supervisor env both executors build: docker and kubernetes share one literal list', () => {
        expect(readRepoFile('driver/src/docker/docker-group.ts')).toContain('supervisorLiterals(config, job, group)');
        expect(readRepoFile('driver/src/k8s/k8s-podspec.ts')).toContain('supervisorLiterals(config, job, group)');
    });

    it('is the `git` a step resolves first, and the script the env carried is the one that runs', async () => {
        const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
            settingsOf(env: Record<string, string>): unknown;
            spawnStep(
                run: unknown,
                step: { argv: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }
            ): Promise<{ result: { exitCode: number; stdout: string } }>;
        };
        const stub = '// stub\nconsole.log("hardened:" + process.argv.slice(2).join(" "));\n';
        const run = {
            settings: supervisor.settingsOf({
                ...process.env,
                [SUPERVISOR_ENV.gitHardenScript]: stub,
            } as Record<string, string>),
            stop: new AbortController(),
            inflight: null,
        };

        const { result } = await supervisor.spawnStep(run, {
            argv: ['sh', '-c', 'git --version; command -v git'],
            cwd: '/',
            env: {},
            timeoutMs: 20_000,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('hardened:--version');
        expect(result.stdout).toMatch(/factory-git-[^/]+\/git\n$/);
    });

    it('is not undone by a step’s own env: PATH and the real git are the supervisor’s last word', async () => {
        const supervisor = createRequire(import.meta.url)('../src/scripts/supervisor.cjs') as {
            settingsOf(env: Record<string, string>): unknown;
            spawnStep(
                run: unknown,
                step: { argv: string[]; cwd: string; env: Record<string, string>; timeoutMs: number }
            ): Promise<{ result: { stdout: string } }>;
        };
        const run = {
            settings: supervisor.settingsOf({ ...process.env } as Record<string, string>),
            stop: new AbortController(),
            inflight: null,
        };

        const { result } = await supervisor.spawnStep(run, {
            argv: ['/bin/sh', '-c', 'command -v git'],
            cwd: '/',
            env: { PATH: '/nonexistent' },
            timeoutMs: 20_000,
        });

        // The step asked for a PATH with no git on it; the shim dir is still in front of what it named.
        expect(result.stdout).toMatch(/factory-git-[^/]+\/git\n$/);
    });

    it('is reached by name: no helper script runs an absolute git, and none replaces PATH', () => {
        const files = readdirSync(SCRIPTS).filter((name) => /\.(cjs|sh)$/.test(name) && name !== 'git-harden.cjs');
        const offenders = files.filter((name) => {
            const text = readFileSync(join(SCRIPTS, name), 'utf8');
            return /\/(usr\/)?(local\/)?bin\/git\b/.test(text) || /\bPATH\s*[:=]\s*['"`$]/.test(text);
        });

        // The supervisor itself sets PATH for its children, which is the point.
        expect(offenders).toEqual(['supervisor.cjs']);
    });
});
