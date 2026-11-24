import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { SERVICE_RESTART_TIMEOUT_MS } from '../src/runner.js';
import { FINISH_RETRY_ENV, runnerPlan } from '../src/runner-plan.js';
import { SUPERVISOR_ENV } from '../src/supervisor-contract.js';
import {
    FINISH_RELAY_MARGIN_MS,
    finishRelayBoundMs,
    heartbeatPeriodMs,
    supervisorLiterals,
    takeoverBoundMs,
} from '../src/supervisor-plan.js';
import { boardJob } from './fixtures/board-job.js';
import { githubRef } from './fixtures/repo-ref.js';

/**
 * The finish pass is held on the supervisor's relay for as long as the declared gates run,
 * so the relay's own wall-clock bound is computed from them — once, for both executors' supervisor
 * containers (`supervisorLiterals`) — and the agent's helper is told how long it may re-ask across a
 * takeover (`runnerPlan`, rendered by both executors).
 */
const MS_PER_MINUTE = 60_000;
const config = loadDriverConfig({} as NodeJS.ProcessEnv);
const gatedWith = (gates: NonNullable<BoardJob['gates']>['gates']): BoardJob =>
    ({ ...boardJob(), repo: githubRef('acme/widgets'), gates: { image: 'node:24', gates } }) as BoardJob;
const envOf = (job: BoardJob) =>
    Object.fromEntries(supervisorLiterals(config, job, { exporting: false, gated: job.gates !== undefined }));

describe('the finish relay bound', () => {
    it('is every end-of-run gate’s deadline, the setup retry, a service restart and a margin; on_demand gates do not count', () => {
        const job = gatedWith([
            { name: 'test', command: 'npm test' },
            { name: 'lint', command: 'npm run lint', timeoutMinutes: 5 },
            { name: 'e2e', command: 'npm run e2e', timeoutMinutes: 90, onDemand: true },
        ]);
        expect(finishRelayBoundMs(config, job)).toBe(
            config.gateTimeoutMs +
                Math.min(5 * MS_PER_MINUTE, config.jobTimeoutMs) +
                config.gateTimeoutMs +
                SERVICE_RESTART_TIMEOUT_MS +
                FINISH_RELAY_MARGIN_MS
        );
    });

    it('caps a gate’s own timeout at the job timeout, as the gate itself is', () => {
        const capped = loadDriverConfig({ DRIVER_JOB_TIMEOUT_MS: String(10 * MS_PER_MINUTE) } as NodeJS.ProcessEnv);
        const job = gatedWith([{ name: 'slow', command: 'x', timeoutMinutes: 600 }]);
        expect(finishRelayBoundMs(capped, job)).toBe(
            10 * MS_PER_MINUTE + capped.gateTimeoutMs + SERVICE_RESTART_TIMEOUT_MS + FINISH_RELAY_MARGIN_MS
        );
    });

    it('is written into the supervisor env of a gated group, and absent with no end-of-run gate', () => {
        const job = gatedWith([{ name: 'test', command: 'npm test' }]);
        expect(envOf(job)[SUPERVISOR_ENV.finishRelayMs]).toBe(String(finishRelayBoundMs(config, job)));
        expect(SUPERVISOR_ENV.finishRelayMs).toBe('SUPERVISOR_FINISH_RELAY_TIMEOUT_MS');
        const onDemandOnly = gatedWith([{ name: 'e2e', command: 'x', onDemand: true }]);
        expect(finishRelayBoundMs(config, onDemandOnly)).toBeNull();
        expect(envOf(onDemandOnly)).not.toHaveProperty(SUPERVISOR_ENV.finishRelayMs);
        const ungated = { ...boardJob(), repo: githubRef('acme/widgets') } as BoardJob;
        expect(finishRelayBoundMs(config, ungated)).toBeNull();
        expect(envOf(ungated)).not.toHaveProperty(SUPERVISOR_ENV.finishRelayMs);
    });
});

describe('the finish helper’s re-ask window', () => {
    it.each(['claude-code', 'opencode'] as const)(
        'is a takeover and one heartbeat period, on the %s runner',
        (executorType) => {
            const job = {
                ...boardJob(),
                id: '11111111-1111-4111-8111-111111111111',
                executorType,
                masterPrompt: 'Factory execution contract (factory-master-prompt/v1)\n\n- Mode: standalone',
            } as BoardJob;
            const session = { id: '33333333-3333-4333-8333-333333333333', resume: executorType === 'opencode' };
            const env = Object.fromEntries(runnerPlan(config, job, session).envPairs);
            expect(FINISH_RETRY_ENV).toBe('BELLOWS_FINISH_RETRY_MS');
            expect(env[FINISH_RETRY_ENV]).toBe(String(takeoverBoundMs(config) + heartbeatPeriodMs(config)));
        }
    );
});
