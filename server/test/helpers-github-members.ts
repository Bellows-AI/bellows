/**
 * A fake GitHub REST boundary for the membership re-check: `GET /orgs/:org/memberships/:user`, and the two
 * identity reads that confirm a 404 (`GET /orgs/:org`, `GET /user/:id`), and the org's member list
 * (`GET /orgs/:org/members`, the people answered `admin` or `member`). Everything else is a 404.
 */

export const FAKE_GITHUB_API = 'https://api.github.test';

/** The id a membership answer carries for a login no known user or org holds: somebody else. */
export const STRANGER_ID = 999_999_999;

/** What the memberships endpoint answers for one person: a role, a pending invite, absent, or a raw fault. */
export type MembershipAnswer =
    | 'admin'
    | 'member'
    | 'pending'
    | 'absent'
    | { status: number; body: string }
    | 'throw'
    | 'hang';

export interface FakeGitHubMembers {
    fetchFn: typeof fetch;
    /** Every path asked, in order. */
    calls: string[];
    /** Sets what GitHub says about `user` in `org` (by login). Unset is `absent`. */
    answer(org: string, user: string, value: MembershipAnswer): void;
    /** The organizations GitHub knows, by current login, with their numeric ids. */
    orgs: Map<string, number>;
    /** The users GitHub knows, by numeric id, with their current login. */
    users: Map<number, string>;
    /** A fault `GET /orgs/:org/members` answers instead of its list; null lists the active members. */
    rosterFault: { status: number; body: string } | 'throw' | 'hang' | null;
}

const PAGE_DEFAULT = 30;

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const hang = (signal: AbortSignal | null | undefined): Promise<Response> =>
    new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });

export function fakeGitHubMembers(): FakeGitHubMembers {
    const answers = new Map<string, MembershipAnswer>();
    const calls: string[] = [];
    const orgs = new Map<string, number>();
    const users = new Map<number, string>();

    const membership = (org: string, user: string, signal: AbortSignal | null | undefined): Promise<Response> => {
        const value = answers.get(`${org}/${user}`) ?? 'absent';
        if (value === 'throw') return Promise.reject(new TypeError('fetch failed'));
        if (value === 'hang') return hang(signal);
        if (value === 'absent') return Promise.resolve(json(404, { message: 'Not Found' }));
        if (typeof value === 'object') return Promise.resolve(new Response(value.body, { status: value.status }));
        const state = value === 'pending' ? 'pending' : 'active';
        const role = value === 'pending' ? 'member' : value;
        // The ids GitHub sends: whoever holds the login NOW. A login no known user holds belongs to a stranger.
        const userId = [...users].find(([, login]) => login === user)?.[0] ?? STRANGER_ID;
        const orgId = orgs.get(org) ?? STRANGER_ID;
        return Promise.resolve(
            json(200, { state, role, organization: { id: orgId, login: org }, user: { id: userId, login: user } })
        );
    };

    /** The org's active members by numeric id, paged as GitHub pages them (`per_page`, `page` from 1). */
    const roster = (org: string, url: URL, signal: AbortSignal | null | undefined): Promise<Response> => {
        const fault = fake.rosterFault;
        if (fault === 'throw') return Promise.reject(new TypeError('fetch failed'));
        if (fault === 'hang') return hang(signal);
        if (fault) return Promise.resolve(new Response(fault.body, { status: fault.status }));
        const active = [...users]
            .filter(([, login]) => ['admin', 'member'].includes(String(answers.get(`${org}/${login}`))))
            .sort(([a], [b]) => a - b)
            .map(([id, login]) => ({ id, login }));
        const perPage = Number(url.searchParams.get('per_page') ?? PAGE_DEFAULT);
        const page = Number(url.searchParams.get('page') ?? 1);
        return Promise.resolve(json(200, active.slice((page - 1) * perPage, page * perPage)));
    };

    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const path = url.pathname;
        calls.push(path);
        const parts = path.split('/').filter(Boolean);
        if (parts[0] === 'orgs' && parts[2] === 'members' && parts.length === 3) {
            return roster(decodeURIComponent(parts[1]!), url, init?.signal);
        }
        if (parts[0] === 'orgs' && parts[2] === 'memberships' && parts.length === 4) {
            return membership(decodeURIComponent(parts[1]!), decodeURIComponent(parts[3]!), init?.signal);
        }
        if (parts[0] === 'orgs' && parts.length === 2) {
            const id = orgs.get(decodeURIComponent(parts[1]!));
            return id === undefined ? json(404, { message: 'Not Found' }) : json(200, { id, login: parts[1] });
        }
        if (parts[0] === 'user' && parts.length === 2) {
            const login = users.get(Number(parts[1]));
            return login === undefined
                ? json(404, { message: 'Not Found' })
                : json(200, { id: Number(parts[1]), login });
        }
        return json(404, { message: 'Not Found' });
    }) as typeof fetch;

    const fake: FakeGitHubMembers = {
        fetchFn,
        calls,
        answer: (org, user, value) => answers.set(`${org}/${user}`, value),
        orgs,
        users,
        rosterFault: null,
    };
    return fake;
}
