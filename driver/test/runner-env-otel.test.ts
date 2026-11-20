import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { dockerArgs } from '../src/docker/docker.js';
import { runnerJobSpec } from '../src/k8s/k8s-podspec.js';

/**
 * A guard, green before the driver moved to the OTEL SDK and meant to stay so: the driver's own
 * `OTEL_EXPORTER_OTLP_HEADERS` (which may carry a backend token) reaches no runner. A runner is told only
 * `RUNNER_OTEL_ENDPOINT`, as a literal endpoint.
 */
const SECRET = 'Authorization=secret_x';
const SESSION = { id: '33333333-3333-4333-8333-333333333333', resume: false };
const USER = '44444444-4444-4444-8444-444444444444';
const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    rootCommand: 'fix the failing build',
    attempts: 1,
    maxAttempts: 3,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    ingestToken: '33333333-3333-4333-8333-333333333333',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt:
        'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone',
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    gateEnv: {},
    supervisorEnv: {},
};

describe('a runner never receives the driver’s own OTEL settings', () => {
    beforeEach(() => {
        process.env.OTEL_EXPORTER_OTLP_HEADERS = SECRET;
    });
    afterEach(() => {
        delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    });

    it('a docker `create` argv holds not the headers, and only the runner endpoint', () => {
        const argv = dockerArgs(loadDriverConfig({}), job, SESSION, { envFile: '/tmp/env-file' }).join('\n');
        expect(argv).not.toContain('secret_x');
        expect(argv).not.toContain('OTEL_EXPORTER_OTLP_HEADERS');
        expect(argv).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=');
    });

    it('a kubernetes pod spec holds not the headers, and only the runner endpoint', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'factory' });
        const spec = JSON.stringify(runnerJobSpec(config, job, SESSION));
        // The pod's own per-attempt telemetry header is its own (otel-credential.test.ts): the value is the proof.
        expect(spec).not.toContain('secret_x');
        expect(spec).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    });
});
