import { readFileSync } from 'node:fs';
import { rollupsFromFacts, type JobRun } from '@factory-ai/core';
import type { TaskFacts, TelemetryClient, TelemetryFetch } from './client.js';
import { TelemetryError } from './errors.js';
import { emptyUsageFacts, factsForTask, taskOfJob, type UsageFacts } from './usage-facts.js';

const FIXTURE = new URL('../../../core/test/fixtures/telemetry-usage.json', import.meta.url);

/** The committed JSON: usage facts (the id set as an array) plus the board's run rows. */
type FixtureFile = Omit<UsageFacts, 'foreignSessionIds' | 'stats' | 'edits'> & {
    foreignSessionIds: string[];
    runs: JobRun[];
};

/** Parses the committed fixture into one fetch: facts, the session rollups derived from them, and the runs. */
export function parseFixtureFetch(raw: string): TelemetryFetch {
    const { runs, foreignSessionIds, ...rest } = JSON.parse(raw) as FixtureFile;
    const facts: UsageFacts = {
        edits: [],
        ...rest,
        foreignSessionIds: new Set(foreignSessionIds),
        stats: emptyUsageFacts(rest.orgId).stats,
    };
    return { input: rollupsFromFacts(facts), runs, facts };
}

/**
 * Replays the committed synthetic usage facts so the whole read path runs with no database and
 * no collector. This data is invented, so the UI is required to badge it
 * loudly — synthetic figures beside real figures is exactly the invented-number problem.
 */
export function createFixtureTelemetryClient(path: URL = FIXTURE): TelemetryClient {
    let cached: TelemetryFetch | null = null;
    const load = () => {
        if (!cached) cached = parseFixtureFetch(readFileSync(path, 'utf8'));
        return cached;
    };

    return {
        async fetchRollups() {
            // Cloned because the reducer is handed the arrays directly and a caller mutating
            // them would silently poison every later request.
            return structuredClone(load());
        },
        // The fixture's facts carry no edit points; the task read is the same facts narrowed to one task.
        async fetchTaskFacts({ jobId, rootJobId }): Promise<TaskFacts> {
            const { facts } = load();
            const taskId = taskOfJob(facts.board, jobId) ?? rootJobId;
            return structuredClone({ taskId, facts: factsForTask(facts, taskId) });
        },
        async health() {
            return { status: 'ok', reason: null };
        },
    };
}

/**
 * TELEMETRY_SOURCE=off. Reports unreachable rather than throwing so the feature is absent
 * from the page instead of erroring on it.
 */
export function createNullTelemetryClient(): TelemetryClient {
    return {
        async fetchRollups(): Promise<TelemetryFetch> {
            throw new TelemetryError('Telemetry is disabled (TELEMETRY_SOURCE=off)', 'UNREACHABLE');
        },
        async fetchTaskFacts(): Promise<TaskFacts> {
            throw new TelemetryError('Telemetry is disabled (TELEMETRY_SOURCE=off)', 'UNREACHABLE');
        },
        async health() {
            return { status: 'unreachable', reason: 'Telemetry is disabled (TELEMETRY_SOURCE=off)' };
        },
    };
}
