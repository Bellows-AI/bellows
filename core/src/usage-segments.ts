/**
 * Run assignment: which run, if any, a contribution belongs to. Segments are half-open
 * `[start, end)`; an open end is +infinity (live, or the end was lost - never guessed). Ambiguity is
 * never resolved by picking: overlap, a gap, an unconfirmed launch or an estimate that does not sit
 * wholly inside one run leaves the amount task-owned and run-unassigned, with a reason.
 */
import type { TokenContribution } from './token-contributions.js';
import { type ExecutionEvidence, type UnassignedReason, epochMs } from './usage.js';

export type Destination = { kind: 'run'; jobId: string } | { kind: 'unassigned'; reason: UnassignedReason };

interface Segment {
    jobId: string;
    claimSeq: number;
    adoptsClaimSeq: number | null;
    start: number;
    end: number;
    confirmed: boolean;
    backfill: boolean;
    live: boolean;
}

/** One run's stretch of time: segments joined by adoption or by touching, so the gap between adopted claims is covered. */
interface Interval {
    jobId: string;
    start: number;
    end: number;
    members: Segment[];
}

export interface Timeline {
    intervals: Interval[];
    refused: { start: number; end: number }[];
    /** Any non-refused segment is live: its points may still move. */
    live: boolean;
    /** A row with no start (backfill): it owns usage it cannot place, so a gap reads `unknown-boundary`, not `no-segment`. */
    unbounded: boolean;
}

function toSegment(e: ExecutionEvidence & { startedAt: string }): Segment {
    const backfill = e.origin === 'backfill';
    return {
        jobId: e.jobId,
        claimSeq: e.claimSeq,
        adoptsClaimSeq: e.adoptsClaimSeq,
        start: epochMs(e.startedAt),
        end: e.endedAt === null ? Number.POSITIVE_INFINITY : epochMs(e.endedAt),
        confirmed: !backfill && (e.launch === 'observed' || e.launch === 'adopted'),
        backfill,
        live: e.live,
    };
}

function mergeJob(segments: Segment[]): Interval[] {
    const sorted = [...segments].sort((a, b) => a.start - b.start || a.claimSeq - b.claimSeq);
    const parent = sorted.map((_, i) => i);
    const find = (i: number): number => {
        let root = i;
        while (parent[root] !== root) root = parent[root] as number;
        return root;
    };
    const unite = (a: number, b: number): void => {
        parent[find(a)] = find(b);
    };
    sorted.forEach((seg, i) => {
        if (seg.adoptsClaimSeq === null) return;
        const target = sorted.findIndex((other) => other.claimSeq === seg.adoptsClaimSeq);
        if (target >= 0) unite(i, target);
    });
    let reach = Number.NEGATIVE_INFINITY;
    let reachIndex = -1;
    sorted.forEach((seg, i) => {
        if (reachIndex >= 0 && seg.start <= reach) unite(i, reachIndex);
        if (seg.end > reach) {
            reach = seg.end;
            reachIndex = i;
        }
    });
    const groups = new Map<number, Segment[]>();
    sorted.forEach((seg, i) => {
        const root = find(i);
        groups.set(root, [...(groups.get(root) ?? []), seg]);
    });
    return [...groups.values()].map((members) => ({
        jobId: members[0]?.jobId as string,
        start: Math.min(...members.map((m) => m.start)),
        end: Math.max(...members.map((m) => m.end)),
        members,
    }));
}

/** `rows` are the board evidence of one session key within one canonical task. */
export function buildTimeline(rows: readonly ExecutionEvidence[]): Timeline {
    const seen = new Set<string>();
    const live: Segment[] = [];
    const refused: Timeline['refused'] = [];
    let unbounded = false;
    for (const row of rows) {
        const id = `${row.jobId}\u0000${row.claimSeq}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (row.startedAt === null) {
            unbounded = true;
            continue;
        }
        const seg = toSegment({ ...row, startedAt: row.startedAt });
        if (row.launch === 'refused') refused.push({ start: seg.start, end: seg.end });
        else live.push(seg);
    }
    const byJob = new Map<string, Segment[]>();
    for (const seg of live) byJob.set(seg.jobId, [...(byJob.get(seg.jobId) ?? []), seg]);
    return {
        intervals: [...byJob.values()].flatMap(mergeJob),
        refused,
        live: live.some((s) => s.live),
        unbounded,
    };
}

const covers = (s: { start: number; end: number }, t: number): boolean => s.start <= t && t < s.end;
const refusedAt = (tl: Timeline, t: number): boolean => tl.refused.some((r) => covers(r, t));

/** Members that touch the stretch, or all of them when the stretch lies in an adoption-bridged gap. */
function relevantMembers(iv: Interval, a: number, b: number): Segment[] {
    const hit = iv.members.filter((m) => (m.start < b && m.end > a) || covers(m, b));
    return hit.length > 0 ? hit : iv.members;
}

function judge(members: readonly Segment[], jobId: string): Destination {
    if (members.some((m) => m.confirmed)) return { kind: 'run', jobId };
    const reason = members.every((m) => m.backfill) ? 'unknown-boundary' : 'unconfirmed-launch';
    return { kind: 'unassigned', reason };
}

function none(tl: Timeline, t: number): Destination {
    if (refusedAt(tl, t)) return { kind: 'unassigned', reason: 'refused-launch' };
    return { kind: 'unassigned', reason: tl.unbounded ? 'unknown-boundary' : 'no-segment' };
}

function assignDelta(tl: Timeline, t: number): Destination {
    const covering = tl.intervals.filter((iv) => covers(iv, t));
    const jobs = new Set(covering.map((iv) => iv.jobId));
    if (jobs.size === 0) return none(tl, t);
    if (jobs.size >= 2) return { kind: 'unassigned', reason: 'overlap' };
    const [iv] = covering as [Interval];
    return judge(relevantMembers(iv, t, t), iv.jobId);
}

function assignCumulative(tl: Timeline, a: number, b: number): Destination {
    const touching = tl.intervals.filter((iv) => (iv.start < b && iv.end > a) || covers(iv, b));
    const jobs = new Set(touching.map((iv) => iv.jobId));
    if (jobs.size === 0) return none(tl, b);
    if (jobs.size >= 2) {
        const atB = new Set(tl.intervals.filter((iv) => covers(iv, b)).map((iv) => iv.jobId));
        return { kind: 'unassigned', reason: atB.size >= 2 ? 'overlap' : 'cumulative-spans-runs' };
    }
    const whole = touching.find((iv) => iv.start <= a && b < iv.end);
    if (!whole) return { kind: 'unassigned', reason: 'cumulative-spans-runs' };
    return judge(relevantMembers(whole, a, b), whole.jobId);
}

/** Exactly one destination per timed contribution: a run, or a reason it has none. */
export function assignContribution(tl: Timeline, c: TokenContribution): Destination {
    if (c.observedAt === null) throw new RangeError('only a timed contribution can be assigned');
    const at = epochMs(c.observedAt);
    if (c.precision === 'estimated' && c.support) return assignCumulative(tl, epochMs(c.support.from), at);
    return assignDelta(tl, at);
}

/** One session key's contributions against its task's evidence rows. */
export function accountContributions(
    rows: readonly ExecutionEvidence[],
    contributions: readonly TokenContribution[]
): Destination[] {
    const timeline = buildTimeline(rows);
    return contributions.map((c) => assignContribution(timeline, c));
}
