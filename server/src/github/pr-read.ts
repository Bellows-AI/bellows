import {
    CHECKS_FAILING,
    CHECKS_PASSING,
    CHECKS_PENDING,
    CHECKS_UNKNOWN,
    READ_FORBIDDEN,
    READ_NOT_FOUND,
    READ_RATE_LIMITED,
    READ_TRANSPORT,
    sameRepo,
    type CheckItem,
    type PrFacts,
    type ReadErrorKind,
} from '@factory-ai/core';
import { GitHubAppError } from './app-token.js';

/**
 * The installation-authenticated read of a task's PR (docs/batches.md): state, target, head, the
 * required contexts and every check on the head, as `PrFacts`. Facts only — what they mean is
 * core's `assessPullRequest`. A failure is a `GitHubReadError` naming the kind, because an
 * unreachable or forbidden PR must never read as a passing one.
 */

export class GitHubReadError extends GitHubAppError {
    constructor(
        message: string,
        readonly kind: ReadErrorKind,
        readonly retryAfterMs: number | null = null
    ) {
        super(message);
    }
}

/** One GET against the API: parsed JSON, or a `GitHubReadError` for any non-2xx. */
export type ApiCall = (path: string) => Promise<unknown>;

const PAGE_SIZE = 100;
/** Past 500 check runs on one commit something is looping rather than large. */
const MAX_CHECK_PAGES = 5;
const REVIEW_PAGE_SIZE = 100;

const MS_PER_SECOND = 1000;

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_MANY_REQUESTS = 429;

/** The classification of a failed response, from its status, headers and body. */
export function classifyReadFailure(
    path: string,
    response: { status: number; headers: Headers; detail: string },
    nowMs: number
): GitHubReadError {
    const { status, headers, detail } = response;
    const message = `GET ${path} failed with ${status}${detail ? `: ${detail}` : ''}`;
    const limited =
        status === HTTP_TOO_MANY_REQUESTS ||
        (status === HTTP_FORBIDDEN && (headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(detail)));
    if (limited) return new GitHubReadError(message, READ_RATE_LIMITED, retryAfterMs(headers, nowMs));
    if (status === HTTP_NOT_FOUND) return new GitHubReadError(message, READ_NOT_FOUND);
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) return new GitHubReadError(message, READ_FORBIDDEN);
    return new GitHubReadError(message, READ_TRANSPORT);
}

/** `Retry-After` seconds, else the rate-limit reset instant; null when the provider named neither. */
function retryAfterMs(headers: Headers, nowMs: number): number | null {
    const seconds = Number(headers.get('retry-after'));
    if (headers.get('retry-after') !== null && Number.isFinite(seconds)) return Math.max(0, seconds) * MS_PER_SECOND;
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (headers.get('x-ratelimit-reset') !== null && Number.isFinite(reset)) {
        return Math.max(0, reset * MS_PER_SECOND - nowMs);
    }
    return null;
}

interface PullPayload {
    number?: number;
    html_url?: string;
    state?: string;
    merged?: boolean;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    mergeable?: boolean | null;
    head?: { sha?: string };
    base?: { ref?: string; repo?: { full_name?: string } };
}

interface BranchPayload {
    commit?: { sha?: string };
    protected?: boolean;
    protection?: {
        required_status_checks?: { contexts?: string[]; checks?: { context?: string }[] } | null;
    } | null;
}

type RulePayload = {
    type?: string;
    parameters?: {
        required_approving_review_count?: number;
        required_status_checks?: { context?: string }[];
    };
};

interface CheckRunPayload {
    id?: number;
    name?: string;
    status?: string;
    conclusion?: string | null;
    html_url?: string | null;
    output?: { title?: string | null; summary?: string | null } | null;
}

interface StatusPayload {
    context?: string;
    state?: string;
    target_url?: string | null;
    description?: string | null;
}

interface ReviewPayload {
    state?: string;
    user?: { id?: number } | null;
}

/** Conclusions that mean the code is wrong; the rest of the terminal ones say nothing about it. */
const FAILED_CONCLUSIONS: readonly string[] = ['failure', 'timed_out', 'startup_failure'];
const PASSED_CONCLUSIONS: readonly string[] = ['success', 'neutral', 'skipped'];

function checkRunItem(run: CheckRunPayload): CheckItem {
    const conclusion = run.conclusion ?? '';
    const state =
        run.status !== 'completed'
            ? CHECKS_PENDING
            : FAILED_CONCLUSIONS.includes(conclusion)
              ? CHECKS_FAILING
              : PASSED_CONCLUSIONS.includes(conclusion)
                ? CHECKS_PASSING
                : // cancelled, stale, action_required: nobody confirmed the work is wrong.
                  CHECKS_UNKNOWN;
    return {
        name: run.name ?? '',
        state,
        url: run.html_url ?? null,
        detail: run.output?.title ?? run.output?.summary ?? (conclusion || null),
    };
}

