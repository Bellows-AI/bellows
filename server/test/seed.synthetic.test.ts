import { describe, expect, it } from 'vitest';
import { generate, type SyntheticSession } from '../src/seed/synthetic.js';

const DAY_MS = 86_400_000;
const WEEKDAYS = 7;
const WEEK_MS = 7 * DAY_MS;
/** A Wednesday: the weekday on which the unmeasured-bucket e2e spec went red (BEL-151). */
const WEDNESDAY = Date.parse('2026-10-28T13:00:00Z');

const weekOf = (ms: number): string => {
    const d = new Date(ms);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
};
const hasTokens = (s: SyntheticSession): boolean => Object.keys(s.fields).some((f) => f.startsWith('tokens_'));
const midpoint = (s: SyntheticSession): number => (Date.parse(s.firstSeen) + Date.parse(s.lastSeen)) / 2;

/**
 * ISO weeks the sessions chart draws (every week from the first session to the last, quiet ones
 * included) in which no token reading landed: the usage chart's unmeasured buckets.
 */
function unmeasuredWeeks(sessions: readonly SyntheticSession[]): string[] {
    const began = sessions.map((s) => Date.parse(s.firstSeen));
    const measured = new Set(sessions.filter(hasTokens).map((s) => weekOf(midpoint(s))));
    const weeks: string[] = [];
    for (let at = Date.parse(weekOf(Math.min(...began))); at <= Math.max(...began); at += WEEK_MS) {
        const week = new Date(at).toISOString().slice(0, 10);
        if (!measured.has(week)) weeks.push(week);
    }
    return weeks;
}

describe('synthetic seed: the unmeasured bucket the e2e usage chart asserts on', () => {
    it.each([...Array(WEEKDAYS).keys()])(
        'holds a week with sessions and no token reading when now is day +%i',
        (offset) => {
            const now = new Date(WEDNESDAY + offset * DAY_MS);
            expect(unmeasuredWeeks(generate({ repo: 'o/r', now }).sessions)).not.toHaveLength(0);
        }
    );
});
