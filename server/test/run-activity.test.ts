import { describe, expect, it } from 'vitest';
import { buildRunActivity, pickBucketMs } from '../src/telemetry/run-activity.js';
import { activityWorld, minute } from './helpers-activity.js';

/**
 * The run-activity bucketing (issues #339, #847): a run's ALREADY-assigned contributions placed into
 * buckets over the run's segment span. Temporality, ownership and run assignment are core's
 * (core/test/usage-reduce.test.ts, token-contributions tests); what is pinned here is that the
 * buckets add back to the run's usage and that an unmeasured type is never drawn as zero.
 */

const NOW = new Date(minute(60));
const FIFTEEN_MIN = 900_000;

describe('pickBucketMs', () => {
    it('picks the smallest bucket width that keeps the chart at 16 bars or fewer', () => {
        // A 2h run → 15-minute buckets, 8 of them — the issue's own example.
        expect(pickBucketMs(7_200_000)).toBe(FIFTEEN_MIN);
        expect(pickBucketMs(30 * 60_000)).toBe(300_000);
        expect(pickBucketMs(5 * 60_000)).toBe(60_000);
    });

    it('caps at the hour width for runs too long for the ladder', () => {
        expect(pickBucketMs(20 * 3_600_000)).toBe(3_600_000);
    });
});

describe('buildRunActivity', () => {
    it('places each assigned amount in the bucket that holds its instant', () => {
        const { ids, facts } = activityWorld();
        const { run } = buildRunActivity(facts, ids.task, ids.task, NOW);

        expect(run?.bucketMs).toBe(60_000);
        expect(run?.buckets).toHaveLength(10);
        expect(run?.buckets[5]?.tokens).toEqual({ input: 7, output: 100, cacheRead: null, cacheCreation: null });
        expect(run?.buckets[5]?.edits).toBe(3);
        expect(run?.buckets[4]?.tokens.output).toBe(0);
    });

    it('draws a run of the same shared session only from its own segment, not the gap or the other run', () => {
        const { ids, facts } = activityWorld();
        const { run } = buildRunActivity(facts, ids.task, ids.followUp, NOW);

        expect([run?.from, run?.to]).toEqual([minute(12), minute(20)]);
        expect(run?.usage.tokens.output).toBe(60);
        expect(run?.buckets.map((b) => b.tokens.output)).toEqual([0, 0, 0, 60, 0, 0, 0, 0]);
    });

    it('runs an open claim to now', () => {
        const { ids, facts } = activityWorld();
        const open = {
            ...facts,
            board: facts.board.map((e) => (e.jobId === ids.task ? { ...e, endedAt: null, live: true } : e)),
        };
        const { run } = buildRunActivity(open, ids.task, ids.task, NOW);

        expect(run?.to).toBe(NOW.toISOString());
    });

    it('answers no buckets for a run that measured nothing, and no run for a job outside the task', () => {
        const { ids, facts } = activityWorld();
        const quiet = { ...facts, contributions: [], edits: [] };

        const idle = buildRunActivity(quiet, ids.task, ids.task, NOW);
        expect(idle.run?.buckets).toEqual([]);
        expect(idle.run?.usage.state).toBe('unmeasured');
        expect(buildRunActivity(facts, ids.task, 'not-a-run', NOW)).toMatchObject({ run: null });
        expect(buildRunActivity(facts, 'no-such-task', ids.task, NOW)).toEqual({ task: null, run: null });
    });
});
