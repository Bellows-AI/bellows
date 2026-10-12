import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { batchExecutionCapability, resolveBatchPlan, validateBatchPlan } from '../src/batch-plan.js';

/**
 * The batch-control skill is an instruction artifact, and its example plan is what a session copies
 * before it writes one of its own. Nothing compiles either, so this file is what keeps them on the
 * contract: the example must validate and be startable, every route the skill names must be one the
 * board registers, and every CLI verb one the CLI's usage lists.
 */

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

const skill = read('../../.claude/skills/batch-control/SKILL.md');
const example: unknown = JSON.parse(read('../../.claude/skills/batch-control/plan.example.json'));
const routes = read('../../server/src/routes/batches.ts');
const usage = read('../../cli/src/usage.ts');

describe('the batch-control skill', () => {
    it('is named after its directory and points at its sibling skills', () => {
        expect(skill).toMatch(/^---\nname: batch-control\n/);
        expect(skill).toContain('task-control');
        expect(skill).toContain('investigate-task');
    });

    it('ships an example plan that validates and that start would accept', () => {
        const result = validateBatchPlan(example);
        expect(result).toMatchObject({ ok: true });
        if (!result.ok) return;
        const defaults = { 'owner/name': 'main' };
        const resolved = resolveBatchPlan(result.plan, defaults);
        expect(batchExecutionCapability(resolved, defaults, { canMerge: false })).toEqual({ ok: true });
        // Two stages, the first with parallel tasks: the shape the skill tells a session to copy.
        expect(result.plan.stages.length).toBeGreaterThan(1);
        expect(result.plan.stages[0]!.tasks.length).toBeGreaterThan(1);
    });

    it('names only batch routes the board registers', () => {
        const named = [...skill.matchAll(/(GET|POST|PUT) (\/api\/batches[^\s`)]*)/g)];
        expect(named.length).toBeGreaterThan(0);
        for (const [, method, path] of named) {
            const fastify = path!.replace(/<id>/g, ':id').replace(/<task>/g, ':key');
            expect(routes).toContain(`app.${method!.toLowerCase()}('${fastify}'`);
        }
    });

    it('uses only CLI verbs the usage lists, through the one npm layer', () => {
        const verbs = [...skill.matchAll(/npm run dev -w cli -- (batch|job) ([a-z-]+)/g)];
        expect(verbs.length).toBeGreaterThan(0);
        for (const [, noun, verb] of verbs) expect(usage).toContain(`factory ${noun} ${verb} `);
        expect(skill).not.toMatch(/^factory batch /m);
        expect(skill).not.toMatch(/npm run cli -- batch/);
    });

    it('reads the same wait exit codes the usage promises', () => {
        for (const sentence of ['0 when every task succeeded', '4 when one failed', '5 when cancelled or expired']) {
            expect(usage).toContain(sentence);
        }
        for (const row of ['| `0` |', '| `3` |', '| `4` |', '| `5` |', '| `6` |', '| `7` |']) {
            expect(skill).toContain(row);
        }
    });

    it('reads a failed stage verification, which no task names, and waits again after a merge', () => {
        // Both were found driving a real batch: a red check on the target tip held the next stage
        // with every task's `next` at `none`, and a merge takes a poll to be observed.
        expect(skill).toContain("The report's `verification`");
        expect(skill).toContain('never retry a task for it');
        expect(skill).toContain('means wait again');
    });

    it('confirms with the user before start and cancel, and never merges or answers on its own', () => {
        const start = skill.slice(skill.indexOf('## 3. Start'));
        expect(start).toMatch(/^## 3\. Start\n\nConfirm with the user/);
        expect(skill.slice(skill.indexOf('## 6. Cancel'))).toContain('Confirm with the user');
        expect(skill).toContain('never merge for them');
        expect(skill).toContain('Never invent an answer');
    });

    it('ships generic config only — no personal host, no pasted credential', () => {
        expect(skill).not.toContain('JOB_BOARD_TOKEN');
        expect(skill).not.toMatch(/fat_[A-Za-z0-9]{8,}/);
        expect(skill).not.toMatch(/https?:\/\//);
        expect(JSON.stringify(example)).toContain('"owner/name"');
    });
});
