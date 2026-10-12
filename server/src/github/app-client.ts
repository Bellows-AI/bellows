import {
    CONTENT_TYPE_HEADER,
    JSON_CONTENT_TYPE,
    MERGE_ERR_NOT_SENT,
    MERGE_ERR_UNCERTAIN,
    READ_TRANSPORT,
    type PrFacts,
} from '@factory-ai/core';
import type { GitHubConfig, Repo } from '../config.js';
import type { InstallationTokenProvider } from './app-token.js';
import { classifyMergeFailure, GitHubMergeError, readMergeResponse, type MergeResult } from './pr-merge.js';
import {
    classifyReadFailure,
    GitHubReadError,
    readBranchHead,
    readBranchState,
    readPullRequest,
    type BranchState,
} from './pr-read.js';

/**
 * What the App installation reports it can see. This replaced ORG_REPOS: the credential and the
 * repo list now come from the same place, so they cannot drift — a repo the operator listed but
 * never granted used to fail every sync with a 404 that read as a deleted repository.
 */
export interface InstallationRepo extends Repo {
    readonly private: boolean;
    readonly defaultBranch: string | null;
    /** ISO. Sorts the picker, so the repos somebody actually works in are at the top. */
    readonly pushedAt: string | null;
}

export interface Installation {
    readonly id: string;
    /** The org or user the App is installed on. Display only. */
    readonly account: string | null;
    /** `all` or `selected` — whether adding a repo needs a change on GitHub's side. */
    readonly repositorySelection: 'all' | 'selected' | null;
}

export interface InstallationListing {
    readonly repos: readonly InstallationRepo[];
    readonly installation: Installation;
}

export interface GitHubAppClient {
    /**
     * The repositories and the installation that owns them, in one call.
     *
     * Together rather than as two methods because they arrive in one response.
     * `GET /installation/repositories` carries `repository_selection` alongside the page, and there
     * is no second endpoint to ask: `GET /app/installations/:id` authenticates with the App JWT,
     * not with the installation token this client holds, so reaching for it here would 403.
     */
    listRepositories(): Promise<InstallationListing>;
    /**
     * One PR's state, head, target, required contexts and checks (docs/batches.md). Rejects with a
     * `GitHubReadError` whose `kind` says why nothing was read; never resolves for a PR the
     * installation cannot see or that belongs to another repository.
     */
    readPullRequest(repo: string, number: number): Promise<PrFacts>;
    /**
     * Asks GitHub to merge a PR, bound to the head the caller decided on: GitHub refuses when the head
     * moved, and enforces protection, required checks, reviews and merge queues itself. Rejects with a
     * `GitHubMergeError` whose `kind` says whether the merge may have happened (`uncertain`).
     */
    mergePullRequest(repo: string, number: number, request: { sha: string; method: string }): Promise<MergeResult>;
    /** A branch's tip, whether it holds each commit, and the tip's checks (the stage's combined verification). */
    readBranchState(repo: string, branch: string, shas: readonly string[]): Promise<BranchState>;
    /** A branch's tip commit, or null when it cannot be read. */
    readBranchHead(repo: string, branch: string): Promise<string | null>;
}

/**
 * A hard ceiling on paging. 100 pages of 100 is 10,000
 * repositories; past that something is looping rather than large.
 */
const MAX_PAGES = 100;

/** GitHub's page size for the repositories listing — the standard, and the largest, `per_page`. */
const PAGE_SIZE = 100;

const REQUEST_TIMEOUT_MS = 20_000;

/** Rulesets change rarely; reading them on every 60 s poll would spend the installation's rate limit. */
const RULES_TTL_MS = 300_000;

/** How much of a failed response's body is worth quoting back in the thrown error. */
const ERROR_DETAIL_LIMIT = 200;

interface RepoPayload {
    name?: string;
    private?: boolean;
    default_branch?: string | null;
    pushed_at?: string | null;
    owner?: { login?: string };
}

