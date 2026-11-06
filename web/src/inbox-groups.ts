/**
 * The inbox's day groups: consecutive rows that share a local calendar bucket render under one
 * heading — Today, Yesterday, Earlier this week (the last seven days), Older. Consecutive, not
 * global, so the list keeps the server's order whichever way it sorts.
 */

export type InboxDay = 'Today' | 'Yesterday' | 'Earlier this week' | 'Older';

const DAY_MS = 86_400_000;
/** Earlier this week reaches back this many calendar days, today included. */
const WEEK_DAYS = 7;

const startOfDay = (at: Date): number => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** The bucket one activity stamp falls in, by local calendar day. An unreadable stamp is Older. */
export function inboxDay(at: string, now: Date): InboxDay {
    const stamp = new Date(at);
    if (Number.isNaN(stamp.getTime())) return 'Older';
    const today = startOfDay(now);
    const day = startOfDay(stamp);
    if (day >= today) return 'Today';
    if (day >= today - DAY_MS) return 'Yesterday';
    if (day > today - WEEK_DAYS * DAY_MS) return 'Earlier this week';
    return 'Older';
}

/** Runs of consecutive items in the same bucket, in the order given. */
export function groupByDay<T>(
    items: readonly T[],
    at: (item: T) => string,
    now: Date
): { day: InboxDay; items: T[] }[] {
    const groups: { day: InboxDay; items: T[] }[] = [];
    for (const item of items) {
        const day = inboxDay(at(item), now);
        const last = groups[groups.length - 1];
        if (last?.day === day) last.items.push(item);
        else groups.push({ day, items: [item] });
    }
    return groups;
}
