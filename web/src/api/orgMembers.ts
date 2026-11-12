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
