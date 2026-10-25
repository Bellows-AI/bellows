/**
 * The one usage reducer: owned, scoped, range-filtered contributions in, `UsageBlock`s out. For every
 * view and per token type, eligible timed = assigned + sum(unassigned). Unlocated, unresolved and
 * tenant-bound conflicts live beside the eligible set, never inside it.
 */
import { dayKey, weekStart } from './metrics.js';
import {
    type TokenContribution,
    type TokenType,
    normalizeModel,
    normalizeQuerySource,
    partitionByRange,
} from './token-contributions.js';
import { type Destination, type Timeline, assignContribution, buildTimeline } from './usage-segments.js';
import { canonicalTask, resolveOwnership, sessionKeyId } from './usage-ownership.js';
import {
    type ExecutionEvidence,
    type Owner,
    type RunUsage,
    type SessionSpan,
    type TaskUsage,
    type Tokens,
    type UnassignedReason,
    type UsageBlock,
    type UsageInput,
    type UsageOptions,
    type UsagePolicy,
    type UsagePrecision,
    type UsageReport,
    type UsageRow,
    type UserUsage,
    TOKEN_TYPE_LIST,
    UNASSIGNED_REASONS,
    addTokens,
    compareText,
    emptyBlock,
    epochMs,
    perType,
    resolvePolicy,
    unmeasuredTokens,
} from './usage.js';
import { UNKNOWN_BUCKET } from './token-contributions.js';

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60_000;
const DAY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * MS_PER_MINUTE;
const WEEK_DAYS = 7;

interface Item {
    c: TokenContribution;
    keyId: string;
    taskId: string | null;
    authorId: string | null;
    dest: Destination;
    /** The key's task has a live execution: this amount may still move. */
    live: boolean;
}
interface Extra {
    c: TokenContribution;
    keyId: string;
    taskId: string | null;
}

const tokensOfType = (tokens: Tokens, type: TokenType): number | null => tokens[type];

function sumItems(contribs: readonly TokenContribution[]): Tokens {
    return contribs.reduce((acc, c) => addTokens(acc, c.tokens), unmeasuredTokens());
}

function precisionOf(contribs: readonly TokenContribution[], type: TokenType): UsagePrecision | null {
    const kinds = new Set(contribs.filter((c) => c.tokens[type] !== null).map((c) => c.precision));
    if (kinds.size === 0) return null;
    if (kinds.size === 1) return kinds.has('exact') ? 'exact' : 'estimated';
    return 'mixed';
}

function buildRows(contribs: readonly TokenContribution[]): UsageRow[] {
    interface Node {
        raw: Set<string>;
        tokens: Tokens;
    }
    const parents = new Map<string, Node & { children: Map<string, Node> }>();
    for (const c of contribs) {
        const model = normalizeModel(c.model);
        const source = normalizeQuerySource(c.querySource);
        const parent = parents.get(model) ?? { raw: new Set(), tokens: unmeasuredTokens(), children: new Map() };
        const child = parent.children.get(source) ?? { raw: new Set(), tokens: unmeasuredTokens() };
        if (c.model !== null) {
            parent.raw.add(c.model);
            child.raw.add(c.model);
        }
        parent.tokens = addTokens(parent.tokens, c.tokens);
        child.tokens = addTokens(child.tokens, c.tokens);
        parent.children.set(source, child);
        parents.set(model, parent);
    }
    const order = (a: string, b: string): number =>
        a === UNKNOWN_BUCKET ? (b === UNKNOWN_BUCKET ? 0 : 1) : b === UNKNOWN_BUCKET ? -1 : compareText(a, b);
    return [...parents.entries()]
        .sort(([a], [b]) => order(a, b))
        .map(([model, parent]) => ({
            model,
            rawModels: [...parent.raw].sort(compareText),
            querySource: null,
            tokens: parent.tokens,
            children: [...parent.children.entries()]
                .sort(([a], [b]) => order(a, b))
                .map(([source, child]) => ({
                    model,
                    rawModels: [...child.raw].sort(compareText),
                    querySource: source,
                    tokens: child.tokens,
                })),
        }));
}

