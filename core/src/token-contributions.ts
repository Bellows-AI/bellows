/**
 * Token observations reduced to contributions: the one pure definition of "how much, when, and how
 * sure" that run activity, ownership and the SQL views are checked against. Observations are the
 * raw counter readings; a contribution is the amount one reading adds to its series, before any
 * ownership or display grouping.
 *
 * A token amount is per type (uncached input, cache read, cache write, output) and never totalled
 * across types. A type that was not measured is `null`; a measured zero is `0`.
 */
import { dayKey, weekStart } from './metrics.js';

export type TokenType = 'input' | 'output' | 'cacheRead' | 'cacheCreation';
export type TokenFields = Record<TokenType, number | null>;
export type TokenTemporality = 'delta' | 'cumulative' | 'unspecified';
export type TokenSource = 'otel' | 'transcript';

/** One raw reading as stored; `attrs` are the retained attributes (model and query_source among them). */
export interface TokenObservation {
    agent: string;
    sessionId: string | null;
    source: TokenSource;
    metric: string;
    field: TokenType;
    temporality: TokenTemporality;
    startTime: string | null;
    time: string;
    value: number;
    attrs: Readonly<Record<string, string>>;
}

/** Which pipeline owns a session's tokens. A null session is its own group per agent. */
export interface SelectionKey {
    agent: string;
    sessionId: string | null;
}

/** One counter's identity. `attrsKey` is the sorted retained attributes, so attribute order never matters. */
export interface SeriesKey extends SelectionKey {
    metric: string;
    field: TokenType;
    temporality: TokenTemporality;
    startTime: string | null;
    attrsKey: string;
}

/**
 * timed: placed at `observedAt` and counted in a range; unlocated: a known amount with no temporal
 * support; unresolved: temporality unspecified, never added; suppressed: lost source selection,
 * kept as a diagnostic.
 */
export type ContributionKind = 'timed' | 'unlocated' | 'unresolved' | 'suppressed';

/** exact: a delta point; estimated: a cumulative high-water increase; unlocated: no placement is claimed. */
export type Precision = 'exact' | 'estimated' | 'unlocated';

export type ContributionReason =
    | 'cumulative-increase'
    | 'cumulative-anomaly-decrease'
    | 'cumulative-first-unlocated'
    | 'unspecified-temporality'
    | 'mixed-temporality'
    | 'null-session'
    | 'legacy-series-ambiguous'
    | 'source-suppressed'
    | 'unknown-model'
    | 'unknown-query-source';

export interface TokenContribution {
    selection: SelectionKey;
    source: TokenSource;
    series: SeriesKey;
    /** Raw retained values; null when missing or empty. Group through `normalizeModel`. */
    model: string | null;
    querySource: string | null;
    /** Exactly the series' field is set (a measured zero stays 0); the other three stay null. */
    tokens: TokenFields;
    /** Null for unlocated contributions. */
    observedAt: string | null;
    /** The interval the amount may belong to; an estimate is not a claim of per-request timing. */
    support: { from: string; to: string } | null;
    kind: ContributionKind;
    precision: Precision;
    reasons: ContributionReason[];
}

export const UNKNOWN_BUCKET = 'unknown';

const MODEL_ATTR = 'model';
const QUERY_SOURCE_ATTR = 'query_source';
const SESSION_ATTR = 'session.id';
const SERIES_ATTR = 'series';
const TYPE_ATTR = 'type';
const LONG_CONTEXT_SUFFIX = '[1m]';

function isMissing(raw: string | null | undefined): boolean {
    return raw === null || raw === undefined || raw.trim() === '';
}

/** Strips one exact terminal `[1m]`; case, provider prefixes and every other variant stay. Run after reduction. */
export function normalizeModel(raw: string | null | undefined): string {
    if (isMissing(raw)) return UNKNOWN_BUCKET;
    const model = raw as string;
    const stripped = model.endsWith(LONG_CONTEXT_SUFFIX) ? model.slice(0, -LONG_CONTEXT_SUFFIX.length) : model;
    return stripped === '' ? UNKNOWN_BUCKET : stripped;
}

export function normalizeQuerySource(raw: string | null | undefined): string {
    return isMissing(raw) ? UNKNOWN_BUCKET : (raw as string);
}

function emptyTokens(): TokenFields {
    return { input: null, output: null, cacheRead: null, cacheCreation: null };
}

function tokensOf(field: TokenType, value: number): TokenFields {
    return { ...emptyTokens(), [field]: value };
}

function epoch(iso: string): number {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw new RangeError(`invalid timestamp: ${iso}`);
    return ms;
}

