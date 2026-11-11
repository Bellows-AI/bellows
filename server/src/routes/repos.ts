import { ERROR_CODES, isBranchName, READ_NOT_FOUND } from '@factory-ai/core';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { orgOf } from '../auth/plugin.js';
import type { AppConfig } from '../config.js';
import { BranchCursorError } from '../github/app-client.js';
import { GitHubReadError } from '../github/pr-read.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, checkReposVisible } from './helpers.js';

const HTTP_OK = 200;
const HTTP_UNAVAILABLE = 503;
const BRANCH_QUERY_LIMIT = 255;
const CURSOR_LIMIT = 512;

export interface RepoRouteDeps {
    /** The per-org runtimes; the repo list a request touches is the caller's org's. */
    orgs: OrgRegistry;
    config: AppConfig;
}

const branchesUnavailable = (reply: FastifyReply, message: string) =>
    bad(reply, ERROR_CODES.BRANCHES_UNAVAILABLE, message, HTTP_UNAVAILABLE);

/** A prefix of a branch name (the full rule's alphabet, a partial trailing segment allowed) and an opaque cursor. */
function branchRequestRefusal(query: string | undefined, cursor: string | undefined) {
    if (query !== undefined && (query.length > BRANCH_QUERY_LIMIT || !isBranchName(query))) {
        return { code: ERROR_CODES.BAD_BRANCH_QUERY, message: 'q must be the start of a git branch name' };
    }
    if (cursor !== undefined && cursor.length > CURSOR_LIMIT) {
        return { code: ERROR_CODES.BAD_BRANCH_CURSOR, message: 'cursor is not one this board issued' };
    }
    return null;
}

/** A failed branch read: a bad cursor and a repo GitHub does not know are the caller's; the rest is unconfirmed. */
function branchReadRefusal(
    request: FastifyRequest,
    reply: FastifyReply,
    repo: { owner: string; name: string },
    e: unknown
) {
    if (e instanceof BranchCursorError) {
        return bad(reply, ERROR_CODES.BAD_BRANCH_CURSOR, 'cursor is not one this board issued for this query');
    }
    if (e instanceof GitHubReadError && e.kind === READ_NOT_FOUND) {
        return bad(
            reply,
            ERROR_CODES.UNKNOWN_REPO,
            `"${repo.owner}/${repo.name}" is not a repository this board tracks`
        );
    }
    request.log.error({ err: e }, 'branch list read failed');
    return branchesUnavailable(reply, 'Branches could not be read. Try again shortly.');
}

/** Branch names for the composer's base-branch picker. */
function registerBranchRoute(app: FastifyInstance, orgs: OrgRegistry) {
    // Branch names for the composer's base-branch picker. One GitHub request per call; the cursor
    // carries the next position. A read that did not confirm is a 503, never an empty list.
    app.get<{ Params: { owner: string; name: string }; Querystring: { q?: string; cursor?: string } }>(
        '/api/repos/:owner/:name/branches',
        async (request, reply) => {
            const { owner, name } = request.params;
            const { q, cursor } = request.query;
            const query = q === '' ? undefined : q;
            const refused = branchRequestRefusal(query, cursor);
            if (refused) return bad(reply, refused.code, refused.message);
            const rt = await orgs.for(orgOf(request));
            if (!rt?.listBranches) return branchesUnavailable(reply, 'Branches cannot be read on this board');
            const visible = await checkReposVisible(rt.repos, [{ owner, name }], { subject: 'the repository' });
            if (!visible.ok) return bad(reply, visible.code, visible.message, visible.status);
            try {
                const page = await rt.listBranches(`${owner}/${name}`, {
                    ...(query === undefined ? {} : { query }),
                    ...(cursor === undefined ? {} : { cursor }),
                });
                const defaultBranch =
                    (await rt.repos.detail()).repos.find((r) => r.owner === owner && r.name === name)?.defaultBranch ??
                    null;
                return reply.code(HTTP_OK).send({ branches: page.names, cursor: page.cursor, defaultBranch });
            } catch (e) {
                return branchReadRefusal(request, reply, { owner, name }, e);
            }
        }
    );
}

/**
 * What the caller's organization's App installation can see, for the repository picker.
 *
 * A route rather than a field on `/api/stats`'s `meta`, even though both describe repositories, and
 * the distinction is worth keeping straight: `meta.repos` is what the figures on the page were
 * *measured over*, while this is what a member could *choose to check out*. They come from the same
 * installation and could still diverge tomorrow, and conflating them would make the picker's
 * contents depend on a stats fetch having succeeded.
 */
export const repoRoutes =
    ({ config: _config, orgs }: RepoRouteDeps): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/repos', async (request, reply) => {
            const orgId = orgOf(request);
            const rt = await orgs.for(orgId);
            // Principal-carried org ids are FK-guaranteed, so null is a failed build, not a typo.
            if (!rt)
                return bad(reply, ERROR_CODES.REPOS_UNAVAILABLE, `No runtime for '${orgId}'; retry`, HTTP_UNAVAILABLE);
            const repos = rt.repos;

            const { repos: list, installation, error } = await repos.detail();

            // 200 with a named error and the last good list, never 503. Same rule /api/stats
            // follows: a failed refresh must keep the last good answer on screen and explain
            // itself, because an empty picker and an unreachable GitHub look identical otherwise.
            return reply.code(HTTP_OK).send({
                repos: list.map((repo) => ({
                    owner: repo.owner,
                    name: repo.name,
                    private: repo.private,
                    defaultBranch: repo.defaultBranch,
                    pushedAt: repo.pushedAt,
                })),
                installation,
                meta: {
                    fetchedAt: repos.fetchedAt() === null ? null : new Date(repos.fetchedAt()!).toISOString(),
                    // An empty list with no error is a real state, and the SPA renders a different
                    // thing for it: the App is installed nowhere, or on no repositories yet.
                    error,
                },
            });
        });
        registerBranchRoute(app, orgs);
    };