function buildBlock(items: readonly Item[], extras: readonly Extra[], endsAfterNow: boolean): UsageBlock {
    if (items.length === 0 && extras.length === 0) return { ...emptyBlock('unmeasured'), provisional: endsAfterNow };
    const contribs = items.map((i) => i.c);
    const tokens = sumItems(contribs);
    const reasons = new Map<UnassignedReason, Item[]>();
    const assignedItems: Item[] = [];
    for (const item of items) {
        if (item.dest.kind === 'run') assignedItems.push(item);
        else reasons.set(item.dest.reason, [...(reasons.get(item.dest.reason) ?? []), item]);
    }
    const keys = new Set(items.map((i) => i.keyId));
    const unlocated = extras.filter((e) => e.c.kind === 'unlocated').map((e) => e.c);
    return {
        state: TOKEN_TYPE_LIST.some((t) => tokens[t] !== null) ? 'measured' : 'unmeasured',
        provisional: endsAfterNow || items.some((i) => i.live),
        tokens,
        assigned: sumItems(assignedItems.map((i) => i.c)),
        unassigned: UNASSIGNED_REASONS.filter((r) => reasons.has(r)).map((reason) => ({
            reason,
            tokens: sumItems((reasons.get(reason) as Item[]).map((i) => i.c)),
        })),
        unlocated: sumItems(unlocated),
        unresolvedTemporality: { observations: extras.filter((e) => e.c.kind === 'unresolved').length },
        precision: perType((type) => precisionOf(contribs, type)),
        coverage: perType((type) => ({
            measured: new Set(items.filter((i) => tokensOfType(i.c.tokens, type) !== null).map((i) => i.keyId)).size,
            contributors: keys.size,
        })),
        rows: buildRows(contribs),
        counts: {
            sessions: keys.size,
            runs: new Set(assignedItems.map((i) => (i.dest as { jobId: string }).jobId)).size,
            tasks: new Set(items.map((i) => i.taskId).filter((t) => t !== null)).size,
        },
    };
}

interface Account {
    items: Item[];
    extras: Extra[];
    owners: Map<string, Owner>;
    unresolvedOwnership: { keys: Set<string>; tokens: Tokens };
    excludedRepo: { keys: Set<string>; tokens: Tokens };
    board: ExecutionEvidence[];
}

function spanOverlaps(
    span: { firstSeen: string; lastSeen: string } | undefined,
    range: UsageOptions['range']
): boolean {
    if (range === null) return true;
    if (!span) return false;
    return epochMs(span.firstSeen) < epochMs(range.to) && epochMs(span.lastSeen) >= epochMs(range.from);
}

type ResolvedOwner = Extract<Owner, { status: 'resolved' }>;

interface Scope {
    userId: string | undefined;
    repos: readonly string[];
}

/** 'in' passes the user scope and repo filter; 'excluded-repo' failed the repo filter; 'out' is shown nowhere. */
function scopeOf(owner: Owner, scope: Scope): 'in' | 'excluded-repo' | 'out' {
    if (owner.status !== 'resolved') return 'out';
    if (scope.userId !== undefined && owner.authorId !== scope.userId) return 'out';
    if (scope.repos.length > 0 && (owner.repo === null || !scope.repos.includes(owner.repo))) return 'excluded-repo';
    return 'in';
}

interface ExtraContext {
    owners: ReadonlyMap<string, Owner>;
    spans: ReadonlyMap<string, SessionSpan>;
    scope: Scope;
    range: UsageOptions['range'];
}

function collectExtras(contribs: readonly TokenContribution[], ctx: ExtraContext): Extra[] {
    const { owners, spans, scope, range } = ctx;
    const extras: Extra[] = [];
    for (const c of contribs) {
        const keyId = sessionKeyId(c.selection.agent, c.selection.sessionId as string);
        const owner = owners.get(keyId) as Owner;
        if (scopeOf(owner, scope) !== 'in' || !spanOverlaps(spans.get(keyId), range)) continue;
        extras.push({ c, keyId, taskId: (owner as ResolvedOwner).taskId });
    }
    return extras;
}

function timelineCache(board: readonly ExecutionEvidence[], policy: UsagePolicy) {
    const timelines = new Map<string, Timeline>();
    return (keyId: string, agent: string, sessionId: string, taskId: string): Timeline => {
        const cached = timelines.get(keyId);
        if (cached) return cached;
        const rows = board.filter(
            (e) => e.sessionId === sessionId && (e.agent === null || e.agent === agent) && canonicalTask(e) === taskId
        );
        const built = buildTimeline(rows, policy);
        timelines.set(keyId, built);
        return built;
    };
}

