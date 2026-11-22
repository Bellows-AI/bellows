import { describe, expect, it } from 'vitest';
import { COMMAND_LIMIT } from '@factory-ai/core';
import { renderFailedGates } from '../src/db/gate-report.js';
import type { GateReport } from '../src/db/jobs/job-store-types.js';
import { INTERP_TAIL_LIMIT } from '../src/db/workflows/workflow-schema.js';

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

    it('stops adding gates once the command cap would be crossed', () => {
        const big = 'z'.repeat(INTERP_TAIL_LIMIT);
        const gates = [gate('a', 'failed', big), gate('b', 'failed', big)];
        const command = 'q'.repeat(COMMAND_LIMIT - INTERP_TAIL_LIMIT - 600);
        const text = renderFailedGates(gates, command);
        expect(text).toContain('Gate "a"');
        expect(text).not.toContain('Gate "b"');
        expect(command.length + 2 + text.length).toBeLessThanOrEqual(COMMAND_LIMIT);
    });
});
