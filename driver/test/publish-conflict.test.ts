import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import {
    parseGitState,
    publishCheckout,
    unresolvedConflictReason,
    withConflictContext,
    type PublishStep,
} from '../src/publish/publish.js';

/**
 * Issue #661: a conflict the sync hands to the agent is the agent's to resolve. A publish over a
 * tree that still holds one pushes nothing and reports cause `conflict`, which the batch repairs
 * (core/src/batch-recovery.ts) on the `repairs` budget; it is never infrastructure.
 */
const USER = '11111111-2222-3333-4444-555555555555';
const job = {
    id: '00000001-1111-4111-8111-111111111111',
    command: 'fix it',
    repo: 'acme/app',
    workspacePath: `bellows/${USER}`,
} as BoardJob;

const probeAnswering = (state: Record<string, unknown>) => {
    const labels: string[] = [];
    const run = async (step: PublishStep): Promise<{ stdout: string }> => {
        labels.push(step.label);
        return { stdout: `${JSON.stringify({ cloned: true, branch: 'factory/x', dirty: true, ...state })}\n` };
    };
    return { run, labels };
};

describe('the publish over a conflicted tree (issue #661)', () => {
    it.each([
        ['unmerged paths', { conflicts: ['src/a.ts', 'src/b.ts'], rebasing: false }, 'src/a.ts, src/b.ts'],
        ['a stopped rebase', { conflicts: [], rebasing: true }, 'git rebase --continue'],
    ])('refuses %s with cause conflict and pushes nothing', async (_name, state, text) => {
        const t = probeAnswering(state);

        const result = await publishCheckout(job, undefined, t.run);

        expect(result).toMatchObject({ ok: false, published: false, cause: 'conflict' });
        expect(result.reason).toContain(text);
        expect(t.labels).toEqual(['probe']);
    });

    it('reads the probe fields, and a probe that names none as a clean tree', () => {
        expect(parseGitState(JSON.stringify({ cloned: true, conflicts: ['a'], rebasing: true }))).toMatchObject({
            conflicts: ['a'],
            rebasing: true,
        });
        expect(parseGitState(JSON.stringify({ cloned: true }))).toMatchObject({ conflicts: [], rebasing: false });
        expect(unresolvedConflictReason({ conflicts: [], rebasing: false })).toContain('merge conflict');
    });
});

describe('the conflict turn context', () => {
    it('names the paths and keeps the board’s own context first', () => {
        const text = withConflictContext('Factory turn context\n- gates', ['src/a.ts', 'src/b.ts']);

        expect(text.startsWith('Factory turn context\n- gates')).toBe(true);
        expect(text).toContain('- src/a.ts\n- src/b.ts');
        expect(text).toContain('git rebase --continue');
    });

    it('stands alone when the board sent none', () => {
        expect(withConflictContext(undefined, ['x'])).toMatch(/^Merge conflict left in the worktree/);
    });
});
