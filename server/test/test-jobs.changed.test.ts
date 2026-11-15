import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readLaneScript } from './fixtures/lane-script.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MAP = join(ROOT, 'scripts/test-jobs-changed.mjs');
const SCRIPT = readLaneScript('scripts/test-jobs.sh');

interface Decision {
    file: string;
    result: string | string[];
    reason: string;
    unmapped: boolean;
}
interface Verdict {
    selected: string | string[];
    decisions: Decision[];
}

// The CLI is the contract the lane uses, so the tests drive it, not a re-implementation of it.
function classify(files: string[]): Verdict {
    const out = spawnSync('node', [MAP, '--files', '--json'], { input: files.join('\n'), encoding: 'utf8' });
    expect(out.status).toBe(0);
    return JSON.parse(out.stdout) as Verdict;
}

function tracked(...dirs: string[]): string[] {
    return execFileSync('git', ['ls-files', ...dirs], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
}

// The phases test-jobs.sh accepts, read from its own validator so the two lists cannot drift.
function scriptPhases(): string[] {
    const body = /valid_phase\(\) \{\n {4}case "\$1" in\n {4}([^)]+)\) return 0/.exec(SCRIPT)?.[1];
    expect(body).toBeDefined();
    return (body ?? '').split('|');
}

describe('test-jobs phase lists', () => {
    // The services phase leaves a malformed plan behind, so node-disruption must write its own
    // before its first driver starts rather than rely on whatever ran earlier in a list.
    it('has node-disruption write its stub-svc plan before its first driver', () => {
        const phase = SCRIPT.slice(SCRIPT.indexOf('begin_phase node-disruption\n'));
        expect(phase.indexOf('write_bellows "services:\n  - name: stub-svc')).toBeGreaterThan(0);
        expect(phase.indexOf('write_bellows "services:')).toBeLessThan(phase.indexOf('\ndisruption_driver\n'));
    });
});

