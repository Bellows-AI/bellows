import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
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

const EMPTY_COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

// A call outside any nested function: code that runs when the enclosing statement does, not when a closure is invoked.
// An empty collection's construction is not work.
function callsNow(node: ts.Node): boolean {
    if (ts.isFunctionLike(node)) return false;
    if (ts.isNewExpression(node) && EMPTY_COLLECTIONS.has(node.expression.getText()) && !node.arguments?.length) {
        return false;
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) return true;
    return ts.forEachChild(node, callsNow) ?? false;
}

const ROUTE_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'route', 'all']);

// `app.get(path, handler)` and the like: a plain declaration, whose handler runs per request.
function declaresRoute(statement: ts.Statement): boolean {
    if (!ts.isExpressionStatement(statement)) return false;
    let call = statement.expression;
    if (ts.isAwaitExpression(call)) call = call.expression;
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
    const { expression, name } = call.expression;
    return (
        ['app', 'scope'].includes(expression.getText()) && ROUTE_VERBS.has(name.text) && !call.arguments.some(callsNow)
    );
}

/** The server/src files whose Fastify plugin body (a function taking `app`) runs a call at registration. */
function registerTimeWork(): string[] {
    const found: string[] = [];
    for (const file of tracked('server/src').filter((f) => f.endsWith('.ts'))) {
        const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
        let works = false;
        const visit = (node: ts.Node): void => {
            const first = ts.isFunctionLike(node) ? node.parameters[0] : undefined;
            const body = ts.isFunctionLike(node) && 'body' in node ? node.body : undefined;
            const plugin =
                first !== undefined &&
                (['app', 'scope'].includes(first.name.getText()) || first.type?.getText() === 'FastifyInstance');
            if (plugin && body && ts.isBlock(body)) {
                works ||= body.statements.some(
                    (st) => !ts.isFunctionDeclaration(st) && !declaresRoute(st) && callsNow(st)
                );
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        if (works) found.push(file);
    }
    return found;
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

    // Every board phase boots the board, so what the boot runs is full. The loops: each module server/src/main.ts takes a
    // start* function from. A loop main.ts starts only behind a flag one phase sets is listed here with that flag.
    it('runs the full lane for every loop server/src/main.ts starts', () => {
        const flagged: Record<string, string> = { 'server/src/auth/oauth-sweep.ts': 'MCP_ENABLED, the mcp phase' };
        const main = readFileSync(join(ROOT, 'server/src/main.ts'), 'utf8');
        const loops = [...main.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([^']+)\.js'/g)]
            .filter(([, names]) => /\bstart[A-Z]/.test(names ?? ''))
            .map(([, , path]) => `server/src/${path}.ts`);
        expect(loops.length).toBeGreaterThan(10);
        for (const file of loops.filter((f) => !(f in flagged))) expect(classify([file]).selected, file).toBe('full');
        // What the integration recovery pass runs: the integration modules and the grants it re-reads.
        for (const file of ['server/src/integrations/authorization-store.ts', 'server/src/db/connection-grants.ts']) {
            expect(classify([file]).selected, file).toBe('full');
        }
    });

    // Registration runs at boot; only a handler body runs per request. A route file whose plugin body calls something
    // besides declaring routes is full, unless its plugin is registered only behind a flag one phase sets.
    it('runs the full lane for every route file that does work at registration', () => {
        const flagged = /^server\/src\/(routes\/oauth[a-z-]*|mcp\/routes)\.ts$/; // registered only with MCP_ENABLED (app.ts)
        const working = registerTimeWork();
        expect(working).toContain('server/src/routes/skills.ts');
        for (const file of working.filter((f) => !flagged.test(f)))
            expect(classify([file]).selected, file).toBe('full');
    });

    it('selects nothing for a web-only diff', () => {
        expect(classify(['web/src/panels/TaskRun.tsx']).selected).toEqual([]);
    });

    it('selects nothing for an org-settings route or store diff', () => {
        for (const file of [
            'server/src/routes/org-members.ts',
            'server/src/routes/org-retention.ts',
            'server/src/db/org-export.ts',
        ]) {
            expect(classify([file]).selected, file).toEqual([]);
        }
    });

    it('selects nothing for commerce, batches, the documentation site or a route no phase calls', () => {
        for (const file of [
            'server/src/commerce/commerce-client.ts',
            'server/src/db/commerce-store.ts',
            'server/src/routes/commerce.ts',
            'server/src/db/batches/batch-store.ts',
            'server/src/routes/batches/batch-handlers.ts',
            'server/src/routes/tokens.ts',
            'server/src/routes/audit.ts',
            'server/src/seed/cli.ts',
            'site/docs.json',
        ]) {
            expect(classify([file]).selected, file).toEqual([]);
        }
    });

    it('maps the stored-skill bundle and zip readers to the pinned-skills phase alone', () => {
        expect(classify(['server/src/skills/skill-bundle.ts']).selected).toEqual(['pinned-skills']);
        expect(classify(['server/src/skills/skill-zip.ts']).selected).toEqual(['pinned-skills']);
    });

    // question-round-trip.sh and pinned-skills.sh seed a grant and bind it through /api/jobs/:id/connections. The
    // grants and integrations themselves run at boot (integration recovery), so only the connection store stays narrow.
    it('maps the connection store to the phases that seed and bind a connection', () => {
        expect(classify(['server/src/db/connection-store.ts']).selected).toEqual([
            'github-credential',
            'question-round-trip',
            'pinned-skills',
        ]);
    });

    it('maps a route one phase calls to that phase', () => {
        expect(classify(['server/src/routes/workflows.ts']).selected).toEqual(['workflows']);
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

    it('maps an MCP server or OAuth change to the mcp phase alone, ahead of the auth rules', () => {
        expect(classify(['server/src/mcp/tools/task-wait.ts']).selected).toEqual(['mcp']);
        expect(classify(['server/src/auth/oauth-store.ts']).selected).toEqual(['mcp']);
    });

    // Every request, the claim's included, passes the auth plugin, its worker and session checks and the auth store.
    it('runs the full lane for the auth files every request passes through', () => {
        for (const file of [
            'plugin',
            'request-limits',
            'route-class',
            'session',
            'store',
            'worker-auth',
            'driver-credentials',
            'access-token',
            'bridge-binding',
            'membership-guard',
        ]) {
            expect(classify([`server/src/auth/${file}.ts`]).selected, file).toBe('full');
        }
    });

    it('maps GitHub sign-in to the phases that boot an AUTH_MODE=github board, and the credential CLI to nothing', () => {
        expect(classify(['server/src/auth/github.ts']).selected).toEqual(['capacity', 'auth', 'pinned-skills', 'mcp']);
        expect(classify(['server/src/auth/driver-credential-cli.ts']).selected).toEqual([]);
    });

    // The driver asks the board for a GitHub token before every sync, publish and gate (driver/src/board/board.ts).
    it('runs the full lane for the driver GitHub token ask every task makes', () => {
        for (const file of [
            'driver/src/github-credential-call.ts',
            'driver/src/loop/loop-github.ts',
            'driver/src/scripts/credential-helper.sh',
        ]) {
            expect(classify([file]).selected, file).toBe('full');
        }
    });

    it('runs the connection round trip for a tracker helper or skill change', () => {
        for (const file of ['docker/skills/factory-linear/linear.cjs', 'docker/skills/factory-jira/SKILL.md']) {
            expect(classify([file]).selected).toContain('question-round-trip');
        }
    });

    it('maps every file outside the lane inputs that a phase executes to that phase', () => {
        expect(classify(['e2e/stub-idp.mjs']).selected).toEqual(['mcp']);
        expect(classify(['scripts/mcp-phase-client.mjs']).selected).toEqual(['mcp']);
        expect(classify(['e2e/mcp-connect.spec.ts']).selected).toEqual([]);
        expect(classify(['scripts/mcp-kind-client.mjs']).selected).toEqual([]);
    });

    it('runs every phase for the files a profile connection reaches a claim through', () => {
        for (const file of [
            'server/src/db/provider-connection-store.ts',
            'server/src/db/provider-connection-secrets.ts',
            'server/src/db/jobs/job-store-claim-executor.ts',
            'server/src/db/user-executor-store.ts',
            'server/migrations/168_executor_provider_connection.sql',
            'core/src/model-providers.ts',
            'core/src/provider-connections.ts',
            'server/src/routes/executor-fields.ts',
        ]) {
            expect(classify([file]).selected, file).toBe('full');
        }
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

    it('runs the finish-gate phase for every file the in-run finish pass crosses', () => {
        for (const file of [
            'scripts/lanes/jobs/finish-gate.sh',
            'scripts/fake-model-endpoint.mjs',
            'docker/executor-common/factory-finish.cjs',
            'docker/claude-executor/finish-hook.cjs',
            'docker/claude-executor/claude-home/settings.json',
            'docker/opencode-executor/entrypoint.sh',
            'driver/src/loop/loop-finish.ts',
        ]) {
            expect(classify([file]).selected, file).toContain('finish-gate');
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
