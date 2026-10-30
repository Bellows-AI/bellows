/** A fraction to a whole-number percent. */
const PERCENT_MULTIPLIER = 100;

/**
 * A null metric means "not measurable", which is never the same as zero. Every formatter
 * renders it as an em dash; callers must not substitute `?? 0`, and must not test
 * truthiness, because 0 is a real value here.
 */
export const pct = (value: number | null | undefined): string =>
    value === null || value === undefined ? '—' : `${Math.round(value * PERCENT_MULTIPLIER)}%`;

export const num = (value: number | null | undefined, digits = 1): string =>
    value === null || value === undefined ? '—' : Number(value.toFixed(digits)).toString();

/** Above this many hours, `duration` switches from hours to days. */
const DURATION_DAY_THRESHOLD_HOURS = 48;

export function duration(hours: number | null | undefined): string {
    if (hours === null || hours === undefined) return '—';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < DURATION_DAY_THRESHOLD_HOURS) return `${num(hours, 1)}h`;
    return `${num(hours / 24, 1)}d`;
}

/** Just the day. A commit's time of day is noise in a table of repositories. */
export function commitDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? '—' : at.toISOString().slice(0, 10);
}

/**
 * A task's stamp in the chat: the time of day is the useful part there, unlike a commit table, so
 * the date stays only to disambiguate older threads. UTC, like every formatter here — a constant
 * offset the whole team reads the same way beats a local one nobody can compare.
 */
export function taskTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '—';
    const utc = at.toISOString();
    return `${utc.slice(0, 10)} ${utc.slice(CLOCK_HOUR_START_INDEX, CLOCK_MINUTE_END_INDEX)}`;
}

/** Where `HH` starts, and where `MM` ends, in an ISO stamp's time portion. */
const CLOCK_HOUR_START_INDEX = 11;
const CLOCK_MINUTE_END_INDEX = 16;

/** Milliseconds in an hour — every duration formatter here divides by it to get hours. */
const MS_PER_HOUR = 3_600_000;

/**
 * How long a run has taken, or took: from the attempt's start to its finish, or — while it is
 * still going — to `now`, which the caller decides so this stays pure (the detail page re-renders
 * on every 2s poll, which is the ticker). A dash for anything absent, unparseable, or ending
 * before it started: a negative duration is a lie, not a number.
 */
export function runDuration(
    startedAt: string | null | undefined,
    endedAt: string | null | undefined,
    now: Date = new Date()
): string {
    if (!startedAt) return '—';
    const from = new Date(startedAt);
    if (Number.isNaN(from.getTime())) return '—';
    const to = endedAt === null || endedAt === undefined ? now : new Date(endedAt);
    if (Number.isNaN(to.getTime()) || to.getTime() < from.getTime()) return '—';
    return duration((to.getTime() - from.getTime()) / MS_PER_HOUR);
}

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/**
 * Seconds a step has been going: "45s", "2m 14s", "1h 3m". Null for an absent, unparseable or future
 * start — never a made-up "0s" — so the caller renders nothing. `now` is the caller's, like `runDuration`.
 */
export function elapsedSeconds(startedAt: string | null | undefined, now: Date = new Date()): string | null {
    if (!startedAt) return null;
    const from = Date.parse(startedAt);
    if (Number.isNaN(from) || from > now.getTime()) return null;
    const total = Math.floor((now.getTime() - from) / MS_PER_SECOND);
    if (total < SECONDS_PER_MINUTE) return `${total}s`;
    if (total < SECONDS_PER_HOUR) return `${Math.floor(total / SECONDS_PER_MINUTE)}m ${total % SECONDS_PER_MINUTE}s`;
    return `${Math.floor(total / SECONDS_PER_HOUR)}h ${Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)}m`;
}

/** One agent question's wait window, as a `JobQuestion` carries it. */
interface QuestionWait {
    askedAt: string;
    answeredAt: string | null;
}

/**
 * A task's overall wall clock: what the board has banked for the thread so far, plus the head
 * run's live in-flight segment while it is still going (`running` is passed only then — a
 * finished run's stale start stamp would double-count a segment the board already banked). The
 * live segment excludes the time the run waited for an answer, as the board's banking does
 * (`server/src/db/jobs/job-store-rows.ts`, `wallTickFragment`). A dash where nothing has been banked
 * and nothing is going: null means "no clock", which is not zero. Pure, like `runDuration` — the
 * caller decides what "now" is, and the detail page's 2s poll is the ticker.
 */
export function wallClock(
    totalMs: number | null | undefined,
    running: { startedAt: string | null; questions: readonly QuestionWait[] } | null,
    now: Date = new Date()
): string {
    const banked = totalMs ?? 0; // feeds the sum only — the null contract is the dash branch below
    let live = 0;
    if (running?.startedAt) {
        const from = new Date(running.startedAt).getTime();
        if (!Number.isNaN(from)) {
            live = Math.max(0, now.getTime() - from - questionWaitMs(running.questions, from, now.getTime()));
        }
    }
    if (totalMs == null && live === 0) return '—';
    return duration((banked + live) / MS_PER_HOUR);
}