function compareText(a: string, b: string): number {
    if (a < b) return -1;
    return a > b ? 1 : 0;
}

/** Sorted `[key, value]` pairs of the retained attributes, minus the ones the key carries already. */
function canonicalAttrs(attrs: Readonly<Record<string, string>>): string {
    const pairs = Object.entries(attrs)
        .filter(([key]) => key !== SESSION_ATTR && key !== TYPE_ATTR)
        .sort(([a], [b]) => compareText(a, b));
    return JSON.stringify(pairs);
}

function seriesKeyOf(o: TokenObservation): SeriesKey {
    return {
        agent: o.agent,
        sessionId: o.sessionId,
        metric: o.metric,
        field: o.field,
        temporality: o.temporality,
        startTime: o.startTime,
        attrsKey: canonicalAttrs(o.attrs),
    };
}

const seriesId = (k: SeriesKey): string =>
    JSON.stringify([k.agent, k.sessionId, k.metric, k.field, k.temporality, k.startTime, k.attrsKey]);
const selectionId = (k: SelectionKey): string => JSON.stringify([k.agent, k.sessionId]);

/** Time, then value, then the whole identity: the same input set sorts the same whatever its arrival order. */
function sortObservations(observations: readonly TokenObservation[]): TokenObservation[] {
    const keyed = observations.map((o) => ({ o, at: epoch(o.time), id: seriesId(seriesKeyOf(o)) }));
    keyed.sort(
        (a, b) => a.at - b.at || a.o.value - b.o.value || compareText(a.id, b.id) || compareText(a.o.source, b.o.source)
    );
    return keyed.map((k) => k.o);
}

function clean(raw: string | undefined): string | null {
    return isMissing(raw) ? null : (raw as string);
}

function build(
    o: TokenObservation,
    key: SeriesKey,
    parts: Pick<TokenContribution, 'kind' | 'precision' | 'observedAt' | 'support' | 'tokens'> & {
        reasons: ContributionReason[];
    }
): TokenContribution {
    const model = clean(o.attrs[MODEL_ATTR]);
    const querySource = clean(o.attrs[QUERY_SOURCE_ATTR]);
    const reasons = [...parts.reasons];
    if (o.sessionId === null) reasons.push('null-session');
    if (model === null) reasons.push('unknown-model');
    if (querySource === null) reasons.push('unknown-query-source');
    return {
        selection: { agent: o.agent, sessionId: o.sessionId },
        source: o.source,
        series: key,
        model,
        querySource,
        kind: parts.kind,
        precision: parts.precision,
        observedAt: parts.observedAt,
        support: parts.support,
        tokens: parts.tokens,
        reasons,
    };
}

/** OTEL owns a (agent, session) as soon as it has any observation there; the transcript's become diagnostics. */
function splitBySource(observations: readonly TokenObservation[]): {
    selected: TokenObservation[];
    suppressed: TokenObservation[];
} {
    const otel = new Set<string>();
    for (const o of observations) if (o.source === 'otel') otel.add(selectionId(o));
    const selected: TokenObservation[] = [];
    const suppressed: TokenObservation[] = [];
    for (const o of observations)
        (o.source === 'transcript' && otel.has(selectionId(o)) ? suppressed : selected).push(o);
    return { selected, suppressed };
}

/** `key` is the group's series: a folded legacy reading reports the digest series it joined. */
function reduceCumulative(key: SeriesKey, series: readonly TokenObservation[], out: TokenContribution[]): void {
    let highWater: number | null = null;
    let highWaterAt = '';
    for (const o of series) {
        if (highWater === null) {
            highWater = o.value;
            highWaterAt = o.time;
            out.push(
                o.startTime === null
                    ? build(o, key, {
                          kind: 'unlocated',
                          precision: 'unlocated',
                          observedAt: null,
                          support: null,
                          tokens: tokensOf(o.field, o.value),
                          reasons: ['cumulative-first-unlocated'],
                      })
                    : build(o, key, {
                          kind: 'timed',
                          precision: 'estimated',
                          observedAt: o.time,
                          support: { from: o.startTime, to: o.time },
                          tokens: tokensOf(o.field, o.value),
                          reasons: ['cumulative-increase'],
                      })
            );
            continue;
        }
        const support = { from: highWaterAt, to: o.time };
        if (o.value <= highWater) {
            out.push(
                build(o, key, {
                    kind: 'timed',
                    precision: 'estimated',
                    observedAt: o.time,
                    support,
                    tokens: tokensOf(o.field, 0),
                    reasons: o.value < highWater ? ['cumulative-anomaly-decrease'] : [],
                })
            );
            continue;
        }
        out.push(
            build(o, key, {
                kind: 'timed',
                precision: 'estimated',
                observedAt: o.time,
                support,
                tokens: tokensOf(o.field, o.value - highWater),
                reasons: ['cumulative-increase'],
            })
        );
        highWater = o.value;
        highWaterAt = o.time;
    }
}

