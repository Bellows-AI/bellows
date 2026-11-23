import { describe, expect, it } from 'vitest';
import type { BoardJob, DeclaredGate } from '../src/board/board.js';
import { AD_HOC_MAX_MINUTES } from '../src/gate-manager.js';
import { finishGates, toolManifest, toolOf } from '../src/tools.js';
import { gatedJob, job } from './fixtures/loop-stubs.js';

/**
 * The run's tool manifest: what the agent can call, built from the claim alone — each declared gate
 * as `gate:<name>` plus the built-in `exec` — and the one `required: 'finish'` selection the finish
 * pass and its relay bound both read.
 */

const withGates = (gates: DeclaredGate[]): BoardJob => ({
    ...gatedJob(1),
    gates: { image: 'node:24', gates },
});

describe('the tool manifest', () => {
    it('lists each declared gate as gate:<name> and exec', () => {
        const manifest = toolManifest(gatedJob(1));

        expect(manifest.map((tool) => tool.id)).toEqual(['gate:test', 'gate:lint', 'exec']);
        expect(toolOf(manifest, 'gate:test')).toEqual({
            id: 'gate:test',
            name: 'test',
            kind: 'command',
            verdict: true,
            required: 'finish',
            filter: false,
            timeout: null,
        });
        expect(toolOf(manifest, 'exec')).toEqual({
            id: 'exec',
            name: 'exec',
            kind: 'command',
            verdict: false,
            timeout: AD_HOC_MAX_MINUTES,
        });
        expect(toolOf(manifest, 'test')).toBeNull();
        expect(toolOf(manifest, 'gate:missing')).toBeNull();
    });

    it('a gate named exec is gate:exec beside the built-in exec', () => {
        const manifest = toolManifest(withGates([{ name: 'exec', command: 'npm run exec' }]));

        expect(manifest.map((tool) => tool.id)).toEqual(['gate:exec', 'exec']);
        expect(toolOf(manifest, 'gate:exec')).toMatchObject({ name: 'exec', verdict: true });
        expect(toolOf(manifest, 'exec')).toMatchObject({ name: 'exec', verdict: false });
    });

    it('on_demand maps to required on_demand, others finish', () => {
        const manifest = toolManifest(
            withGates([
                { name: 'test', command: 'npm test' },
                { name: 'e2e', command: 'npm run e2e', onDemand: true },
            ])
        );

        expect(toolOf(manifest, 'gate:test')).toMatchObject({ required: 'finish' });
        expect(toolOf(manifest, 'gate:e2e')).toMatchObject({ required: 'on_demand' });
    });

    it('filter and timeout carry the declaration, null when undeclared', () => {
        const manifest = toolManifest(
            withGates([
                { name: 'test', command: 'npm test', filter: true, timeoutMinutes: 7 },
                { name: 'lint', command: 'npm run lint' },
            ])
        );

        expect(toolOf(manifest, 'gate:test')).toMatchObject({ filter: true, timeout: 7 });
        expect(toolOf(manifest, 'gate:lint')).toMatchObject({ filter: false, timeout: null });
    });

    it('a claim with no gate environment lists nothing', () => {
        expect(toolManifest(job(1))).toEqual([]);
        expect(toolManifest({ ...gatedJob(1), gates: null })).toEqual([]);
        // A gate environment without a checkout to run it in lists nothing either.
        expect(toolManifest({ ...gatedJob(1), repo: null })).toEqual([]);
    });

    it('an image-only environment lists exec alone', () => {
        expect(toolManifest(withGates([])).map((tool) => tool.id)).toEqual(['exec']);
    });

    it('finishGates keeps required finish only', () => {
        const gates: DeclaredGate[] = [
            { name: 'test', command: 'npm test' },
            { name: 'e2e', command: 'npm run e2e', onDemand: true },
            { name: 'lint', command: 'npm run lint', parallel: true },
        ];

        expect(finishGates(gates).map((gate) => gate.name)).toEqual(['test', 'lint']);
        expect(finishGates([])).toEqual([]);
    });
});
