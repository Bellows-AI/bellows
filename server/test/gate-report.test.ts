import { describe, expect, it } from 'vitest';
import { COMMAND_LIMIT } from '@factory-ai/core';
import { gateOutputTail, renderFailedGates } from '../src/db/gate-report.js';
import type { GateReport } from '../src/db/jobs/job-store-types.js';
import { INTERP_TAIL_LIMIT, TRUNCATION_MARKER } from '../src/db/workflows/workflow-schema.js';

const gate = (name: string, status: GateReport['status'], output: string | null): GateReport => ({
    name,
    status,
    exitCode: status === 'failed' ? 2 : 0,
    output,
});

describe('gate report text', () => {
    it('renders every failed gate with name, exit code and output, and nothing for the rest', () => {
        const text = renderFailedGates(
            [gate('a', 'failed', 'boom a'), gate('b', 'passed', 'fine'), gate('c', 'failed', 'boom c')],
            'fix it'
        );
        expect(text).toContain('Gate "a" failed with exit code 2');
        expect(text).toContain('boom a');
        expect(text).toContain('boom c');
        expect(text).not.toContain('fine');
        expect(renderFailedGates([gate('b', 'passed', 'fine')], 'fix it')).toBe('');
        expect(renderFailedGates(null, 'fix it')).toBe('');
    });

    it('names the failed tests and the selection of a failed gate ahead of its output tail', () => {
        const failed: GateReport = {
            ...gate('test', 'failed', 'tail'),
            result: {
                failures: [{ file: 'a.test.ts', test: 'adds', message: 'expected 3 to be 4\n  at line 9' }],
                selection: { mode: 'all', reason: 'a shared file changed' },
            },
        };
        const text = renderFailedGates([failed], 'fix it');
        expect(text).toContain('Failed tests (1):\n- a.test.ts > adds: expected 3 to be 4\n');
        expect(text).toContain('Selection: all, a shared file changed');
        expect(text.indexOf('Failed tests')).toBeLessThan(text.indexOf('Output tail:'));
        expect(text).not.toContain('at line 9');
    });

    it('stops adding gates once the command cap would be crossed', () => {
        const big = 'z'.repeat(INTERP_TAIL_LIMIT);
        const gates = [gate('a', 'failed', big), gate('b', 'failed', big)];
        const command = 'q'.repeat(COMMAND_LIMIT - INTERP_TAIL_LIMIT - 600);
        const text = renderFailedGates(gates, command);
        expect(text).toContain('Gate "a"');
        expect(text).not.toContain('Gate "b"');
        expect(command.length + 2 + text.length).toBeLessThanOrEqual(COMMAND_LIMIT);
    });

    // The driver stores a failed gate as `[failure lines]` then `[output tail]`; a cut to the board's tail
    // budget must keep the failing names, the summary and the last lines, not the first 4 KiB of the names.
    it('keeps the failure lines, the summary and the end of the tail when it shortens an excerpt', () => {
        const names = Array.from({ length: 300 }, (_, i) => ` FAIL  web/test/f${i}.test.ts > suite > case ${i}`);
        const summary = ' Test Files  300 failed | 10 passed (310)';
        const tail = `${'stack frame\n'.repeat(1000)}LAST LINE`;
        const output = `[failure lines]\n${[...names, summary].join('\n')}\n[output tail]\n${tail}`;
        const kept = gateOutputTail(gate('test', 'failed', output));
        expect(kept).toContain(names[0]);
        expect(kept).toContain(summary);
        expect(kept.endsWith('LAST LINE')).toBe(true);
        expect(kept.length).toBeLessThanOrEqual(INTERP_TAIL_LIMIT + TRUNCATION_MARKER.length);
    });

    // A failed output the driver kept whole (it fit the driver's budget) is not framed: the board frames it
    // the same way, so a failing name anywhere in it and its closing error both survive the cut.
    it('frames an unframed output, keeping a failure line from its middle and its end', () => {
        const output = [
            'build step\n'.repeat(300),
            ' FAIL  web/test/a.test.ts > adds\n',
            'stack frame\n'.repeat(300),
            ' Test Files  1 failed | 9 passed (10)\n',
            'Error: the real failure',
        ].join('');
        const kept = gateOutputTail(gate('test', 'failed', output));
        expect(kept).toContain(' FAIL  web/test/a.test.ts > adds');
        expect(kept).toContain(' Test Files  1 failed | 9 passed (10)');
        expect(kept.endsWith('Error: the real failure')).toBe(true);
        expect(kept.length).toBeLessThanOrEqual(INTERP_TAIL_LIMIT + TRUNCATION_MARKER.length);
    });

    it('keeps the start of a failure line too long to fit whole', () => {
        const name = ` FAIL  web/test/a.test.ts > case ${'p'.repeat(3200)}`;
        const output = `${name}\n${'stack frame\n'.repeat(400)} Test Files  1 failed (1)\nError: the real failure`;
        const kept = gateOutputTail(gate('test', 'failed', output));
        expect(kept).toContain(' FAIL  web/test/a.test.ts > case ppp');
        expect(kept.endsWith('Error: the real failure')).toBe(true);
    });

    it('keeps the end of an output that names no failure', () => {
        const output = `${'early noise\n'.repeat(1000)}Error: the real failure`;
        const kept = gateOutputTail(gate('test', 'failed', output));
        expect(kept.endsWith('Error: the real failure')).toBe(true);
        expect(kept).toContain('[…truncated by the board]');
        expect(kept.length).toBeLessThanOrEqual(INTERP_TAIL_LIMIT + TRUNCATION_MARKER.length);
    });

    it('leaves an output within the budget as it is', () => {
        expect(gateOutputTail(gate('test', 'failed', 'short'))).toBe('short');
    });
});
