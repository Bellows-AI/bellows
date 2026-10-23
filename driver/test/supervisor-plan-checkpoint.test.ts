import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { checkpointScript } from '../src/container-scripts.js';
import { supervisorLiterals } from '../src/supervisor-plan.js';
import { SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import { boardJob } from './fixtures/board-job.js';

/**
 * The environment the supervisor's finalize stage is configured by (issue #775) — one function both
 * executors build their supervisor container from (`k8s-podspec.ts`, `docker-group.ts`), so the
 * checkpoint cannot exist on one and not the other.
 */
const ROOT = '55555555-5555-4555-8555-555555555555';
const config = loadDriverConfig({} as NodeJS.ProcessEnv);
const withControl = (over: Partial<BoardJob>): BoardJob =>
    ({
        ...boardJob(),
        id: ROOT,
        repo: 'acme/widgets',
        supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver', [SUPERVISOR_ENV.controlToken]: 't' },
        ...over,
    }) as BoardJob;
const group = { exporting: true };
const envOf = (job: BoardJob, g: Parameters<typeof supervisorLiterals>[2] = group) =>
    Object.fromEntries(supervisorLiterals(config, job, g));

describe('the supervisor’s checkpoint environment', () => {
    it('names the script by content, the task tree, its branch, a directory on the volume and the database', () => {
        const env = envOf(withControl({ executorType: 'opencode' }));

        expect(env[SUPERVISOR_ENV.checkpointScript]).toBe(checkpointScript);
        expect(env[SUPERVISOR_ENV.checkpointCheckout]).toBe('/task/widgets');
        expect(env[SUPERVISOR_ENV.checkpointBranch]).toBe(`factory/${ROOT}`);
        expect(env[SUPERVISOR_ENV.checkpointDir]).toBe('/task/.factory/checkpoint');
        expect(env[SUPERVISOR_ENV.checkpointOpencodeDb]).toBe(`/task/.factory/opencode/${ROOT}/opencode/opencode.db`);
        expect(env[SUPERVISOR_ENV.checkpointMs]).toBe('120000');
    });

    it('hands the checkpoint the claim’s base branch, and none for a task on the remote default', () => {
        expect(envOf(withControl({ baseBranch: 'batch-sandbox' }))[SUPERVISOR_ENV.checkpointBase]).toBe(
            'batch-sandbox'
        );
        expect(envOf(withControl({}))).not.toHaveProperty(SUPERVISOR_ENV.checkpointBase);
    });

    it('snapshots no database for claude-code', () => {
        const env = envOf(withControl({ executorType: 'claude-code' }));

        expect(env[SUPERVISOR_ENV.checkpointScript]).toBe(checkpointScript);
        expect(env).not.toHaveProperty(SUPERVISOR_ENV.checkpointOpencodeDb);
    });

    it('configures none for a job with no repository, with no control endpoint, or in a supervisor-only group', () => {
        for (const [job, g] of [
            [withControl({ repo: null }), group],
            [{ ...withControl({}), supervisorEnv: undefined } as unknown as BoardJob, group],
            [withControl({}), { exporting: false, agentless: true }],
        ] as const) {
            expect(envOf(job, g)).not.toHaveProperty(SUPERVISOR_ENV.checkpointScript);
        }
    });
});