/** Checks every reading and returns copies whose times are canonical ISO, so one instant is one series. */
function validate(observations: readonly TokenObservation[]): TokenObservation[] {
    return observations.map((o) => {
        const time = new Date(epoch(o.time)).toISOString();
        if (!Number.isFinite(o.value) || o.value < 0) throw new RangeError(`invalid token value: ${o.value}`);
        const startTime = o.startTime === null ? null : new Date(epoch(o.startTime)).toISOString();
        return { ...o, time, startTime };
    });
}

/** A point that stands alone: a delta lands at its own time, an unspecified one is carried unresolved. */
function reducePoint(o: TokenObservation): TokenContribution {
    const isDelta = o.temporality === 'delta';
    return build(o, seriesKeyOf(o), {
        kind: isDelta ? 'timed' : 'unresolved',
        precision: isDelta ? 'exact' : 'unlocated',
        observedAt: o.time,
        support: isDelta ? { from: o.time, to: o.time } : null,
        tokens: tokensOf(o.field, o.value),
        reasons: isDelta ? [] : ['unspecified-temporality'],
    });
}

function reduceSuppressed(o: TokenObservation): TokenContribution {
    return build(o, seriesKeyOf(o), {
        kind: 'suppressed',
        precision: 'unlocated',
        observedAt: o.time,
        support: null,
        tokens: tokensOf(o.field, o.value),
        reasons: ['source-suppressed'],
    });
}

/** The series identity with the ingest `series` digest left out: what a pre-digest (legacy) row can match on. */
function foldIdOf(o: TokenObservation): string {
    const { [SERIES_ATTR]: _digest, ...rest } = o.attrs;
    return seriesId({ ...seriesKeyOf(o), attrsKey: canonicalAttrs(rest) });
}

const hasDigest = (o: TokenObservation): boolean => o.attrs[SERIES_ATTR] !== undefined;

/**
 * Rows stored before the ingest digest carry no `series`; a counter live across that deploy has both
 * kinds. A legacy series folds into the one digest series equal in every other component (one counter,
 * never counted twice); with none it stands alone; with several it is ambiguous and never added.
 * The verdict depends on the siblings in the observations given: a sibling first seen after the
 * window can turn a fold into ambiguous in a later query — never into a double count.
 */
function groupCumulative(cumulative: readonly TokenObservation[]): {
    groups: Map<string, { key: SeriesKey; series: TokenObservation[] }>;
    ambiguous: TokenObservation[];
} {
    const siblings = new Map<string, Map<string, SeriesKey>>();
    for (const o of cumulative.filter(hasDigest)) {
        const fold = foldIdOf(o);
        const key = seriesKeyOf(o);
        const found = siblings.get(fold) ?? new Map<string, SeriesKey>();
        siblings.set(fold, found.set(seriesId(key), key));
    }
    const groups = new Map<string, { key: SeriesKey; series: TokenObservation[] }>();
    const ambiguous: TokenObservation[] = [];
    for (const o of cumulative) {
        const found = hasDigest(o) ? undefined : siblings.get(foldIdOf(o));
        if (found && found.size > 1) {
            ambiguous.push(o);
            continue;
        }
        const [id, key] = found ? [...found][0]! : [seriesId(seriesKeyOf(o)), seriesKeyOf(o)];
        const group = groups.get(id);
        if (group) group.series.push(o);
        else groups.set(id, { key, series: [o] });
    }
    return { groups, ambiguous };
}

function reduceAmbiguousLegacy(o: TokenObservation): TokenContribution {
    return build(o, seriesKeyOf(o), {
        kind: 'unresolved',
        precision: 'unlocated',
        observedAt: o.time,
        support: null,
        tokens: tokensOf(o.field, o.value),
        reasons: ['legacy-series-ambiguous'],
    });
}

const mixKeyOf = (k: SelectionKey & { field: TokenType }): string => JSON.stringify([k.agent, k.sessionId, k.field]);

/**
 * Reduces readings to contributions, deterministically: the output depends on the set of
 * observations, not their order. Delta points land at their own time; a cumulative series adds its
 * running-maximum increases at the reading that raised it (an estimate); a lower reading is an
 * anomaly of the same start-time series, never a restart, and a distinct start time is a new series.
 */
