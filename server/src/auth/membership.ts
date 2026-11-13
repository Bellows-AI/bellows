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

export interface MembershipReader {
    read(target: MembershipTarget, signal?: AbortSignal): Promise<MembershipVerdict>;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

const unknown = (reason: string): MembershipVerdict => ({ kind: 'unknown', reason });

/** A request that answered, with its status and parsed body (null when the body is not JSON). */
interface Answer {
    status: number;
    body: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** `GET /orgs/:org/memberships/:user`'s 200 body: active → a member (an `admin` role is an owner), pending → not one. */
function verdictOf(body: unknown): MembershipVerdict {
    if (!isRecord(body) || typeof body.role !== 'string') return unknown('malformed membership body');
    // GitHub spells its owner role `admin`, as the board does.
    if (body.state === 'active') return { kind: 'active', owner: body.role === ADMIN_ROLE };
    if (body.state === 'pending') return { kind: 'not-member' };
    return unknown('unrecognized membership state');
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

    /** A 200 is read; a 404 is the caller's to confirm; anything else is unknown. */
    const classify = (answer: Answer): MembershipVerdict | 'absent' => {
        if (answer.status === HTTP_OK) return verdictOf(answer.body);
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
        const first = classify(await membership(org.login, user.login, token, signal));
        if (first !== 'absent') return first;

        // A 404 says "no such membership" only about the logins asked: confirm both still name who we mean.
        const orgAnswer = await get(`/orgs/${encodeURIComponent(org.login)}`, token, signal);
        if (confirmedLogin(orgAnswer, org.accountId!) === null) return unknown('organization login not confirmed');
        const current = confirmedLogin(await get(`/user/${user.githubUserId}`, token, signal), user.githubUserId);
        if (current === null) return unknown('user not confirmed');
        if (current.toLowerCase() === user.login.toLowerCase()) return { kind: 'not-member' };
        const renamed = classify(await membership(org.login, current, token, signal));
        return renamed === 'absent' ? { kind: 'not-member' } : renamed;
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
            const budget = AbortSignal.timeout(timeoutMs);
            const bounded = signal ? AbortSignal.any([signal, budget]) : budget;
            try {
                // Raced, so a token mint that ignores the signal cannot hold the request past the budget.
                return await Promise.race([
                    ask(target, bounded),
                    new Promise<MembershipVerdict>((resolve) => {
                        bounded.addEventListener('abort', () => resolve(unknown('membership read timed out')), {
                            once: true,
                        });
                    }),
                ]);
            } catch (e) {
                return unknown(`membership read failed: ${(e as Error).message}`);
            }
        },
    };
}
