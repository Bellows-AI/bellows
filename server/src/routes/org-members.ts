import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES, ROLES, type Role } from '@factory-ai/core';
import { callerOf } from '../auth/plugin.js';
import type { GitHubAccount, MembershipReader } from '../auth/membership.js';
import type { AuthStore } from '../auth/store.js';
import type { AuthConfig } from '../config.js';
import { UUID } from '../identifiers.js';
import { bad, body as jsonBody, guard } from './helpers.js';

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** No payload past a role word needs more than a control route's headroom. */
const CONTROL_BODY_LIMIT = 4096;

/** A body's role word is a `Role` only when the check constraint in 010_auth.sql would take it. */
const isRole = (value: unknown): value is Role => ROLES.some((candidate) => candidate === value);

/**
 * Organization membership (issue 410): the administrator's view of the roster and the one write
 * it takes — set a member's role. The org is the caller's; another org's member is not
 * addressable through this surface at all. A person's surface, like the org-executor routes it
 * mirrors — the board secret never gets past the auth wall here, because who holds `admin` is a
 * human decision, and an `oat_` names no person.
 *
 * Both routes are `admin` rows in `ROUTE_CLASSES`; the auth hook refuses a member before they run.
 *
 * - `GET /api/org/members` — the caller's org's roster, login-ordered.
 * - `PUT /api/org/members/:userId/role` — body `{ role }`. A demotion that would
 *   leave the org with no admin is refused (`409 LAST_ADMIN`) — an org with no admin is the
 *   bootstrap hole this closes, not a state to reach through the API.
 *
 * The admin's access controls beside them (docs/auth.md), every one an `admin` row too:
 *
 * - `DELETE /api/org/members/:userId` — removes a member: the block row, then the membership with its sessions and
 *   personal tokens. The block keeps the account out at every later sign-in; the last admin is refused (`409`).
 * - `GET /api/org/members/removed` — the org's removals; `DELETE /api/org/members/removed/:userId` lifts one.
 * - `GET /api/org/members/invitations` — membership is GitHub's, so an invitation is the org's sign-in link: the
 *   link, and GitHub's members of the org who have neither signed in nor been removed. GitHub's list is
 *   `unavailable` (with its reason) when it cannot be read; the link is served either way.
 */
export const orgMemberRoutes =
    ({
        store,
        roster,
        auth,
    }: {
        store: AuthStore;
        /** GitHub's member list; absent where the board has no GitHub App to ask with. */
        roster?: Pick<MembershipReader, 'roster'> | undefined;
        /** The sign-in a link points at: only GitHub sign-in has one. */
        auth: AuthConfig;
    }): FastifyPluginAsync =>
    async (app) => {
        const publicUrl = auth.mode === 'github' ? auth.publicUrl : undefined;
        app.get('/api/org/members', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleListMembers(store, request, reply)
        );
        app.put('/api/org/members/:userId/role', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleSetMemberRole(store, request, reply)
        );
        app.delete('/api/org/members/:userId', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleRemoveMember(store, request, reply)
        );
        app.get('/api/org/members/removed', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleListRemoved(store, request, reply)
        );
        app.delete('/api/org/members/removed/:userId', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleRestoreMember(store, request, reply)
        );
        app.get('/api/org/members/invitations', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleInvitations({ store, roster, publicUrl }, request, reply)
        );
    };

async function handleListMembers(store: AuthStore, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.listMembers(caller.org.id)
    );
    if (!loaded.ok) return reply;
    return reply.code(HTTP_OK).send({ members: loaded.value });
}

async function handleSetMemberRole(store: AuthStore, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const { userId } = request.params as { userId?: string };
    if (typeof userId !== 'string' || !UUID.test(userId)) {
        return bad(reply, ERROR_CODES.BAD_ID, 'userId must be a uuid');
    }

    const role = jsonBody(request.body).role;
    if (!isRole(role)) {
        return bad(reply, ERROR_CODES.BAD_ROLE, `role must be one of: ${ROLES.join(', ')}`);
    }

    const written = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.setMemberRole(caller.org.id, userId, role, caller.user.id)
    );
    if (!written.ok) return reply;
    if (written.value === 'missing') {
        return bad(reply, ERROR_CODES.NOT_FOUND, 'No such member of this organization', HTTP_NOT_FOUND);
    }
    // The one refusal with its own code: an org with no admin can only be fixed by SQL again,
    // which is the hole issue 410 closes — so the API never opens it.
    if (written.value === 'last-admin') {
        return bad(reply, ERROR_CODES.LAST_ADMIN, 'An organization must keep at least one admin', HTTP_CONFLICT);
    }
    return reply.code(HTTP_OK).send({ userId, role });
}