export function reduceTokenObservations(observations: readonly TokenObservation[]): TokenContribution[] {
    const { selected, suppressed } = splitBySource(sortObservations(validate(observations)));
    const out: TokenContribution[] = [];
    const cumulative: TokenObservation[] = [];
    const temporalities = new Map<string, Set<TokenTemporality>>();

    for (const o of selected) {
        const mix = mixKeyOf(o);
        temporalities.set(mix, (temporalities.get(mix) ?? new Set()).add(o.temporality));
        if (o.temporality !== 'cumulative') {
            out.push(reducePoint(o));
            continue;
        }
        cumulative.push(o);
    }
    const { groups, ambiguous } = groupCumulative(cumulative);
    for (const { key, series } of groups.values()) reduceCumulative(key, series, out);
    out.push(...ambiguous.map(reduceAmbiguousLegacy));

    for (const c of out) {
        const seen = temporalities.get(mixKeyOf(c.series));
        if (seen?.has('delta') && seen.has('cumulative') && c.series.temporality !== 'unspecified') {
            c.reasons.push('mixed-temporality');
        }
    }
    out.push(...suppressed.map(reduceSuppressed));
    return sortContributions(out);
}

const KIND_ORDER = ['timed', 'unlocated', 'unresolved', 'suppressed'];

/** Sorts on keys computed once per contribution, not once per comparison. */
function sortContributions(out: TokenContribution[]): TokenContribution[] {
    const keyed = out.map((c) => ({
        c,
        at: c.observedAt === null ? Number.NEGATIVE_INFINITY : epoch(c.observedAt),
        kind: KIND_ORDER.indexOf(c.kind),
        series: seriesId(c.series),
        tokens: JSON.stringify(c.tokens),
        reasons: c.reasons.join(),
    }));
    keyed.sort(
        (a, b) =>
            a.at - b.at ||
            a.kind - b.kind ||
            compareText(a.series, b.series) ||
            compareText(a.tokens, b.tokens) ||
            compareText(a.c.source, b.c.source) ||
            compareText(a.reasons, b.reasons)
    );
    return keyed.map((k) => k.c);
}

export interface RangePartition {
    /** Timed contributions with `from <= observedAt < to`: each belongs to exactly one of any adjacent ranges. */
    timed: TokenContribution[];
    /** Never additive in a range; the same ones come back for every range. */
    unlocated: TokenContribution[];
    unresolved: TokenContribution[];
    suppressed: TokenContribution[];
}

/** Splits contributions for `[from, to)`. Timed ones outside the range are dropped, diagnostics stay whole. */
export function partitionByRange(
    contributions: readonly TokenContribution[],
    from: string,
    to: string
): RangePartition {
    const start = epoch(from);
    const end = epoch(to);
    const partition: RangePartition = { timed: [], unlocated: [], unresolved: [], suppressed: [] };
    for (const c of contributions) {
        if (c.kind !== 'timed') {
            partition[c.kind].push(c);
        } else if (c.observedAt !== null) {
            const at = epoch(c.observedAt);
            if (at >= start && at < end) partition.timed.push(c);
        }
    }
    return partition;
}

export type TokenBucketGranularity = 'day' | 'week';

export interface TokenBucket {
    /** `YYYY-MM-DD` of the UTC day, or of the Monday the UTC ISO week starts on. */
    start: string;
    /** Null for a type with no contribution in the bucket; a measured zero stays 0. */
    tokens: TokenFields;
}

const TOKEN_TYPES: readonly TokenType[] = ['input', 'output', 'cacheRead', 'cacheCreation'];

/** Sums timed contributions into UTC day or week buckets by observation time; only non-empty buckets, in order. */
export function bucketTimedContributions(
    timed: readonly TokenContribution[],
    granularity: TokenBucketGranularity
): TokenBucket[] {
    const buckets = new Map<string, TokenFields>();
    for (const c of timed) {
        if (c.kind !== 'timed' || c.observedAt === null) continue;
        const start = granularity === 'day' ? dayKey(c.observedAt) : weekStart(c.observedAt).toISOString().slice(0, 10);
        const tokens = buckets.get(start) ?? emptyTokens();
        for (const type of TOKEN_TYPES) {
            const amount = c.tokens[type];
            if (amount !== null) tokens[type] = (tokens[type] ?? 0) + amount;
        }
        buckets.set(start, tokens);
    }
    return [...buckets.entries()].sort(([a], [b]) => compareText(a, b)).map(([start, tokens]) => ({ start, tokens }));
}
