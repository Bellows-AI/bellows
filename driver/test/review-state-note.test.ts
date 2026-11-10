import { describe, expect, it } from 'vitest';
import { podLogPath, previousPodLogPath } from '../src/k8s/k8s-auxspec.js';
import {
    REVIEWER_LOG_LINE_MAX,
    REVIEWER_LOG_TAIL_LINES,
    REVIEWER_READ_MS,
    reviewerStateNote,
} from '../src/review/review-step.js';

describe('the lost-review evidence note (BEL-288)', () => {
    it('pins the bounds', () => {
        expect([REVIEWER_LOG_TAIL_LINES, REVIEWER_LOG_LINE_MAX, REVIEWER_READ_MS]).toEqual([3, 200, 5_000]);
    });

    it('caps the tail at 3 lines, each at 200 chars', () => {
        const lines = ['one', 'two', '', 'x'.repeat(1_000), 'four', '', 'five', 'six', 'seven', ''];
        const note = reviewerStateNote({ state: 'exited 2', tail: lines });
        expect(note).toContain('the reviewer container: exited 2');
        expect(note).not.toContain('four');
        expect(note).toContain('five | six | seven');
        const kept = `${'x'.repeat(199)}…`;
        expect(reviewerStateNote({ state: 's', tail: ['a', 'x'.repeat(1_000), 'b'] })).toContain(kept);
        expect(reviewerStateNote({ state: 's', tail: ['a', 'x'.repeat(1_000), 'b'] })).not.toContain('x'.repeat(200));
    });

    it("keeps a line's content otherwise verbatim", () => {
        const line = 'sh: 1: cannot create /factory/review/alive: Permission denied';
        expect(reviewerStateNote({ state: 'exited 2', tail: [line] })).toContain(line);
    });

    it('an unknown state and an unavailable tail are said, never a verdict', () => {
        const note = reviewerStateNote({ state: null, why: 'inspect timed out', tail: null });
        expect(note).toContain('state unknown: inspect timed out');
        expect(note).toContain('logs unavailable');
        expect(reviewerStateNote({ state: 'running', tail: ['', ''] })).toContain('logs unavailable');
    });

    it('names the restart a previous-instance tail belongs to', () => {
        expect(reviewerStateNote({ state: 'running', tail: ['boom'], beforeRestart: 2 })).toContain(
            'its last log lines (before restart 2): boom'
        );
        expect(reviewerStateNote({ state: 'running', tail: ['boom'] })).toContain('its last log lines: boom');
    });
});

describe('previousPodLogPath', () => {
    it('adds previous=true to the log path of a container; podLogPath itself is byte-identical', () => {
        expect(podLogPath('ns', 'p', 3, 'reviewer')).toBe(
            '/api/v1/namespaces/ns/pods/p/log?tailLines=3&container=reviewer'
        );
        expect(previousPodLogPath('ns', 'p', 3, 'reviewer')).toBe(
            '/api/v1/namespaces/ns/pods/p/log?tailLines=3&container=reviewer&previous=true'
        );
        expect(podLogPath('ns', 'p', null)).toBe('/api/v1/namespaces/ns/pods/p/log');
    });
});
