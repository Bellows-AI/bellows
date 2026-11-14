import { ADMIN_ROLE } from '@factory-ai/core';

/**
 * What GitHub says about one account's membership of one installation's organization, read with that
 * installation's token (the App's `members:read` permission). docs/auth.md.
 *
 * Only a CONFIRMED answer is a verdict. A 404 is "not a member" only after the org login is confirmed to still
 * name the installation's organization and the user's login to still name the account (re-asked once under a
 * renamed login); a 403 (the permission not granted yet), any other status, a malformed body, a transport
 * failure, a missing token or the time budget running out is `unknown`, and `unknown` licenses nothing.
 */

/** The organization (an installation) and the account being asked about. */
export interface MembershipTarget {
    org: {
        /** The installation id, which is the organization id; the token is minted for it. */
        id: string;
        /** The account login the installation is on, as last reported. */
        login: string;
        /** GitHub's `account.type` for the installation: `Organization` or `User`; null when not recorded. */
        accountType: string | null;
        accountId: number | null;
    };
    user: { githubUserId: number; login: string };
}

export type MembershipVerdict =
    | { kind: 'active'; owner: boolean }
    | { kind: 'not-member' }
    | { kind: 'unknown'; reason: string };

/** One GitHub account, by its numeric id (the identity) and current login (a label). */
export interface GitHubAccount {
    githubUserId: number;
    login: string;
}

/** GitHub's member list of an installation's organization: listed only on a 200 for every page asked. */
export type RosterAnswer = { kind: 'listed'; members: GitHubAccount[] } | { kind: 'unknown'; reason: string };

export interface MembershipReader {
    read(target: MembershipTarget, signal?: AbortSignal): Promise<MembershipVerdict>;
    /**
     * The organization's active members (`GET /orgs/:org/members`), up to `ROSTER_PAGE_CAP` pages: what an admin may
     * invite. Bounded by the same budget as `read`; it decides nothing about anyone's access.
     */
    roster(org: MembershipTarget['org'], signal?: AbortSignal): Promise<RosterAnswer>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const ROSTER_PAGE_SIZE = 100;
/** 1,000 members: past that the list is cut, never refused — it only offers invitations. */
const ROSTER_PAGE_CAP = 10;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

/** An unanswered read, for either answer kind: it licenses nothing. */
const unknown = (reason: string): { kind: 'unknown'; reason: string } => ({ kind: 'unknown', reason });

/** A request that answered, with its status and parsed body (null when the body is not JSON). */
interface Answer {
    status: number;
    body: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** The numeric id a 200 body's `organization` or `user` object carries, or undefined. */
const idOf = (value: unknown): unknown => (isRecord(value) ? value.id : undefined);

/**
 * `GET /orgs/:org/memberships/:user`'s 200 body: active → a member (an `admin` role is an owner), pending → not one.
 * Only about the account and organization asked: a body whose numeric `user.id` or `organization.id` is not theirs
 * (a login now held by somebody else) is a `mismatch`, never applied.
 */
function verdictOf(body: unknown, target: MembershipTarget): MembershipVerdict | 'mismatch' {
    if (!isRecord(body) || typeof body.role !== 'string') return unknown('malformed membership body');
    if (idOf(body.user) !== target.user.githubUserId || idOf(body.organization) !== target.org.accountId) {
        return 'mismatch';
    }
    // GitHub spells its owner role `admin`, as the board does.
    if (body.state === 'active') return { kind: 'active', owner: body.role === ADMIN_ROLE };
    if (body.state === 'pending') return { kind: 'not-member' };
    return unknown('unrecognized membership state');
}

/** One page of `GET /orgs/:org/members`: an array of `{ id, login }`, or null when any row is not one. */
function accountsOf(body: unknown): GitHubAccount[] | null {
    if (!Array.isArray(body)) return null;
    const accounts: GitHubAccount[] = [];
    for (const row of body) {
        if (!isRecord(row) || typeof row.id !== 'number' || typeof row.login !== 'string') return null;
        accounts.push({ githubUserId: row.id, login: row.login });
    }
    return accounts;
}

export function createMembershipReader({
    apiUrl,
    tokenFor,
    fetchFn = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
    apiUrl: string;
    /** An installation token for the installation id; a rejection reads as `unknown`. */
    tokenFor: (installationId: string) => Promise<string>;
    fetchFn?: typeof fetch;
    /** The whole read's budget, token mint included: on the request path this bounds the wall clock. */
    timeoutMs?: number;
}): MembershipReader {
    const get = async (path: string, token: string, signal: AbortSignal): Promise<Answer> => {
        const response = await fetchFn(`${apiUrl}${path}`, {
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/vnd.github+json',
                'user-agent': 'factory-ai',
            },
            signal,
        });
        const text = await response.text();
        let body: unknown = null;
        try {
            body = JSON.parse(text);
        } catch {
            body = null;
        }
        return { status: response.status, body };
    };

