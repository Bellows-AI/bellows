/**
 * One gated, published attempt driven through the real loop with every span it opens captured in memory: the run
 * the lifecycle-span tests (`otel.steps.test.ts`) and the attribute scan (`otel.scan.test.ts`) read. The global
 * tracer, context and meter are installed for one file and disabled after it: vitest runs files `isolate: false`.
 */
import { context, metrics, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import type { PublishResult } from '../../src/publish/publish.js';
import type { DaemonState, Read } from '../../src/runner.js';
import { drive, gatedJob, ok, stubBoard, stubGateStack, stubRunner } from './loop-stubs.js';

/** The exporter every span of the file lands in, emptied before each test. */
export function captureSpans(): InMemorySpanExporter {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    beforeAll(() => {
        context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
        trace.setGlobalTracerProvider(provider);
    });
    beforeEach(() => exporter.reset());
    afterAll(() => {
        trace.disable();
        context.disable();
        metrics.disable();
    });
    return exporter;
}

const published: PublishResult = {
    ok: true,
    published: true,
    branch: 'fix/1',
    prUrl: 'https://github.com/o/r/pull/9',
    reason: null,
    cause: null,
    repository: 'o/r',
    baseBranch: 'main',
    prNumber: 9,
};

const daemon = (restartCount: number): Read<DaemonState> => ({ kind: 'value', value: { running: true, restartCount } });

/**
 * Drives one gated job that publishes, under `executor`. `gateLost` fails the first gate while the docker daemon
 * restarts under it: the gates phase throws `DaemonLost`, and the attempt is interrupted instead of published.
 */
export async function runGatedPublish(
    executor: 'docker' | 'kubernetes',
    options: { job?: Partial<BoardJob>; gateLost?: boolean; publish?: PublishResult } = {}
) {
    const claimed: BoardJob = { ...gatedJob(1), claimSeq: 3, ...options.job };
    const board = stubBoard([claimed]);
    const stack = stubGateStack(options.gateLost ? { test: 1 } : {});
    const runner = stubRunner(async () => ok(), {
        sync: { ok: true, reason: null, fingerprint: 'h:before' },
        probeTree: 'h:after',
        publish: options.publish ?? published,
    });
    if (options.gateLost) {
        const reads = [daemon(0), daemon(1)];
        runner.dockerdRestarts = async () => reads.shift() ?? { kind: 'absent' };
    }
    await drive({ ...board, runner, gates: stack.gates }, { EXECUTOR: executor });
    return { claimed, board: board.board, runner };
}