function statusItem(status: StatusPayload): CheckItem {
    const state =
        status.state === 'success'
            ? CHECKS_PASSING
            : status.state === 'pending'
              ? CHECKS_PENDING
              : status.state === 'failure' || status.state === 'error'
                ? CHECKS_FAILING
                : CHECKS_UNKNOWN;
    return { name: status.context ?? '', state, url: status.target_url ?? null, detail: status.description ?? null };
}

/** A re-run adds a run of the same name: the newest one is the one that counts. */
async function readCheckRuns(call: ApiCall, base: string, sha: string): Promise<CheckItem[]> {
    const newest = new Map<string, CheckRunPayload>();
    for (let page = 1; page <= MAX_CHECK_PAGES; page += 1) {
        const body = (await call(`${base}/commits/${sha}/check-runs?per_page=${PAGE_SIZE}&page=${page}`)) as {
            total_count?: number;
            check_runs?: CheckRunPayload[];
        };
        const runs = body.check_runs ?? [];
        for (const run of runs) {
            if (!run.name) continue;
            const seen = newest.get(run.name);
            if (!seen || (run.id ?? 0) > (seen.id ?? 0)) newest.set(run.name, run);
        }
        if (runs.length < PAGE_SIZE) break;
    }
    return [...newest.values()].map(checkRunItem);
}

async function readStatuses(call: ApiCall, base: string, sha: string): Promise<CheckItem[]> {
    const body = (await call(`${base}/commits/${sha}/status?per_page=${PAGE_SIZE}`)) as { statuses?: StatusPayload[] };
    return (body.statuses ?? []).filter((s) => s.context).map(statusItem);
}

/**
 * A read whose answer the PR can be assessed without: a branch or ruleset the installation may not
 * see is `null` (unknown, never "nothing required"), but a rate limit or a dropped connection is
 * the whole observation failing and must not be mistaken for a missing permission.
 */
async function optional(call: ApiCall, path: string): Promise<unknown> {
    try {
        return await call(path);
    } catch (e) {
        if (e instanceof GitHubReadError && (e.kind === READ_NOT_FOUND || e.kind === READ_FORBIDDEN)) return null;
        throw e;
    }
}

interface Requirements {
    targetSha: string | null;
    contexts: string[] | null;
    approvals: number | null;
}

/** Contexts a classic branch protection requires; null when the branch's protection could not be read. */
function protectionContexts(target: BranchPayload | null): string[] | null {
    if (target === null || (target.protection === undefined && target.protected !== false)) return null;
    const classic = target.protection?.required_status_checks;
    const names = [...(classic?.contexts ?? []), ...(classic?.checks ?? []).map((check) => check.context ?? '')];
    return names.filter((name) => name !== '');
}

/** What the active rulesets add: required contexts and the approvals a pull_request rule demands. */
function rulesetRequirements(rules: RulePayload[]): { contexts: string[]; approvals: number } {
    const contexts = rules.flatMap((rule) => rule.parameters?.required_status_checks ?? []).map((c) => c.context ?? '');
    const approvals = rules
        .filter((rule) => rule.type === 'pull_request')
        .map((rule) => rule.parameters?.required_approving_review_count ?? 0);
    return { contexts: contexts.filter((name) => name !== ''), approvals: Math.max(0, ...approvals) };
}

async function readRequirements(call: ApiCall, base: string, branch: string): Promise<Requirements> {
    const encoded = encodeURIComponent(branch);
    const target = (await optional(call, `${base}/branches/${encoded}`)) as BranchPayload | null;
    const rulesBody = await optional(call, `${base}/rules/branches/${encoded}`);
    const rules = Array.isArray(rulesBody) ? rulesBody : null;
    const classic = protectionContexts(target);
    const ruleset = rules === null ? null : rulesetRequirements(rules);
    return {
        targetSha: target?.commit?.sha ?? null,
        contexts:
            classic === null && ruleset === null
                ? null
                : [...new Set([...(classic ?? []), ...(ruleset?.contexts ?? [])])],
        approvals: ruleset?.approvals ?? null,
    };
}