    const membership = (org: string, user: string, token: string, signal: AbortSignal) =>
        get(`/orgs/${encodeURIComponent(org)}/memberships/${encodeURIComponent(user)}`, token, signal);

    /** A 200 about the right ids is read; a 404 or an answer about somebody else is the caller's to resolve. */
    const classify = (answer: Answer, target: MembershipTarget): MembershipVerdict | 'absent' | 'mismatch' => {
        if (answer.status === HTTP_OK) return verdictOf(answer.body, target);
        if (answer.status === HTTP_NOT_FOUND) return 'absent';
        return unknown(`membership read answered ${answer.status}`);
    };

    /** The login GitHub reports for an id-bearing read that must match `id`, or null when it does not confirm. */
    const confirmedLogin = (answer: Answer, id: number): string | null =>
        answer.status === HTTP_OK &&
        isRecord(answer.body) &&
        answer.body.id === id &&
        typeof answer.body.login === 'string'
            ? answer.body.login
            : null;

    const ask = async (target: MembershipTarget, signal: AbortSignal): Promise<MembershipVerdict> => {
        const { org, user } = target;
        const token = await tokenFor(org.id);
        signal.throwIfAborted();
        const first = classify(await membership(org.login, user.login, token, signal), target);
        if (first !== 'absent' && first !== 'mismatch') return first;

        // A 404 or an answer about somebody else says nothing about the logins' current holders: confirm the org
        // login still names the installation's organization, and resolve the account's current login by its id.
        const orgAnswer = await get(`/orgs/${encodeURIComponent(org.login)}`, token, signal);
        if (confirmedLogin(orgAnswer, org.accountId!) === null) return unknown('organization login not confirmed');
        const current = confirmedLogin(await get(`/user/${user.githubUserId}`, token, signal), user.githubUserId);
        if (current === null) return unknown('user not confirmed');
        const outcome =
            current.toLowerCase() === user.login.toLowerCase()
                ? first
                : classify(await membership(org.login, current, token, signal), target);
        if (outcome === 'absent') return { kind: 'not-member' };
        return outcome === 'mismatch' ? unknown('membership answer names another identity') : outcome;
    };

    /** Every page of the org's members, until a short page or the cap; any other answer is `unknown`. */
    const list = async (org: MembershipTarget['org'], signal: AbortSignal): Promise<RosterAnswer> => {
        const token = await tokenFor(org.id);
        signal.throwIfAborted();
        const members: GitHubAccount[] = [];
        for (let page = 1; page <= ROSTER_PAGE_CAP; page += 1) {
            const path = `/orgs/${encodeURIComponent(org.login)}/members?per_page=${ROSTER_PAGE_SIZE}&page=${page}`;
            const answer = await get(path, token, signal);
            if (answer.status !== HTTP_OK) return unknown(`member list answered ${answer.status}`);
            const accounts = accountsOf(answer.body);
            if (!accounts) return unknown('malformed member list');
            members.push(...accounts);
            if (accounts.length < ROSTER_PAGE_SIZE) break;
        }
        return { kind: 'listed', members };
    };

    /**
     * Runs `fn` under the budget (and the caller's signal). Raced, so a token mint that ignores the signal cannot
     * hold the request past the budget; a timeout or a throw is `unknown`, never an answer.
     */
    const withinBudget = async <T>(what: string, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
        const budget = AbortSignal.timeout(timeoutMs);
        const bounded = signal ? AbortSignal.any([signal, budget]) : budget;
        try {
            return await Promise.race([
                fn(bounded),
                new Promise<{ kind: 'unknown'; reason: string }>((resolve) => {
                    bounded.addEventListener('abort', () => resolve(unknown(`${what} timed out`)), { once: true });
                }),
            ]);
        } catch (e) {
            return unknown(`${what} failed: ${(e as Error).message}`);
        }
    };

    return {
        async read(target, signal) {
            const { org, user } = target;
            // A user account's installation has one owner, the account itself; nobody else is asked about.
            if (org.accountType === 'User' && org.accountId !== null) {
                return org.accountId === user.githubUserId
                    ? { kind: 'active', owner: true }
                    : unknown('not the installation account');
            }
            if (org.accountType !== 'Organization' || org.accountId === null) {
                return unknown('installation account not recorded');
            }
            return withinBudget('membership read', (bounded) => ask(target, bounded), signal);
        },

        async roster(org, signal) {
            // A user account's installation has one member: the account, whose login the installation carries.
            if (org.accountType === 'User' && org.accountId !== null) {
                return { kind: 'listed', members: [{ githubUserId: org.accountId, login: org.login }] };
            }
            if (org.accountType !== 'Organization' || org.accountId === null) {
                return unknown('installation account not recorded');
            }
            return withinBudget('member list read', (bounded) => list(org, bounded), signal);
        },
    };
}
