import {
    ERROR_CODES,
    GITLAB_FORGE,
    GITLAB_SETTINGS_PATH,
    type RepoRef,
    REPO_PATH_PATTERN,
    gitlabForgeOf,
} from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { callerOf, orgOf } from '../auth/plugin.js';
import type { AuthStore } from '../auth/store.js';
import type { ConnectionView, GitlabApplication } from '../db/forge-connections.js';
import { forgeConnectPath } from '../forge/forges.js';
import type { GitlabApi, GitlabProject } from '../gitlab/gitlab-api.js';
import { UUID } from '../identifiers.js';
import type { MemberForgeGrants } from '../integrations/member-forge-grant.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, body as jsonBody, guard } from './helpers.js';
import { forgeRefused } from './jobs/forge-usable.js';

/**
 * Tracking a GitLab project (docs/gitlab.md): the admin lists the projects under the connection's allowed root groups
 * with their OWN grant, and picks the ones the org tracks. The selection replaces only this host's `tracked_repo`
 * rows; an unconfirmed listing page leaves no partial list and saves nothing (503). A tracked project this admin's
 * listing does not show (another admin's, archived, gone) is listed with `listed: false` rather than hidden, and stays
 * tracked until the admin leaves it out of a save: a save never drops a row its admin was not shown.
 */

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const PATH = '/api/org/gitlab-connections/:id';
const LISTING_DEADLINE_MS = 60_000;
const TRACKED_LIMIT = 5000;
const CONTROL_BODY_LIMIT = 524_288;

export interface GitlabTrackingDeps {
    orgs: OrgRegistry;
    auth: AuthStore;
    memberGrants: MemberForgeGrants;
    api: GitlabApi;
    /** The board's public origin: a refusal's link. */
    publicUrl: string;
}

/** Sends the refusal and answers `null`: the caller's "already answered". */
const refuse = (send: () => unknown): null => {
    send();
    return null;
};

const log = (request: FastifyRequest) => (e: Error) => request.log.error({ err: e });
const unconfirmed = (reply: FastifyReply, what: string) =>
    bad(reply, ERROR_CODES.UNAVAILABLE, `${what} could not be read just now. Try again shortly.`, HTTP_UNAVAILABLE);

type Listing = { connection: ConnectionView; projects: GitlabProject[] };
type Live = { connection: ConnectionView; application: GitlabApplication };

/** A project's root group is its path's first segment; GitLab paths are case-insensitive. */
const rootOf = (path: string): string => path.slice(0, path.indexOf('/')).toLowerCase();

