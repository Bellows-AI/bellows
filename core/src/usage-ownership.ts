/**
 * Who owns a session key, resolved before any join. A key is `(agent, sessionId)`; at most one owner
 * per key, never a `min()` of competing claims, and nothing about another tenant crosses.
 */
import {
    type BranchEvidence,
    type ExecutionEvidence,
    type Owner,
    type UsageInput,
    type UsagePolicy,
    resolvePolicy,
} from './usage.js';

export interface SessionKey {
    agent: string;
    sessionId: string;
}

export const sessionKeyId = (agent: string, sessionId: string): string => JSON.stringify([agent, sessionId]);

/** A named review counts to its requester; the run id stays the review's own job id. */
export const canonicalTask = (e: Pick<ExecutionEvidence, 'requestingRootJobId' | 'rootJobId'>): string =>
    e.requestingRootJobId ?? e.rootJobId;

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of rows) {
        const key = keyOf(row);
        const list = out.get(key);
        if (list) list.push(row);
        else out.set(key, [row]);
    }
    return out;
}

const distinct = <T>(values: readonly (T | null)[]): T[] => [...new Set(values.filter((v): v is T => v !== null))];

/** Evidence with a null agent matches every agent of its session id; one naming an agent matches only it. */
export const matchesAgent = (evidenceAgent: string | null, agent: string): boolean =>
    evidenceAgent === null || evidenceAgent === agent;

interface Evidence {
    orgId: string;
    boardBySession: Map<string, ExecutionEvidence[]>;
    boardByTask: Map<string, ExecutionEvidence[]>;
    branchBySession: Map<string, BranchEvidence[]>;
    foreign: ReadonlySet<string>;
    unowned: UsagePolicy['unowned'];
}

const UNATTRIBUTED: Owner = {
    status: 'resolved',
    taskId: null,
    removed: false,
    authorId: null,
    authorConflict: false,
    repo: null,
    hook: false,
};

function resolveKey(ctx: Evidence, { agent, sessionId }: SessionKey): Owner {
    if (ctx.foreign.has(sessionId)) return { status: 'excluded', reason: 'foreign-org' };
    const rows = (ctx.boardBySession.get(sessionId) ?? []).filter((e) => matchesAgent(e.agent, agent));
    const branches = (ctx.branchBySession.get(sessionId) ?? []).filter((b) => b.agent === agent);
    if (rows.length === 0 && branches.length === 0) {
        return ctx.unowned === 'exclude' ? { status: 'excluded', reason: 'unowned' } : UNATTRIBUTED;
    }
    const tasks = distinct(rows.map(canonicalTask));
    if (tasks.length > 1) return { status: 'unresolved', reason: 'task-conflict' };
    const repos = distinct([...rows.map((e) => e.repo), ...branches.map((b) => b.repo)]);
    if (repos.length > 1) return { status: 'unresolved', reason: 'repo-conflict' };
    const taskId = tasks[0] ?? null;
    const authors = distinct(rows.map((e) => e.authorId));
    return {
        status: 'resolved',
        taskId,
        removed: taskId !== null && (ctx.boardByTask.get(taskId) ?? []).some((e) => e.removed),
        authorId: authors.length === 1 ? (authors[0] as string) : null,
        authorConflict: authors.length > 1,
        repo: repos[0] ?? null,
        hook: branches.length > 0,
    };
}

export function resolveOwnership(
    input: Pick<UsageInput, 'orgId' | 'board' | 'branch' | 'foreignSessionIds'>,
    keys: readonly SessionKey[],
    policy?: Partial<UsagePolicy>
): Map<string, Owner> {
    const board = input.board.filter((e) => e.orgId === input.orgId);
    const ctx: Evidence = {
        orgId: input.orgId,
        boardBySession: groupBy(board, (e) => e.sessionId),
        boardByTask: groupBy(board, canonicalTask),
        branchBySession: groupBy(
            input.branch.filter((b) => b.orgId === input.orgId),
            (b) => b.sessionId
        ),
        foreign: input.foreignSessionIds,
        unowned: resolvePolicy(policy).unowned,
    };
    const owners = new Map<string, Owner>();
    for (const key of keys) {
        const id = sessionKeyId(key.agent, key.sessionId);
        if (!owners.has(id)) owners.set(id, resolveKey(ctx, key));
    }
    return owners;
}
