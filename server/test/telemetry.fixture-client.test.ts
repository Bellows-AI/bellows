import { reduceUsage } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { createFixtureTelemetryClient, createNullTelemetryClient } from '../src/telemetry/fixture-client.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');

describe('the fixture telemetry client', () => {
    it('replays the committed fixture without letting one caller poison the cached facts', async () => {
        const client = createFixtureTelemetryClient();
        const first = await client.fetchRollups();
        const sessionCount = first.input.sessions.length;
        const pointCount = first.facts.contributions.length;
        const runCount = first.runs.length;

        first.input.sessions.splice(0);
        (first.facts.contributions as unknown[]).splice(0);
        (first.facts.foreignSessionIds as Set<string>).add('poison');
        first.runs.splice(0);
        const second = await client.fetchRollups();

        expect(sessionCount).toBeGreaterThan(0);
        expect(second.input.sessions).toHaveLength(sessionCount);
        expect(second.facts.contributions).toHaveLength(pointCount);
        expect(second.facts.foreignSessionIds.size).toBe(0);
        expect(second.runs).toHaveLength(runCount);
        expect(runCount).toBeGreaterThan(0);
        await expect(client.health()).resolves.toEqual({ status: 'ok', reason: null });
    });
});

describe('the fixture task read', () => {
    it("narrows the committed facts to the job's canonical task, and to its thread root when nothing names the job", async () => {
        const client = createFixtureTelemetryClient();
        const { facts } = await client.fetchRollups();
        const job = facts.board[0]!;

        const { taskId, facts: task } = await client.fetchTaskFacts({ jobId: job.jobId, rootJobId: job.rootJobId });

        expect(taskId).toBe(job.requestingRootJobId ?? job.rootJobId);
        expect(task.board.length).toBeGreaterThan(0);
        expect(task.board.every((e) => (e.requestingRootJobId ?? e.rootJobId) === taskId)).toBe(true);
        expect(task.board.length).toBeLessThanOrEqual(facts.board.length);
        const unknown = await client.fetchTaskFacts({ jobId: 'nobody', rootJobId: 'its-root' });
        expect(unknown.taskId).toBe('its-root');
        expect(unknown.facts.board).toEqual([]);
    });
});

describe('the disabled telemetry client', () => {
    it('reports an explicit unreachable state instead of manufacturing empty analytics', async () => {
        const client = createNullTelemetryClient();

        await expect(client.fetchRollups()).rejects.toMatchObject({
            name: 'TelemetryError',
            code: 'UNREACHABLE',
            message: 'Telemetry is disabled (TELEMETRY_SOURCE=off)',
        });
        await expect(client.health()).resolves.toEqual({
            status: 'unreachable',
            reason: 'Telemetry is disabled (TELEMETRY_SOURCE=off)',
        });
    });

    it('reduces to the hand-computed figures of the synthetic world', async () => {
        const { facts } = await createFixtureTelemetryClient().fetchRollups();
        const report = reduceUsage(facts, { range: null, now: NOW, repos: ['Bellows-AI/bellows.ai'] });

        // Summed by hand from the generator's table: 19 owned in-repo sessions, one of them hook-less;
        // the conflicting session and the other-repo session are named, not counted.
        expect(report.eligible.tokens).toEqual({
            input: 518000,
            output: 90000,
            cacheRead: 2659000,
            cacheCreation: 157800,
        });
        expect(report.eligible.counts.sessions).toBe(19);
        expect(report.diagnostics.sessionsWithoutHook).toBe(1);
        expect(report.diagnostics.unresolvedOwnership.sessions).toBe(1);
        expect(report.diagnostics.excludedRepo.tokens.input).toBe(90000);
        // Partial measurement stays partial: one session never measured the cache types.
        expect(report.eligible.coverage.cacheRead).toEqual({ measured: 18, contributors: 19 });
        expect(report.tasks.find((t) => t.taskId === 't-s18')?.removed).toBe(true);
        expect(report.tasks.some((t) => t.taskId === 't-s02-review')).toBe(false);
    });
});