/** The active connection the request names with its application, or null once the refusal (404, 409, 503) is sent. */
async function liveConnection(
    deps: GitlabTrackingDeps,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<Live | null> {
    const { id } = request.params as { id?: string };
    const store = (await deps.orgs.for(orgOf(request)))?.forgeConnections;
    if (!store) return refuse(() => unconfirmed(reply, 'The GitLab connection'));
    const read = await guard(reply, log(request), async () => {
        const connection = id !== undefined && UUID.test(id) ? await store.get(id) : null;
        return { connection, application: connection ? await store.application(connection.host) : null };
    });
    if (!read.ok) return null;
    const { connection, application } = read.value;
    if (!connection || !application) {
        return refuse(() => bad(reply, ERROR_CODES.NOT_FOUND, 'No such GitLab connection', HTTP_NOT_FOUND));
    }
    if (connection.active) return { connection, application };
    return refuse(() =>
        bad(reply, ERROR_CODES.GITLAB_CONNECTION_PENDING, 'This GitLab connection is not active yet', HTTP_CONFLICT)
    );
}

/** The calling admin's own access token for the host, or null once the refusal (409 FORGE_GRANT_REQUIRED, 503) is sent. */
async function adminToken(
    deps: GitlabTrackingDeps,
    request: FastifyRequest,
    reply: FastifyReply,
    { host, signal }: { host: string; signal: AbortSignal }
): Promise<string | null> {
    const orgId = orgOf(request);
    const forge = gitlabForgeOf(host);
    const userId = callerOf(request)?.user.id;
    const token =
        userId === undefined ? undefined : await deps.memberGrants.accessToken(orgId, userId, forge, { signal });
    if (token?.ok) return token.accessToken;
    if (token?.outcome.outcome !== 'integration_required')
        return refuse(() => unconfirmed(reply, 'Your GitLab connection'));
    const path = forgeConnectPath(forge, { orgId, returnTo: GITLAB_SETTINGS_PATH }) as string;
    const standing = token.outcome.reason === 'missing' ? 'missing' : 'broken';
    return refuse(() => forgeRefused(reply, { ok: false, forge, standing, connectUrl: `${deps.publicUrl}${path}` }));
}

/**
 * The projects the calling admin sees under the connection's allowed groups, or null once the refusal is sent: no such
 * connection (404), a pending one (409), no live grant of the admin's own (409), anything the board could not confirm
 * (503). Only the allowed roots' projects count; a nested group shows under its root.
 */
async function listingFor(
    deps: GitlabTrackingDeps,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<Listing | null> {
    const live = await liveConnection(deps, request, reply);
    if (!live) return null;
    const { connection, application } = live;
    const signal = AbortSignal.timeout(LISTING_DEADLINE_MS);
    const token = await adminToken(deps, request, reply, { host: connection.host, signal });
    if (token === null) return null;
    const roots = new Set(connection.allowedGroups.map((group) => group.toLowerCase()));
    const found = new Map<string, GitlabProject>();
    for (const group of connection.allowedGroups) {
        const target = { host: connection.host, token, caBundle: application.caBundle, signal, group };
        const listed = await deps.api.listGroupProjects(target);
        if (!listed.ok) return refuse(() => unconfirmed(reply, 'The GitLab project list'));
        for (const project of listed.projects) if (roots.has(rootOf(project.path))) found.set(project.path, project);
    }
    return { connection, projects: [...found.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

const scopeOf = (host: string) => ({ forge: GITLAB_FORGE, host }) as const;

const pathsOf = (raw: unknown): string[] | null => {
    const { paths } = jsonBody(raw);
    return Array.isArray(paths) &&
        paths.length <= TRACKED_LIMIT &&
        paths.every((path) => typeof path === 'string' && REPO_PATH_PATTERN.test(path))
        ? [...new Set(paths as string[])]
        : null;
};

export const gitlabTrackingRoutes =
    (deps: GitlabTrackingDeps): FastifyPluginAsync =>
    async (app) => {
        app.get(`${PATH}/projects`, async (request, reply) => {
            const listing = await listingFor(deps, request, reply);
            if (!listing) return reply;
            const tracked = await guard(reply, log(request), () =>
                deps.auth.trackedRepos(orgOf(request), scopeOf(listing.connection.host))
            );
            if (!tracked.ok) return reply;
            const picked = new Set(tracked.value.map((ref) => ref.path));
            const shown = new Set(listing.projects.map((project) => project.path));
            const entries = [
                ...listing.projects.map(({ path, defaultBranch }) => ({
                    path,
                    defaultBranch,
                    tracked: picked.has(path),
                    listed: true,
                })),
                ...[...picked]
                    .filter((path) => !shown.has(path))
                    .map((path) => ({ path, defaultBranch: null, tracked: true, listed: false })),
            ].sort((a, b) => a.path.localeCompare(b.path));
            return reply.code(HTTP_OK).header('cache-control', 'no-store').send({ projects: entries });
        });

        app.put(`${PATH}/tracked-repos`, { bodyLimit: CONTROL_BODY_LIMIT }, async (request, reply) => {
            const paths = pathsOf(request.body);
            if (!paths) return bad(reply, ERROR_CODES.BAD_BODY, 'paths must list project paths, group/name');
            const listing = await listingFor(deps, request, reply);
            if (!listing) return reply;
            const { host } = listing.connection;
            const orgId = orgOf(request);
            const current = await guard(reply, log(request), () => deps.auth.trackedRepos(orgId, scopeOf(host)));
            if (!current.ok) return reply;
            const allowed = new Set([
                ...listing.projects.map((project) => project.path),
                ...current.value.map((ref) => ref.path),
            ]);
            const unknown = paths.find((path) => !allowed.has(path));
            if (unknown !== undefined) {
                return bad(
                    reply,
                    ERROR_CODES.UNKNOWN_REPO,
                    `"${unknown}" is not a project you can see under this connection's allowed groups`
                );
            }
            const refs: RepoRef[] = paths.map((path) => ({ forge: GITLAB_FORGE, host, path }));
            const saved = await guard(reply, log(request), async () => {
                await deps.auth.replaceTrackedRepos(orgId, scopeOf(host), refs);
                (await deps.orgs.for(orgId))?.repos.invalidate();
            });
            if (!saved.ok) return reply;
            return reply.code(HTTP_OK).send({ tracked: paths });
        });
    };