function account(input: UsageInput, opts: UsageOptions): Account {
    const policy = resolvePolicy(opts.policy);
    const { range } = opts;
    const owned = input.contributions.filter((c) => c.selection.sessionId !== null);
    const keys = owned.map((c) => ({ agent: c.selection.agent, sessionId: c.selection.sessionId as string }));
    const owners = resolveOwnership(input, keys, policy);
    const board = input.board.filter((e) => e.orgId === input.orgId);
    const spans = new Map(input.spans.map((s) => [sessionKeyId(s.agent, s.sessionId), s]));
    const scope: Scope = { userId: opts.userId, repos: opts.repos ?? [] };

    const part = range
        ? partitionByRange(owned, range.from, range.to)
        : {
              timed: owned.filter((c) => c.kind === 'timed'),
              unlocated: owned.filter((c) => c.kind === 'unlocated'),
              unresolved: owned.filter((c) => c.kind === 'unresolved'),
          };

    const timelineOf = timelineCache(board, policy);

    const out: Account = {
        items: [],
        extras: [],
        owners,
        unresolvedOwnership: { keys: new Set(), tokens: unmeasuredTokens() },
        excludedRepo: { keys: new Set(), tokens: unmeasuredTokens() },
        board,
    };
    const tally = (bucket: Account['excludedRepo'], keyId: string, c: TokenContribution): void => {
        bucket.keys.add(keyId);
        bucket.tokens = addTokens(bucket.tokens, c.tokens);
    };

    for (const c of part.timed) {
        const { agent, sessionId } = c.selection;
        const keyId = sessionKeyId(agent, sessionId as string);
        const owner = owners.get(keyId) as Owner;
        if (owner.status === 'unresolved') {
            tally(out.unresolvedOwnership, keyId, c);
            continue;
        }
        const where = scopeOf(owner, scope);
        if (where === 'excluded-repo') tally(out.excludedRepo, keyId, c);
        if (where !== 'in') continue;
        const resolved = owner as ResolvedOwner;
        const timeline =
            resolved.taskId === null ? null : timelineOf(keyId, agent, sessionId as string, resolved.taskId);
        out.items.push({
            c,
            keyId,
            taskId: resolved.taskId,
            authorId: resolved.authorId,
            dest: timeline ? assignContribution(timeline, c) : { kind: 'unassigned', reason: 'no-task' },
            live: timeline?.live ?? false,
        });
    }

    out.extras = collectExtras([...part.unlocated, ...part.unresolved], { owners, spans, scope, range });
    return out;
}

function runsOf(board: readonly ExecutionEvidence[], taskId: string): Map<string, ExecutionEvidence[]> {
    const runs = new Map<string, ExecutionEvidence[]>();
    for (const e of board) {
        if (canonicalTask(e) !== taskId) continue;
        runs.set(e.jobId, [...(runs.get(e.jobId) ?? []), e]);
    }
    return runs;
}

function runUsage(jobId: string, rows: readonly ExecutionEvidence[], items: readonly Item[]): RunUsage {
    const first = rows[0] as ExecutionEvidence;
    const starts = rows.map((r) => r.startedAt).sort(compareText);
    const open = rows.some((r) => r.endedAt === null);
    const ends = rows.map((r) => r.endedAt).filter((e): e is string => e !== null);
    const review = rows.find((r) => r.requestingJobId !== null);
    return {
        jobId,
        kind: review ? 'review' : jobId === first.rootJobId ? 'run' : 'follow-up',
        reviewOf: review?.requestingJobId ?? null,
        live: rows.some((r) => r.live),
        operational: rows.some((r) => r.operational),
        startedAt: starts[0] ?? null,
        endedAt: open ? null : (ends.sort(compareText).at(-1) ?? null),
        usage: buildBlock(items, [], false),
    };
}

function taskView(acc: Account, taskId: string, includeIdleRuns: boolean): TaskUsage {
    const items = acc.items.filter((i) => i.taskId === taskId);
    const extras = acc.extras.filter((e) => e.taskId === taskId);
    const rowsByRun = runsOf(acc.board, taskId);
    const assigned = new Map<string, Item[]>();
    for (const item of items) {
        if (item.dest.kind !== 'run') continue;
        assigned.set(item.dest.jobId, [...(assigned.get(item.dest.jobId) ?? []), item]);
    }
    const jobIds = includeIdleRuns ? [...rowsByRun.keys()] : [...assigned.keys()];
    const runs = jobIds
        .filter((id) => rowsByRun.has(id))
        .map((id) => runUsage(id, rowsByRun.get(id) as ExecutionEvidence[], assigned.get(id) ?? []))
        .sort((a, b) => compareText(a.startedAt ?? '', b.startedAt ?? '') || compareText(a.jobId, b.jobId));
    const taskOwnedItems = items.filter((i) => i.dest.kind === 'unassigned');
    return {
        taskId,
        removed: [...rowsByRun.values()].flat().some((r) => r.removed),
        usage: buildBlock(items, extras, false),
        runs,
        taskOwned: taskOwnedItems.length > 0 || extras.length > 0 ? buildBlock(taskOwnedItems, extras, false) : null,
    };
}

