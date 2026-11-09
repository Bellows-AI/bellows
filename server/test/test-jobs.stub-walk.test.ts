import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MASTER_PROMPT_LIMIT } from '../src/db/master-prompt.js';
import { boundedTail, tailMatches } from '../src/db/workflows/workflow-schema.js';

/*
 * The workflows phase walks `stub-walk` with the OK stub, whose output is its own argv: each node's output
 * is interpolated into the next prompt, and the board keeps only the head of an interpolated output
 * (INTERP_TAIL_LIMIT). An argv that grows (a hidden skill's `--settings` deny) once pushed the fix node's
 * marker past that cut and the thread rested before publish. This runs the stub's exact shell over the
 * walk with the largest master prompt the board sends, so the margin is measured here, not in the lane.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = readFileSync(join(ROOT, 'scripts/test-jobs.sh'), 'utf8');

const stubCommand = (): string => {
    const line = SCRIPT.split('\n').find((l) => l.endsWith('>"$work/Dockerfile.ok"'));
    if (!line) throw new Error('no Dockerfile.ok line in scripts/test-jobs.sh');
    const format = line.slice(line.indexOf("'") + 1, line.lastIndexOf("'"));
    const dockerfile = execFileSync('sh', ['-c', 'printf "$1" base', 'sh', format], { encoding: 'utf8' });
    const entrypoint = JSON.parse(dockerfile.split('\n')[1]!.replace(/^ENTRYPOINT /, '')) as string[];
    return entrypoint[entrypoint.indexOf('-c') + 1]!;
};

const walkPrompts = (): Record<string, string> => {
    const start = SCRIPT.indexOf(`cat >"$work/stub-walk.json" <<'JSON'\n`);
    const body = SCRIPT.slice(SCRIPT.indexOf('\n', start) + 1, SCRIPT.indexOf('\nJSON\n', start));
    const nodes = (JSON.parse(body) as { definition: { nodes: { name: string; prompt: string }[] } }).definition.nodes;
    return Object.fromEntries(nodes.map((n) => [n.name, n.prompt]));
};

describe('the stub-walk fixture', () => {
    it('keeps the fix marker inside the interpolation cut with the largest master prompt and a hidden skill', () => {
        const command = stubCommand();
        const prompts = walkPrompts();
        const master = 'm'.repeat(MASTER_PROMPT_LIMIT);
        const outputs: Record<string, string> = {};
        const fill = (template: string) =>
            template.replace(/\{\{(\w+)\.output\}\}/g, (_, node: string) => boundedTail(outputs[node] ?? ''));
        const run = (node: string) => {
            const argv = [
                '--session-id',
                'a-session',
                '--settings',
                '{"permissions":{"deny":["Skill(factory-jira)"]}}',
            ];
            argv.push('--permission-mode', 'auto', '--append-system-prompt', master, '-p', fill(prompts[node]!));
            outputs[node] = execFileSync('sh', ['-c', command, 'sh', ...argv], { encoding: 'utf8' });
            return outputs[node];
        };

        expect(tailMatches(run('review'), 'review the work')).toBe(true);
        run('fix');
        expect(outputs.fix!.length).toBeLessThan(4_096);
        expect(tailMatches(run('review'), 'FIXED-ONE-ROUND')).toBe(true);
    });
});