/**
 * The time a run started at `since` spent waiting for an answer up to `now`: its questions'
 * `askedAt → answeredAt` windows (a pending one waits up to `now`), merged where they overlap. A
 * question asked before `since` belongs to an earlier attempt and is not this run's wait.
 */
function questionWaitMs(questions: readonly QuestionWait[], since: number, now: number): number {
    const windows = questions
        .map((q) => [Date.parse(q.askedAt), q.answeredAt === null ? now : Date.parse(q.answeredAt)] as const)
        .filter(([asked, answered]) => asked >= since && answered > asked)
        .map(([asked, answered]) => [asked, Math.min(answered, now)] as const)
        .sort((a, b) => a[0] - b[0]);
    let waited = 0;
    let reach = since;
    for (const [asked, answered] of windows) {
        const from = Math.max(asked, reach);
        if (answered > from) waited += answered - from;
        reach = Math.max(reach, answered);
    }
    return waited;
}

/**
 * Names every repo rather than reporting a count. "3 repositories combined" hides which three,
 * and the figures are only interpretable if you know what went into them.
 */
export function describeRepos(repos: { owner: string; name: string }[]): string {
    if (!repos.length) return 'no repositories configured';
    const owners = new Set(repos.map((r) => r.owner));
    // One owner is the common case, so repeating it on every entry is noise.
    if (owners.size === 1 && repos.length > 1) {
        return `${[...owners][0]}/{${repos.map((r) => r.name).join(', ')}}`;
    }
    return repos.map((r) => `${r.owner}/${r.name}`).join(', ');
}

const TOKENS_THOUSAND = 1000;
const TOKENS_MILLION = 1_000_000;
const TOKENS_BILLION = 1_000_000_000;

/**
 * Rounded on purpose. The branch attribution behind these figures is a ~20s sample from a
 * hook that is allowed to fail, so "92.4k" is the honest precision and "92,431" is not.
 */
export function tokens(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    if (value < TOKENS_THOUSAND) return String(Math.round(value));
    if (value < TOKENS_MILLION) return `${num(value / TOKENS_THOUSAND, 1)}k`;
    // Billions are routine once cache reads are counted — a real run showed 4.5e9, which
    // rendered as the unreadable "4543.89M" before this branch existed.
    if (value < TOKENS_BILLION) return `${num(value / TOKENS_MILLION, 2)}M`;
    return `${num(value / TOKENS_BILLION, 2)}B`;
}

/**
 * The exact integer, grouped for reading: 1234567 renders "1,234,567", never "1.2M". The
 * rounded forms live in `num` and `tokens`; a caller asking for exact means it — counts of
 * sessions, runs and decisions are small enough to read whole and sum by hand.
 */
export function int(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return Math.round(value).toLocaleString('en-US');
}

/**
 * How long ago an instant was, against an injected `now` (pure; the caller owns the clock).
 * A stamp slightly in the future — clock skew, never real — still reads as "just now"
 * rather than a negative age, and past a month the date itself takes over: "203d ago" is a
 * guess wearing a number, "2026-01-28" is a fact.
 */
const MS_PER_SECOND = 1000;
/** Past this many days, `relativeTime` gives up on relative words and reports the date. */
const RELATIVE_TIME_DAYS_LIMIT = 30;

export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
    if (!iso) return '—';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '—';
    const seconds = Math.max(0, (now.getTime() - at.getTime()) / MS_PER_SECOND);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < RELATIVE_TIME_DAYS_LIMIT) return `${days}d ago`;
    return commitDate(iso);
}

/**
 * The full precise stamp: `YYYY-MM-DD HH:MM:SS`, UTC like every formatter here. `taskTime`'s
 * minutes are not enough when two events land inside the same one — a run's start and its
 * verdict frequently do.
 */
/** The length of `YYYY-MM-DDTHH:MM:SS` within an ISO stamp — before the fractional seconds. */
const ISO_SECONDS_PRECISION_LENGTH = 19;

export function timestamp(iso: string | null | undefined): string {
    if (!iso) return '—';
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '—';
    return at.toISOString().slice(0, ISO_SECONDS_PRECISION_LENGTH).replace('T', ' ');
}

/**
 * A window's span in UTC days: "2026-04-15 → 2026-08-21 UTC". An unmeasured end — an
 * all-time range has no `to`, a store with no coverage has no `from` — stays an em dash
 * rather than silently reading as now.
 */
export function utcRange(from: string | null | undefined, to: string | null | undefined): string {
    const day = (iso: string | null | undefined): string | null => {
        if (!iso) return null;
        const at = new Date(iso);
        return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
    };
    const fromDay = day(from);
    const toDay = day(to);
    if (fromDay === null && toDay === null) return '—';
    return `${fromDay ?? '—'} → ${toDay ?? '—'} UTC`;
}

/**
 * Input and output side by side for a table cell, each through `tokens()`. The pair is the
 * only valid combined view — cache reads and writes stay out — and the null contract is
 * per figure: an unmeasured side is an em dash, never a coerced zero.
 */
export function tokenPair(t: { input: number | null; output: number | null }): string {
    return `${tokens(t.input)} / ${tokens(t.output)}`;
}