function bucketStart(iso: string, granularity: 'day' | 'week'): string {
    return granularity === 'day' ? dayKey(iso) : weekStart(iso).toISOString().slice(0, 10);
}

function series(items: readonly Item[], granularity: 'day' | 'week', now: Date): UsageReport['series'] {
    if (items.length === 0) return [];
    const buckets = new Map<string, Item[]>();
    for (const item of items) {
        const start = bucketStart(item.c.observedAt as string, granularity);
        buckets.set(start, [...(buckets.get(start) ?? []), item]);
    }
    const starts = [...buckets.keys()].sort(compareText);
    const stepDays = granularity === 'day' ? 1 : WEEK_DAYS;
    const current = bucketStart(now.toISOString(), granularity);
    const out: UsageReport['series'] = [];
    const cursor = new Date(`${starts[0]}T00:00:00.000Z`);
    const last = new Date(`${starts.at(-1)}T00:00:00.000Z`);
    while (cursor <= last) {
        const start = cursor.toISOString().slice(0, 10);
        const endsAfterNow = cursor.getTime() + stepDays * DAY_MS > now.getTime();
        const inBucket = buckets.get(start);
        out.push({
            start,
            partial: start === current,
            usage: inBucket
                ? buildBlock(inBucket, [], endsAfterNow)
                : { ...emptyBlock('unmeasured'), provisional: endsAfterNow },
        });
        cursor.setUTCDate(cursor.getUTCDate() + stepDays);
    }
    return out;
}

export function reduceUsage(input: UsageInput, opts: UsageOptions): UsageReport {
    const acc = account(input, opts);
    const rangeEndsAfterNow = opts.range !== null && epochMs(opts.range.to) > opts.now.getTime();
    const taskIds = [...new Set(acc.items.map((i) => i.taskId).filter((t): t is string => t !== null))].sort(
        compareText
    );
    const authors = [...new Set(acc.items.map((i) => i.authorId))].sort((a, b) =>
        a === null ? 1 : b === null ? -1 : compareText(a, b)
    );
    const byUser: UserUsage[] = authors.map((userId) => ({
        userId,
        usage: buildBlock(
            acc.items.filter((i) => i.authorId === userId),
            acc.extras.filter(
                (e) => (acc.owners.get(e.keyId) as Extract<Owner, { status: 'resolved' }>).authorId === userId
            ),
            rangeEndsAfterNow
        ),
    }));
    const withoutHook = new Set(
        acc.items
            .filter((i) => {
                const owner = acc.owners.get(i.keyId) as Extract<Owner, { status: 'resolved' }>;
                return !owner.hook && owner.taskId !== null;
            })
            .map((i) => i.keyId)
    );
    return {
        eligible: buildBlock(acc.items, acc.extras, rangeEndsAfterNow),
        tasks: taskIds.map((id) => taskView(acc, id, false)),
        byUser,
        series: series(acc.items, opts.granularity ?? 'day', opts.now),
        diagnostics: {
            sessionsWithoutHook: withoutHook.size,
            unresolvedOwnership: {
                sessions: acc.unresolvedOwnership.keys.size,
                tokens: acc.unresolvedOwnership.tokens,
            },
            excludedRepo: { sessions: acc.excludedRepo.keys.size, tokens: acc.excludedRepo.tokens },
        },
    };
}

/** All-time usage of one canonical task, reviews folded in, every known run listed. Null when no evidence names it. */
export function taskUsageOf(
    input: UsageInput,
    taskId: string,
    now: Date,
    policy?: UsageOptions['policy']
): TaskUsage | null {
    const acc = account(input, { range: null, now, ...(policy ? { policy } : {}) });
    const known = acc.board.some((e) => canonicalTask(e) === taskId);
    if (!known && !acc.items.some((i) => i.taskId === taskId)) return null;
    return taskView(acc, taskId, true);
}
