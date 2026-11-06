import { describe, expect, it } from 'vitest';
import { groupByDay, inboxDay } from '../src/inbox-groups.js';

/** The inbox's day headings: local calendar buckets, consecutive runs in the server's order. */

const now = new Date(2026, 8, 10, 9, 30);
const at = (day: number, hour = 12) => new Date(2026, 8, day, hour).toISOString();

describe('inboxDay', () => {
    it('buckets by local calendar day, not by 24-hour distance', () => {
        expect(inboxDay(at(10, 0), now)).toBe('Today');
        expect(inboxDay(at(9, 23), now)).toBe('Yesterday');
        expect(inboxDay(at(9, 0), now)).toBe('Yesterday');
        expect(inboxDay(at(8, 23), now)).toBe('Earlier this week');
        expect(inboxDay(at(4), now)).toBe('Earlier this week');
        expect(inboxDay(at(3), now)).toBe('Older');
    });

    it('counts a stamp ahead of the clock as Today, and an unreadable one as Older', () => {
        expect(inboxDay(at(11), now)).toBe('Today');
        expect(inboxDay('not a date', now)).toBe('Older');
    });
});

describe('groupByDay', () => {
    it('groups consecutive rows and keeps the given order, whichever way it sorts', () => {
        const newest = [at(10), at(10, 1), at(9), at(1)];
        expect(groupByDay(newest, (x) => x, now).map((g) => [g.day, g.items.length])).toEqual([
            ['Today', 2],
            ['Yesterday', 1],
            ['Older', 1],
        ]);
        const oldest = [...newest].reverse();
        expect(groupByDay(oldest, (x) => x, now).map((g) => g.day)).toEqual(['Older', 'Yesterday', 'Today']);
    });

    it('returns no group for no rows', () => {
        expect(groupByDay([], (x: string) => x, now)).toEqual([]);
    });
});