export function createGitHubAppClient(
    github: Extract<GitHubConfig, { mode: 'app' }>,
    tokens: InstallationTokenProvider,
    fetchFn: typeof fetch = fetch,
    now: () => number = Date.now
): GitHubAppClient {
    const call = async (path: string): Promise<unknown> => {
        const response = await fetchFn(`${github.apiUrl}${path}`, {
            headers: {
                authorization: `Bearer ${await tokens.get()}`,
                accept: 'application/vnd.github+json',
                // GitHub rejects an API request with no User-Agent outright.
                'user-agent': 'factory-ai',
            },
            // Well under the observation lease: a stalled request must fail as transport, not hold a pass.
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, ERROR_DETAIL_LIMIT);
            throw classifyReadFailure(path, { status: response.status, headers: response.headers, detail }, now());
        }
        return response.json();
    };

    // Only successful ruleset answers are kept; a failure is asked again next time.
    const rules = new Map<string, { at: number; body: unknown }>();
    const cachedCall = async (path: string): Promise<unknown> => {
        if (!path.includes('/rules/branches/')) return call(path);
        const hit = rules.get(path);
        if (hit && now() - hit.at < RULES_TTL_MS) return hit.body;
        const body = await call(path);
        rules.set(path, { at: now(), body });
        return body;
    };

    /**
     * Skipped rather than thrown: one malformed entry must not cost the whole list, and there is
     * nothing an operator could do about it from here anyway.
     */
    const toInstallationRepo = (repo: RepoPayload): InstallationRepo | null => {
        if (!repo.name || !repo.owner?.login) return null;
        return Object.freeze({
            owner: repo.owner.login,
            name: repo.name,
            private: repo.private ?? false,
            defaultBranch: repo.default_branch ?? null,
            pushedAt: repo.pushed_at ?? null,
        });
    };

    interface RepoPage {
        total_count?: number;
        repository_selection?: string;
        repositories?: RepoPayload[];
    }

    const fetchRepoPage = (page: number): Promise<RepoPage> =>
        call(`/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`) as Promise<RepoPage>;

    /**
     * Both conditions, not just the count: an empty page ends the walk even if total_count
     * disagrees, which is what stops a miscount becoming MAX_PAGES requests.
     */
    const isLastPage = (body: RepoPage, batchLength: number, repoCount: number): boolean =>
        batchLength === 0 || (typeof body.total_count === 'number' && repoCount >= body.total_count);

    const fetchInstallationRepos = async (): Promise<{
        repos: InstallationRepo[];
        selection: string | undefined;
    }> => {
        const repos: InstallationRepo[] = [];
        let selection: string | undefined;
        for (let page = 1; page <= MAX_PAGES; page += 1) {
            const body = await fetchRepoPage(page);
            selection ??= body.repository_selection;
            const batch = body.repositories ?? [];
            for (const repo of batch) {
                const parsed = toInstallationRepo(repo);
                if (parsed) repos.push(parsed);
            }
            if (isLastPage(body, batch.length, repos.length)) break;
        }
        return { repos, selection };
    };

    // A dropped connection or a token mint that failed is the provider being unreachable.
    const readError = (e: unknown): GitHubReadError =>
        e instanceof GitHubReadError ? e : new GitHubReadError((e as Error).message, READ_TRANSPORT);

    const merge = async (repo: string, number: number, request: { sha: string; method: string }) => {
        const path = `/repos/${repo}/pulls/${number}/merge`;
        // No token, no request: nothing can have been merged, unlike a request that was sent.
        const token = await tokens.get().catch((e: Error) => {
            throw new GitHubMergeError(e.message, MERGE_ERR_NOT_SENT);
        });
        let response: Response;
        try {
            response = await fetchFn(`${github.apiUrl}${path}`, {
                method: 'PUT',
                headers: {
                    authorization: `Bearer ${token}`,
                    accept: 'application/vnd.github+json',
                    [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE,
                    'user-agent': 'factory-ai',
                },
                body: JSON.stringify({ sha: request.sha, merge_method: request.method }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
        } catch (e) {
            // The request may have reached GitHub: the caller reconciles against the PR, never repeats blindly.
            throw new GitHubMergeError((e as Error).message, MERGE_ERR_UNCERTAIN);
        }
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, ERROR_DETAIL_LIMIT);
            throw classifyMergeFailure(path, { status: response.status, headers: response.headers, detail }, now());
        }
        return readMergeResponse((await response.json().catch(() => null)) as Parameters<typeof readMergeResponse>[0]);
    };

    return {
        mergePullRequest: merge,

        async readBranchState(repo, branch, shas) {
            try {
                return await readBranchState(call, repo, branch, shas);
            } catch (e) {
                throw readError(e);
            }
        },

        async readBranchHead(repo, branch) {
            try {
                return await readBranchHead(call, repo, branch);
            } catch (e) {
                throw readError(e);
            }
        },

        async readPullRequest(repo, number) {
            try {
                return await readPullRequest(cachedCall, repo, number);
            } catch (e) {
                throw readError(e);
            }
        },

        async listRepositories() {
            const { repos, selection } = await fetchInstallationRepos();

            // The account is inferred from the repositories rather than looked up, for the reason on
            // the interface: the endpoint that would report it authenticates differently. Null when
            // the installation spans several owners, which it can, because "the account this is
            // installed on" is then not a single answer and a first-repo guess would be a wrong one.
            const owners = new Set(repos.map((repo) => repo.owner));
            return Object.freeze({
                repos: Object.freeze(repos),
                installation: Object.freeze({
                    id: await tokens.installationId(),
                    account: owners.size === 1 ? ([...owners][0] as string) : null,
                    repositorySelection: selection === 'all' || selection === 'selected' ? selection : null,
                }),
            });
        },
    };
}
