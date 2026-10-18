import { COMMAND_LIMIT } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { type RecapTurn, renderContinuation, renderFollowUpRecap } from '../src/db/follow-up-recap.js';

const turn = (over: Partial<RecapTurn> = {}): RecapTurn => ({
    status: 'succeeded',
    command: 'do the thing',
    workflowNode: null,
    summary: null,
    output: null,
    ...over,
});

describe('renderFollowUpRecap', () => {
    it('delivers the command untouched when there is nothing to recap', () => {
        expect(renderFollowUpRecap([], 'again')).toBe('again');
    });

    it('recaps each turn oldest first, preferring the summary to the output, then the new command', () => {
        const text = renderFollowUpRecap(
            [
                turn({ command: 'fix the bug', status: 'failed', summary: 'blocked on a decision', output: 'tail' }),
                turn({ command: 'option B', output: 'opened the PR' }),
            ],
            'tighten the test'
        );

        expect(text).toContain('Turn 1 (failed): fix the bug\nResult: blocked on a decision');
        expect(text).toContain('Turn 2 (succeeded): option B\nResult: opened the PR');
        expect(text.indexOf('Turn 1')).toBeLessThan(text.indexOf('Turn 2'));
        expect(text.endsWith('New instruction:\n\ntighten the test')).toBe(true);
    });

    it('names an engine-written step by its node, never quoting its prompt', () => {
        const text = renderFollowUpRecap(
            [turn({ command: null, workflowNode: 'merge-conflict-autofix--repair', output: 'MERGE-UP-TO-DATE' })],
            'again'
        );

        expect(text).toContain('Turn 1 (succeeded): (workflow step: merge-conflict-autofix--repair)');
        expect(text).toContain('Result: MERGE-UP-TO-DATE');
    });

    it('stays within the command limit, keeping the newest turns and counting the dropped ones', () => {
        const big = 'x'.repeat(5_000);
        const turns = Array.from({ length: 40 }, (_, i) => turn({ command: `turn-${i} ${big}`, output: big }));

        const text = renderFollowUpRecap(turns, 'again');

        expect(text.length).toBeLessThanOrEqual(COMMAND_LIMIT);
        expect(text).toMatch(/\(\d+ earlier turns omitted\)/);
        expect(text).toContain('turn-39 ');
        expect(text).not.toContain('turn-0 ');
    });

    it('budgets the whole delivered command, the new instruction included', () => {
        const command = 'c'.repeat(COMMAND_LIMIT - 4_000);
        const turns = Array.from({ length: 10 }, (_, i) => turn({ command: `turn-${i}`, output: 'r'.repeat(1_400) }));

        const text = renderFollowUpRecap(turns, command);

        expect(text.length).toBeLessThanOrEqual(COMMAND_LIMIT);
        expect(text).toContain('turn-9');
        expect(text.endsWith(`New instruction:\n\n${command}`)).toBe(true);
    });

    it('delivers the command untouched when no recap turn fits beside it', () => {
        const command = 'c'.repeat(COMMAND_LIMIT);

        expect(renderFollowUpRecap([turn()], command)).toBe(command);
    });
});

describe('renderContinuation', () => {
    it('tells the resumed agent its run was interrupted, then gives the task for reference', () => {
        const text = renderContinuation('implement X and open a PR');

        expect(text).toContain('Your previous run of this task was interrupted');
        expect(text).toContain('Continue from where this conversation left off.');
        expect(text).toContain('check what was already done — commits, pushes, pull requests');
        expect(text).toContain('If this conversation has no earlier turns, start the task from the beginning.');
        expect(text.endsWith('The task, for reference:\n\nimplement X and open a PR')).toBe(true);
    });

    // On the unwritten-session fallback the delivered text is all the agent gets: a cut would take
    // the command's last instruction, so a command the lead leaves no room for goes whole, alone.
    it('delivers a command too long to ride behind the lead whole, without the lead', () => {
        const command = `${'c'.repeat(COMMAND_LIMIT - 9)} and test`;

        expect(renderContinuation(command)).toBe(command);
    });

    it('drops a recap that does not fit beside the lead before it cuts anything of the command', () => {
        // Room for the lead and the command, not for the recap of one short turn as well.
        const command = `${'c'.repeat(COMMAND_LIMIT - 509)} and test`;

        const text = renderContinuation(command, [turn({ command: 'first' })]);

        expect(text.length).toBeLessThanOrEqual(COMMAND_LIMIT);
        expect(text.startsWith('Your previous run')).toBe(true);
        expect(text).not.toContain('Turn 1');
        expect(text.endsWith(`The task, for reference:\n\n${command}`)).toBe(true);
    });

    // A recap rendered to the whole limit would overflow the room the lead leaves, and the cut
    // would take the new instruction: the recap's own trimming drops the oldest turns instead.
    it('fits the recap a first attempt carried into the room the lead leaves, keeping the new instruction', () => {
        const turns = Array.from({ length: 20 }, (_, i) => turn({ command: `turn-${i}`, output: 'r'.repeat(1_400) }));

        const text = renderContinuation('tighten the test', turns);

        expect(text.length).toBeLessThanOrEqual(COMMAND_LIMIT);
        expect(text.startsWith('Your previous run of this task was interrupted')).toBe(true);
        expect(text).toMatch(/\(\d+ earlier turns omitted\)/);
        expect(text).toContain('turn-19\n');
        expect(text.endsWith('New instruction:\n\ntighten the test')).toBe(true);
    });
});
