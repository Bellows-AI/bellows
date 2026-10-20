/**
 * Creation times a reap is decided on (#869): each parser answers epoch millis for a timestamp in
 * exactly the platform's spelling and a real calendar moment, and null for anything else — `"0"`,
 * a bare date, a day the calendar lacks (`02-31`, which `Date` would roll into March). A reap never
 * rests on a date that was guessed.
 */

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const MAX_OFFSET_HOURS = 23;
const MS_PER_SECOND = 1000;

/** Epoch millis of a calendar moment at a UTC offset, or null when any field is not a real one. */
function calendarMillis(parts: number[], offsetMinutes: number, millis = 0): number | null {
    const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = parts;
    const at = new Date(0);
    at.setUTCFullYear(year, month - 1, day);
    at.setUTCHours(hour, minute, second, millis);
    const real =
        at.getUTCFullYear() === year &&
        at.getUTCMonth() === month - 1 &&
        at.getUTCDate() === day &&
        at.getUTCHours() === hour &&
        at.getUTCMinutes() === minute &&
        at.getUTCSeconds() === second;
    return real ? at.getTime() - offsetMinutes * MS_PER_MINUTE : null;
}

/** A `+HH:MM` / `+HHMM` offset's minutes; null when the hours or minutes are not a real offset. */
function offsetMinutesOf(sign: string, hours: string, minutes: string): number | null {
    const h = Number(hours);
    const m = Number(minutes);
    if (h > MAX_OFFSET_HOURS || m >= MINUTES_PER_HOUR) return null;
    return (sign === '-' ? -1 : 1) * (h * MINUTES_PER_HOUR + m);
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** `2026-09-14T10:00:00Z`, with an optional fraction and `±HH:MM` for `Z`: what the apiserver and `docker volume inspect` answer. */
export function parseRfc3339(raw: string): number | null {
    const match = RFC3339.exec(raw.trim());
    if (!match) return null;
    const [, y, mo, d, h, mi, s, fraction, sign, oh, om] = match;
    const offset = sign === undefined ? 0 : offsetMinutesOf(sign, oh!, om!);
    if (offset === null) return null;
    const millis = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * MS_PER_SECOND);
    return calendarMillis([y, mo, d, h, mi, s].map(Number), offset, millis);
}

const DOCKER_CREATED_AT =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (?:[A-Za-z]+|[+-]\d{2}(?:\d{2})?)$/;

/** Docker's `CreatedAt` spelling for a container: `2026-09-14 10:00:00 +0000 UTC`. */
export function parseDockerTimestamp(raw: string): number | null {
    const match = DOCKER_CREATED_AT.exec(raw.trim());
    if (!match) return null;
    const [, y, mo, d, h, mi, s, sign, oh, om] = match;
    const offset = offsetMinutesOf(sign!, oh!, om!);
    return offset === null ? null : calendarMillis([y, mo, d, h, mi, s].map(Number), offset);
}
