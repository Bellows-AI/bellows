import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { agentPrompt, continuationPrompt } from '../src/continuation.js';

/** The board's own command cap (core's `COMMAND_LIMIT`), copied: the driver imports nothing of core. */
const COMMAND_LIMIT = 16_384;

describe('continuationPrompt', () => {
    it('tells the resumed agent its run was interrupted, then gives the task for reference', () => {
        const text = continuationPrompt('implement X and open a PR');

        expect(text).toContain('Your previous run of this task was interrupted');
        expect(text).toContain('Continue from where this conversation left off.');
        expect(text).toContain('check what was already done — commits, pushes, pull requests');
        expect(text).toContain('If this conversation has no earlier turns, start the task from the beginning.');
        expect(text.endsWith('The task, for reference:\n\nimplement X and open a PR')).toBe(true);
    });

    // On the unwritten-session fallback the prompt is all the agent gets, and argv carries no
    // command cap: a cut would only take the command's last instruction.
    it('keeps the whole command behind the lead, however long', () => {
        const command = `${'c'.repeat(COMMAND_LIMIT * 2)} and test`;

        const text = continuationPrompt(command);

        expect(text.startsWith('Your previous run of this task was interrupted')).toBe(true);
        expect(text.endsWith(`The task, for reference:\n\n${command}`)).toBe(true);
    });

    // A sessionless follow-up's first claim was delivered the board's recap ahead of its command:
    // that whole text is the task, recap and new instruction alike.
    it('keeps a recapped command whole, its new instruction last', () => {
        const recapped = `This task continues in a new agent session.\n\nTurn 1 (failed): first\n\nNew instruction:\n\ntighten the test`;

        expect(continuationPrompt(recapped).endsWith(`The task, for reference:\n\n${recapped}`)).toBe(true);
    });
});

describe('the outcome of a runtime connection requirement', () => {
    const job = (extra: Partial<BoardJob>) =>
        ({ command: 'fix ABC-1', continuesInterrupted: true, ...extra }) as BoardJob;

    it('tells a resumed agent the connection it asked for is bound, ahead of the task', () => {
        const text = agentPrompt(job({ connectionOutcomes: [{ provider: 'jira', label: 'Jira', outcome: 'bound' }] }));

        expect(text).toContain('Your previous run of this task was interrupted');
        expect(text).toContain('The Jira connection you asked for is now bound to this task');
        expect(text.indexOf('Jira connection')).toBeLessThan(text.indexOf('The task, for reference:'));
        expect(text.endsWith('The task, for reference:\n\nfix ABC-1')).toBe(true);
    });

    it('tells it to continue without a connection the user declined, and to say so', () => {
        const text = agentPrompt(
            job({ connectionOutcomes: [{ provider: 'jira', label: 'Jira', outcome: 'dismissed' }] })
        );

        expect(text).toContain('continue without the Jira connection');
        expect(text).toContain('say so');
        expect(text.endsWith('The task, for reference:\n\nfix ABC-1')).toBe(true);
    });

    it('names each provider once, one sentence each', () => {
        const text = agentPrompt(
            job({
                connectionOutcomes: [
                    { provider: 'jira', label: 'Jira', outcome: 'bound' },
                    { provider: 'acme', label: 'Acme', outcome: 'dismissed' },
                ],
            })
        );

        expect(text).toContain('The Jira connection you asked for is now bound');
        expect(text).toContain('continue without the Acme connection');
    });

    it('is the plain continuation prompt with no outcome, and the bare command when nothing was interrupted', () => {
        expect(agentPrompt(job({}))).toBe(continuationPrompt('fix ABC-1'));
        expect(agentPrompt(job({ continuesInterrupted: false }))).toBe('fix ABC-1');
    });
});
