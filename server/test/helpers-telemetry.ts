import { rollupsFromFacts, type JobRun, type TelemetryInput } from '@factory-ai/core';
import type { TaskFacts, TelemetryClient, TelemetryHealth } from '../src/telemetry/client.js';
import { emptyUsageFacts, factsForTask, taskOfJob } from '../src/telemetry/usage-facts.js';
import type { UsageFacts } from '../src/telemetry/usage-facts.js';
import { sampleFetch } from './helpers-config.js';

export interface TelemetryStubOptions {
    /** The session rollups; when given without `facts` the usage facts are empty (no token figures). */
    rollups?: () => Promise<TelemetryInput>;
    /** The usage facts the token figures reduce from; default: the committed synthetic fixture. */
    facts?: () => UsageFacts;
    /** The run rows one fetch returns beside the rollups; empty unless a test feeds some. */
    runs?: () => JobRun[];
    health?: () => Promise<TelemetryHealth>;
    /** The facts the run-activity read answers with, whole-org; narrowed to the job's task like the real read. Default: none. */
    taskFacts?: () => UsageFacts;
}

export interface TelemetryStub extends TelemetryClient {
    rollupCalls: number;
    healthCalls: number;
    /** The inputs the run-activity read was asked for, in order. */
    activityCalls: { jobId: string; rootJobId: string; edits?: boolean }[];
}

export function stubTelemetryClient(options: TelemetryStubOptions = {}): TelemetryStub {
    const stub: TelemetryStub = {
        rollupCalls: 0,
        healthCalls: 0,
        activityCalls: [],
        async fetchRollups() {
            stub.rollupCalls += 1;
            // The stub mirrors the real shape: ONE fetch returns both lists, and every range
            // and scope is served from re-aggregating them.
            const sample = sampleFetch();
            const facts = options.facts ? options.facts() : options.rollups ? emptyUsageFacts('stub') : sample.facts;
            return {
                input: options.rollups ? await options.rollups() : rollupsFromFacts(facts),
                runs: options.runs ? options.runs() : [],
                facts,
            };
        },
        async fetchTaskFacts(input): Promise<TaskFacts> {
            stub.activityCalls.push(input);
            const facts = options.taskFacts ? options.taskFacts() : emptyUsageFacts('stub');
            const taskId = taskOfJob(facts.board, input.jobId) ?? input.rootJobId;
            return { taskId, facts: factsForTask(facts, taskId) };
        },
        async health() {
            stub.healthCalls += 1;
            if (options.health) return options.health();
            return { status: 'ok', reason: null };
        },
    };
    return stub;
}