/** The caller and the `:userId` the URL names, or the refusal already sent. */
function callerAndTarget(request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) {
        bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
        return null;
    }
    const { userId } = request.params as { userId?: string };
    if (typeof userId !== 'string' || !UUID.test(userId)) {
        bad(reply, ERROR_CODES.BAD_ID, 'userId must be a uuid');
        return null;
    }
    return { caller, userId };
}

async function handleRemoveMember(store: AuthStore, request: FastifyRequest, reply: FastifyReply) {
    const named = callerAndTarget(request, reply);
    if (!named) return reply;
    const written = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.blockMember(named.caller.org.id, named.userId, named.caller.user.id)
    );
    if (!written.ok) return reply;
    if (written.value === 'missing') {
        return bad(reply, ERROR_CODES.NOT_FOUND, 'No such member of this organization', HTTP_NOT_FOUND);
    }
    if (written.value === 'last-admin') {
        return bad(reply, ERROR_CODES.LAST_ADMIN, 'An organization must keep at least one admin', HTTP_CONFLICT);
    }
    return reply.code(HTTP_OK).send({ userId: named.userId, removed: true });
}

async function handleListRemoved(store: AuthStore, request: FastifyRequest, reply: FastifyReply) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.listRemovedMembers(caller.org.id)
    );
    if (!loaded.ok) return reply;
    return reply.code(HTTP_OK).send({ removed: loaded.value });
}

async function handleRestoreMember(store: AuthStore, request: FastifyRequest, reply: FastifyReply) {
    const named = callerAndTarget(request, reply);
    if (!named) return reply;
    const written = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => store.restoreMember(named.caller.org.id, named.userId, named.caller.user.id)
    );
    if (!written.ok) return reply;
    if (written.value === 'missing') {
        return bad(reply, ERROR_CODES.NOT_FOUND, 'No removal of that account in this organization', HTTP_NOT_FOUND);
    }
    return reply.code(HTTP_OK).send({ userId: named.userId, restored: true });
}

type GitHubList = { state: 'listed'; people: GitHubAccount[] } | { state: 'unavailable'; reason: string };

/** GitHub's members of the org minus everyone accounted for, login-ordered; never a reason to refuse anyone. */
async function invitable(
    store: AuthStore,
    roster: Pick<MembershipReader, 'roster'> | undefined,
    orgId: string
): Promise<GitHubList> {
    if (!roster) return { state: 'unavailable', reason: 'this board has no GitHub App to list members with' };
    const basis = await store.invitationBasis(orgId);
    if (!basis) return { state: 'unavailable', reason: 'organization not recorded' };
    const { org, githubUserIds } = basis;
    const answer = await roster.roster({
        id: org.id,
        login: org.name,
        accountType: org.accountType ?? null,
        accountId: org.accountId ?? null,
    });
    if (answer.kind === 'unknown') return { state: 'unavailable', reason: answer.reason };
    const accounted = new Set(githubUserIds);
    const people = answer.members
        .filter((person) => !accounted.has(person.githubUserId))
        .sort((a, b) => a.login.localeCompare(b.login));
    return { state: 'listed', people };
}

async function handleInvitations(
    {
        store,
        roster,
        publicUrl,
    }: { store: AuthStore; roster: Pick<MembershipReader, 'roster'> | undefined; publicUrl: string | undefined },
    request: FastifyRequest,
    reply: FastifyReply
) {
    const caller = callerOf(request);
    if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
    const loaded = await guard(
        reply,
        (e) => request.log.error({ err: e }),
        () => invitable(store, roster, caller.org.id)
    );
    if (!loaded.ok) return reply;
    // The org rides the sign-in as a preference and `reselect` opens the selection screen (routes/auth.ts), so an
    // account that already tracks other organizations can tick this one. GitHub still decides who gets in.
    const query = new URLSearchParams({ org: caller.org.id, reselect: '1' });
    const signInUrl = publicUrl ? `${publicUrl}/api/auth/github?${query}` : null;
    return reply.code(HTTP_OK).send({ signInUrl, github: loaded.value });
}
