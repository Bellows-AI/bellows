import type { Role } from '@factory-ai/core';
import { request } from './request.js';

/**
 * The member roster's client half (issue 410): the administrator's read of the org's memberships
 * and the one write it takes. The GET is admin-gated server-side, so a member's browser never
 * issues it — the section decides that before calling either.
 */

/** One row of an organization's roster, as `GET /api/org/members` serves it. */
export interface MemberView {
    githubLogin: string;
    /** The account's id — the role write addresses a member by it. */
    userId: string;
    role: Role;
    invitedAt: string | null;
    claimedAt: string | null;
    lastLoginAt: string | null;
}

/**
 * What a roster row must look like for the table to be safe: the cells render these fields
 * directly, so a 2xx body that is not that shape is refused as an error result, never handed on
 * to throw in the render. The dates are checked for type too, though `commitDate` would degrade
 * a bad value to an em dash — the guard is about refusing the body, not surviving it.
 */
const isDate = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isMemberView = (row: unknown): row is MemberView =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as MemberView).githubLogin === 'string' &&
    typeof (row as MemberView).userId === 'string' &&
    typeof (row as MemberView).role === 'string' &&
    isDate((row as MemberView).invitedAt) &&
    isDate((row as MemberView).claimedAt) &&
    isDate((row as MemberView).lastLoginAt);

/** The admin's roster read — fetched once per mount and again after each successful write. */
export const listMembers = async (): Promise<{ ok: true; members: MemberView[] } | { ok: false; error: string }> => {
    const result = await request<{ members: MemberView[] }>('/api/org/members', {
        verb: 'Could not load the members',
        guard: (body): body is { members: MemberView[] } => {
            const rows = (body as { members?: unknown } | null)?.members;
            return Array.isArray(rows) && rows.every(isMemberView);
        },
        malformed: 'Could not load the members: unexpected response shape.',
    });
    return result.ok ? { ok: true, members: result.value.members } : { ok: false, error: result.error };
};

/** The role write. Returns the refusal's message, or null when the role stuck. */
export const setMemberRole = async (userId: string, role: Role): Promise<string | null> => {
    const result = await request(`/api/org/members/${userId}/role`, {
        method: 'PUT',
        body: { role },
        verb: 'Could not set the role',
        empty: true,
    });
    return result.ok ? null : result.error;
};

/** One admin removal, as `GET /api/org/members/removed` serves it; `removedBy` is null once that account is gone. */
export interface RemovedMember {
    userId: string;
    githubLogin: string;
    removedAt: string;
    removedBy: string | null;
}

/** One GitHub account the org's member list names. */
export interface GitHubPerson {
    githubUserId: number;
    login: string;
}

/**
 * `GET /api/org/members/invitations`: the org's sign-in link (null where there is no GitHub sign-in), and GitHub's
 * members who have neither signed in nor been removed — or why that list could not be read.
 */
export interface Invitations {
    signInUrl: string | null;
    github: { state: 'listed'; people: GitHubPerson[] } | { state: 'unavailable'; reason: string };
}

const isRemovedMember = (row: unknown): row is RemovedMember =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as RemovedMember).userId === 'string' &&
    typeof (row as RemovedMember).githubLogin === 'string' &&
    typeof (row as RemovedMember).removedAt === 'string' &&
    isDate((row as RemovedMember).removedBy);

const isPerson = (row: unknown): row is GitHubPerson =>
    typeof row === 'object' &&
    row !== null &&
    typeof (row as GitHubPerson).githubUserId === 'number' &&
    typeof (row as GitHubPerson).login === 'string';

const isInvitations = (body: unknown): body is Invitations => {
    if (typeof body !== 'object' || body === null) return false;
    const { signInUrl, github } = body as {
        signInUrl?: unknown;
        github?: { state?: unknown } & Record<string, unknown>;
    };
    if (!(signInUrl === null || typeof signInUrl === 'string') || typeof github !== 'object' || github === null) {
        return false;
    }
    if (github.state === 'listed') return Array.isArray(github.people) && github.people.every(isPerson);
    return github.state === 'unavailable' && typeof github.reason === 'string';
};

/** The org's removals, read beside the roster. */
export const listRemovedMembers = async (): Promise<
    { ok: true; removed: RemovedMember[] } | { ok: false; error: string }
> => {
    const result = await request<{ removed: RemovedMember[] }>('/api/org/members/removed', {
        verb: 'Could not load the removed members',
        guard: (body): body is { removed: RemovedMember[] } => {
            const rows = (body as { removed?: unknown } | null)?.removed;
            return Array.isArray(rows) && rows.every(isRemovedMember);
        },
        malformed: 'Could not load the removed members: unexpected response shape.',
    });
    return result.ok ? { ok: true, removed: result.value.removed } : { ok: false, error: result.error };
};

/** The invitation read: the sign-in link and who on GitHub has not used it yet. */
export const readInvitations = async (): Promise<{ ok: true; value: Invitations } | { ok: false; error: string }> =>
    request<Invitations>('/api/org/members/invitations', {
        verb: 'Could not load the invitations',
        guard: isInvitations,
        malformed: 'Could not load the invitations: unexpected response shape.',
    });

/** The removal. Returns the refusal's message, or null when the member is out. */
export const removeMember = async (userId: string): Promise<string | null> => {
    const result = await request(`/api/org/members/${userId}`, {
        method: 'DELETE',
        verb: 'Could not remove the member',
        empty: true,
    });
    return result.ok ? null : result.error;
};

/** Lifts a removal. Returns the refusal's message, or null when the account may sign in again. */
export const restoreMember = async (userId: string): Promise<string | null> => {
    const result = await request(`/api/org/members/removed/${userId}`, {
        method: 'DELETE',
        verb: 'Could not restore the member',
        empty: true,
    });
    return result.ok ? null : result.error;
};