async function readApprovals(call: ApiCall, base: string, number: number): Promise<number | null> {
    const body = await optional(call, `${base}/pulls/${number}/reviews?per_page=${REVIEW_PAGE_SIZE}`);
    const reviews = Array.isArray(body) ? (body as ReviewPayload[]) : null;
    if (reviews === null) return null;
    // The latest decisive review per reviewer counts; a comment does not retract an approval.
    const latest = new Map<number, string>();
    for (const review of reviews) {
        if (review.user?.id === undefined || !review.state) continue;
        if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED') {
            latest.set(review.user.id, review.state);
        }
    }
    return [...latest.values()].filter((state) => state === 'APPROVED').length;
}

/**
 * Reads one PR. The recorded `repo` is checked against the repository the PR actually belongs to
 * — a number alone identifies nothing — and the installation token's own reach decides access: a
 * repository it cannot see answers 404/403 and surfaces as `not_found`/`forbidden`.
 */
export async function readPullRequest(call: ApiCall, repo: string, number: number): Promise<PrFacts> {
    const base = `/repos/${repo}`;
    const pull = (await call(`${base}/pulls/${number}`)) as PullPayload;
    const baseRepo = pull.base?.repo?.full_name;
    const headSha = pull.head?.sha;
    const baseBranch = pull.base?.ref;
    if (!baseRepo || !headSha || !baseBranch) {
        throw new GitHubReadError(`GET ${base}/pulls/${number} returned an unreadable pull request`, READ_TRANSPORT);
    }
    if (!sameRepo(baseRepo, repo) || pull.number !== number) {
        throw new GitHubReadError(`pull request ${repo}#${number} belongs to ${baseRepo}`, READ_NOT_FOUND);
    }
    const merged = pull.merged === true;
    const requirements = await readRequirements(call, base, baseBranch);
    const [runs, statuses, approvals] = await Promise.all([
        readCheckRuns(call, base, headSha),
        readStatuses(call, base, headSha),
        (requirements.approvals ?? 0) > 0 && !merged ? readApprovals(call, base, number) : Promise.resolve(null),
    ]);
    return {
        repo: baseRepo,
        number,
        url: pull.html_url ?? `https://github.com/${repo}/pull/${number}`,
        state: pull.state === 'open' ? 'open' : 'closed',
        merged,
        mergedAt: pull.merged_at ?? null,
        mergeCommitSha: pull.merge_commit_sha ?? null,
        baseBranch,
        headSha,
        targetSha: requirements.targetSha,
        mergeable: pull.mergeable ?? null,
        requiredContexts: requirements.contexts,
        requiredApprovals: requirements.approvals,
        approvals,
        checks: [...runs, ...statuses],
    };
}

/** The target branch as it stands: its tip, whether it holds given commits, and the tip's own checks. */
export interface BranchState {
    headSha: string;
    /** Whether the tip contains each asked commit, by sha. */
    contains: Record<string, boolean>;
    requiredContexts: string[] | null;
    checks: CheckItem[];
}

/** The tip commit of a branch, or null when the branch cannot be read. */
export async function readBranchHead(call: ApiCall, repo: string, branch: string): Promise<string | null> {
    const body = (await optional(
        call,
        `/repos/${repo}/branches/${encodeURIComponent(branch)}`
    )) as BranchPayload | null;
    return body?.commit?.sha ?? null;
}

/** Whether `head` descends from `sha`: GitHub's compare says `ahead` or `identical`. An unknown commit is not contained. */
async function containsCommit(call: ApiCall, base: string, sha: string, head: string): Promise<boolean> {
    if (sha === head) return true;
    try {
        const body = (await call(`${base}/compare/${sha}...${head}`)) as { status?: string };
        return body.status === 'ahead' || body.status === 'identical';
    } catch (e) {
        if (e instanceof GitHubReadError && e.kind === READ_NOT_FOUND) return false;
        throw e;
    }
}

/**
 * What a stage's combined verification reads (docs/batches.md): the target's tip, whether each
 * merge commit is on it, and the checks on that tip against what the target requires. A tip that
 * cannot be read is a read error, never a pass.
 */
export async function readBranchState(
    call: ApiCall,
    repo: string,
    branch: string,
    shas: readonly string[]
): Promise<BranchState> {
    const base = `/repos/${repo}`;
    const requirements = await readRequirements(call, base, branch);
    const headSha = requirements.targetSha;
    if (headSha === null) throw new GitHubReadError(`branch ${branch} of ${repo} could not be read`, READ_NOT_FOUND);
    const [runs, statuses, held] = await Promise.all([
        readCheckRuns(call, base, headSha),
        readStatuses(call, base, headSha),
        Promise.all(shas.map(async (sha) => [sha, await containsCommit(call, base, sha, headSha)] as const)),
    ]);
    return {
        headSha,
        contains: Object.fromEntries(held),
        requiredContexts: requirements.contexts,
        checks: [...runs, ...statuses],
    };
}