describe('test-jobs --changed path-to-phase map', () => {
    const ranges = tracked('driver/src', 'docker', 'scripts', 'server/src', 'server/migrations', 'core/src');

    it('lists exactly the phases the script accepts, in the order it runs them', async () => {
        const { PHASES } = (await import(MAP)) as { PHASES: string[] };
        expect([...PHASES].sort()).toEqual([...scriptPhases()].sort());
        const order = PHASES.map((phase) => SCRIPT.indexOf(`selected_phase ${phase}; then\nbegin_phase ${phase}\n`));
        expect(order.every((at) => at > 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('reaches every phase from some rule', async () => {
        const { PHASES, RULES } = (await import(MAP)) as { PHASES: string[]; RULES: [RegExp, unknown, string][] };
        const reached = new Set(RULES.flatMap(([, result]) => (Array.isArray(result) ? (result as string[]) : [])));
        expect(PHASES.filter((phase) => !reached.has(phase))).toEqual([]);
    });

    it('maps every tracked source path under driver/src, docker/, scripts/, server/ and core/ with a rule, not the fallback', () => {
        expect(ranges.length).toBeGreaterThan(500);
        const verdict = classify(ranges);
        expect(verdict.decisions.filter((decision) => decision.unmapped).map((decision) => decision.file)).toEqual([]);
    });

    it('keeps no rule that matches nothing tracked', async () => {
        const { RULES } = (await import(MAP)) as { RULES: [RegExp, unknown, string][] };
        const all = tracked();
        expect(
            RULES.filter(([pattern]) => !all.some((file) => pattern.test(file))).map(([pattern]) => String(pattern))
        ).toEqual([]);
    });

    it('sends the shared files to the full lane', () => {
        for (const file of [
            'scripts/test-jobs.sh',
            'scripts/stub-agent.sh',
            'scripts/stub-runner.Dockerfile',
            'scripts/test-jobs-changed.mjs',
            'docker/executor-common/ctl-agent.cjs',
            'docker/executor-common/factory-launch.sh',
            'driver/src/scripts/supervisor.cjs',
            'driver/src/runner.ts',
            'server/src/main.ts',
            'docker-compose.yml',
            'package-lock.json',
            'Makefile',
        ]) {
            expect(classify([file]).selected, file).toBe('full');
        }
    });

    it('runs the full lane for the board boot, the job and claim path, core and a migration', () => {
        for (const file of [
            'server/src/routes/jobs/jobs.ts',
            'server/src/db/jobs/job-store-claim.ts',
            'server/src/db/workflows/workflow-engine.ts',
            'server/src/orgs.ts',
            'server/src/stats-service.ts',
            'server/src/notifications/delivery-loop.ts',
            'server/src/notifications/outbox-store.ts',
            'server/src/routes/github-credential.ts',
            'server/src/skill-catalog.ts',
            'server/src/db/skill-store.ts',
            'server/src/integrations/credential-resolver.ts',
            'core/src/executors.ts',
            'server/migrations/006_jobs.sql',
        ]) {
            expect(classify([file]).selected, file).toBe('full');
        }
    });

    it('selects nothing for a web-only diff', () => {
        expect(classify(['web/src/panels/TaskRun.tsx']).selected).toEqual([]);
    });

    it('selects nothing for an org-settings route or store diff', () => {
        for (const file of [
            'server/src/routes/org-members.ts',
            'server/src/routes/org-retention.ts',
            'server/src/routes/org-export.ts',
            'server/src/db/org-export.ts',
        ]) {
            expect(classify([file]).selected, file).toEqual([]);
        }
    });

    it('selects nothing for commerce, batches, the documentation site or a route no phase calls', () => {
        for (const file of [
            'server/src/commerce/commerce-loop.ts',
            'server/src/db/commerce-store.ts',
            'server/src/routes/commerce.ts',
            'server/src/db/batches/batch-store.ts',
            'server/src/routes/batches/batches.ts',
            'server/src/routes/tokens.ts',
            'server/src/routes/webhook.ts',
            'server/src/seed/cli.ts',
            'site/docs.json',
        ]) {
            expect(classify([file]).selected, file).toEqual([]);
        }
    });

    it('maps the stored-skill publish routes to the pinned-skills phase alone', () => {
        expect(classify(['server/src/routes/skills-store.ts']).selected).toEqual(['pinned-skills']);
        expect(classify(['server/src/skills/skill-collector.ts']).selected).toEqual(['pinned-skills']);
    });

    // question-round-trip.sh and pinned-skills.sh seed a grant through server/dist/db/connection-grants.js and bind it
    // through /api/jobs/:id/connections; the runner's broker reads it through /api/jobs/:id/credentials/connections.
    it('maps connections and their credentials to the phases that seed and read one', () => {
        for (const file of [
            'server/src/db/connection-grants.ts',
            'server/src/db/connection-store.ts',
            'server/src/routes/connection-credential.ts',
            'server/src/integrations/authorization-store.ts',
        ]) {
            expect(classify([file]).selected, file).toEqual([
                'github-credential',
                'question-round-trip',
                'pinned-skills',
            ]);
        }
    });

    it('maps a route one phase calls to that phase', () => {
        expect(classify(['server/src/routes/workflows.ts']).selected).toEqual(['workflows']);
        expect(classify(['server/src/routes/repos.ts']).selected).toEqual(['mcp']);
        expect(classify(['server/src/oauth/cimd-fetch.ts']).selected).toEqual(['mcp']);
        expect(classify(['server/src/routes/agent-title.ts']).selected).toEqual([
            'tool-isolation',
            'question-round-trip',
        ]);
        expect(classify(['server/src/offline-mint.ts']).selected).toEqual(['github-credential']);
    });

    it('falls back to the full lane on a path it does not know, and says so', () => {
        const verdict = classify(['driver/src/brand-new-module.ts']);
        expect(verdict.selected).toBe('full');
        expect(verdict.decisions[0]).toMatchObject({ unmapped: true, reason: 'unmapped path' });
    });

    it('maps a loop-adopt change to its recovery phases only, in lane order', () => {
        expect(classify(['driver/src/loop/loop-adopt.ts', 'driver/test/loop-adopt.test.ts']).selected).toEqual([
            'node-disruption',
            'driver-kill',
        ]);
    });

    it('maps an MCP server or OAuth change to the mcp phase alone, ahead of the broad auth rule', () => {
        expect(classify(['server/src/mcp/tools/task-wait.ts']).selected).toEqual(['mcp']);
        expect(classify(['server/src/auth/oauth-store.ts']).selected).toEqual(['mcp']);
        expect(classify(['server/src/auth/session.ts']).selected).toEqual(['board', 'auth']);
    });

    it('maps every file outside the lane inputs that a phase executes to that phase', () => {
        expect(classify(['e2e/stub-idp.mjs']).selected).toEqual(['mcp']);
        expect(classify(['scripts/mcp-phase-client.mjs']).selected).toEqual(['mcp']);
        expect(classify(['e2e/mcp-connect.spec.ts']).selected).toEqual([]);
        expect(classify(['scripts/mcp-kind-client.mjs']).selected).toEqual([]);
    });

    it('runs the image-checks phase for an executor image file and for either image check script', () => {
        for (const file of [
            'docker/claude-executor/test.sh',
            'docker/opencode-executor/test.sh',
            'docker/claude-executor/entrypoint.sh',
            'docker/opencode-executor/Dockerfile',
        ]) {
            expect(classify([file]).selected).toContain('image-checks');
        }
    });

    it('runs the repo-skills phase for either executor image and for the scripted model endpoint', () => {
        for (const file of [
            'docker/claude-executor/entrypoint.sh',
            'docker/opencode-executor/Dockerfile',
            'scripts/fake-model-endpoint.mjs',
        ]) {
            expect(classify([file]).selected).toContain('repo-skills');
        }
    });

    it('maps the GitHub credential helpers to its phase and to both images’ phases', () => {
        for (const file of ['github-credential.cjs', 'credential-broker.cjs']) {
            expect(classify([`docker/executor-common/${file}`]).selected).toEqual(
                expect.arrayContaining(['github-credential', 'cooperative-stop', 'tool-isolation', 'image-checks'])
            );
        }
    });

    it('unions the phases of several files and ignores files no lane executes', () => {
        expect(
            classify(['driver/src/run-deadline.ts', 'driver/src/k8s/k8s-runner.ts', 'docs/jobs.md', 'web/src/App.tsx'])
                .selected
        ).toEqual(['run-deadline']);
    });

    it('selects acceptance for the stub agent it builds, while other kubernetes-only scripts select nothing', () => {
        expect(classify(['scripts/k8s-stub.sh']).selected).toEqual(['acceptance']);
        expect(classify(['scripts/k8s-local-values.mjs']).selected).toEqual([]);
    });

    it('selects nothing when only unexecuted files changed, and when nothing changed', () => {
        expect(classify(['docs/executor-testing.md', 'driver/src/k8s/k8s-gate.ts']).selected).toEqual([]);
        expect(classify([]).selected).toEqual([]);
    });

    it('prints the choice and why on stderr and the bare list on stdout', () => {
        const out = spawnSync('node', [MAP, '--files'], { input: 'driver/src/run-deadline.ts\n', encoding: 'utf8' });
        expect(out.stdout).toBe('run-deadline');
        expect(out.stderr).toContain('[changed] driver/src/run-deadline.ts -> run-deadline (run deadline)');
        expect(out.stderr).toContain('[changed] phases: run-deadline');
        const none = spawnSync('node', [MAP, '--files'], { input: '', encoding: 'utf8' });
        expect(none.stdout).toBe('');
        expect(none.stderr).toContain('no changed files');
    });

    it('selects publish changes into the recovery phase that checks a repeated push', () => {
        expect(classify(['driver/src/publish/publish-pr.ts']).selected).toEqual([
            'driver',
            'driver-kill',
            'compose-driver',
        ]);
    });

    // A rename reports only its destination by default, which would hide a file leaving driver/src.
    it('counts both ends of a rename read from real git', () => {
        const repo = mkdtempSync(join(tmpdir(), 'jobs-changed-'));
        try {
            const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
            git('init', '-q');
            mkdirSync(join(repo, 'driver/src/loop'), { recursive: true });
            mkdirSync(join(repo, 'cli/src'), { recursive: true });
            writeFileSync(join(repo, 'driver/src/loop/loop-adopt.ts'), 'export const adopt = 1;\n'.repeat(20));
            git('add', '.');
            git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'seed');
            renameSync(join(repo, 'driver/src/loop/loop-adopt.ts'), join(repo, 'cli/src/loop-adopt.ts'));
            git('add', '-A');
            const out = spawnSync('node', [MAP, 'HEAD'], { cwd: repo, encoding: 'utf8' });
            expect(out.stdout).toBe('node-disruption,driver-kill');
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });
});
