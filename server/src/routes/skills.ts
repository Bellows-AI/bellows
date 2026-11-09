import {
    type CatalogEntry,
    connectionEnvNames,
    ERROR_CODES,
    isBranchName,
    selectedBy,
    type Skill,
} from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { orgOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import { abortOnClose, effectiveCatalog, type EffectiveCatalog, storedOf } from '../skill-catalog.js';
import { bad, checkReposVisible } from './helpers.js';

const HTTP_UNAVAILABLE = 503;

/** Org and workspace skills that could not be read: a 503, never a list that silently lacks them. */
const storedUnavailable = (reply: FastifyReply, catalog: EffectiveCatalog) =>
    bad(reply, ERROR_CODES.UNAVAILABLE, `Stored skills could not be read: ${catalog.storedError}`, HTTP_UNAVAILABLE);

const BRANCH_LIMIT = 255;

/** A catalog entry as a client sees it: the declared requirements with each connection's env NAMES, never a value. */
function wireOf(entry: CatalogEntry) {
    return {
        name: entry.name,
        description: entry.description,
        source: entry.source,
        ...(entry.shadowedBy === undefined ? {} : { shadowedBy: entry.shadowedBy }),
        requires: {
            tools: entry.requires.tools,
            connections: entry.requires.connections.map((name) => ({
                name,
                env: connectionEnvNames(name),
                // A managed connection holds no env: the task selects it by this body field.
                selectedBy: selectedBy(name),
            })),
        },
    };
}

/** The slash menu's body. An unconfirmed read is never "the repo has no skills": the built-ins list with the reason. */
function repoMenuOf(result: EffectiveCatalog, canRead: boolean) {
    const { repo } = result;
    let repoError: string | null = null;
    if (repo.state === 'unconfirmed') {
        repoError = canRead ? `Repository skills could not be read: ${repo.error}` : repo.error;
    }
    return {
        // The menu lists a name once: a name held by a higher source keeps its lower entries out of `skills`.
        skills: result.entries.filter((entry) => entry.shadowedBy === undefined).map(wireOf),
        shadowed: result.entries.flatMap((entry) =>
            entry.shadowedBy === undefined
                ? []
                : [
                      {
                          name: entry.name,
                          description: entry.description,
                          source: entry.source,
                          shadowedBy: entry.shadowedBy,
                      },
                  ]
        ),
        repoError,
        unreadable: repo.state === 'read' ? [...repo.unreadable] : [],
        // False when the listing was cut or unconfirmed: the repo skills shown are what was read, not all there are.
        complete: repo.state === 'read' && repo.complete,
        reserved: result.reserved,
    };
}

type RepoSkillsRoute = { Params: { owner: string; name: string }; Querystring: { branch?: string } };

function repoSkillsHandler(builtin: readonly Skill[], orgs: OrgRegistry) {
    return async (request: FastifyRequest<RepoSkillsRoute>, reply: FastifyReply) => {
        const { owner, name } = request.params;
        const branch = request.query.branch === '' ? undefined : request.query.branch;
        if (branch !== undefined && (branch.length > BRANCH_LIMIT || !isBranchName(branch))) {
            return bad(reply, ERROR_CODES.BAD_BASE_BRANCH, 'branch must be a valid git branch name');
        }
        const rt = await orgs.for(orgOf(request));
        const visible = rt ? await checkReposVisible(rt.repos, [{ owner, name }], { subject: 'the repository' }) : null;
        if (visible && !visible.ok) return bad(reply, visible.code, visible.message, visible.status);

        const result = await effectiveCatalog({
            builtin,
            read: rt?.repoSkills,
            repo: `${owner}/${name}`,
            branch: branch ?? null,
            signal: abortOnClose(reply),
            stored: storedOf(rt, request),
            onUnconfirmed: (err) => request.log.warn({ err }, 'repo skills read failed'),
        });
        if (result.storedError !== null) return storedUnavailable(reply, result);
        return repoMenuOf(result, rt?.repoSkills !== undefined);
    };
}

/**
 * `GET /api/skills`: what a task may select, from every source (`source`; a name held twice lists the lower one with `shadowedBy`; a built-in the org switched off is listed with `switchedOff: true` and is not selectable). Name, description and the declared requirements —
 * with each connection's env NAMES — and never the SKILL.md body or any env value. Reading the
 * catalog at registration means a broken catalog fails boot rather than the first request.
 *
 * `GET /api/repos/:owner/:name/skills`: the slash menu's list — the same catalog plus the repository's
 * own `.claude/skills` at a branch tip (`shadowed`: entries a higher source overrides, kept out of `skills`; `reserved`: names under the built-ins' prefix, not selectable). A repo read that did not confirm is `repoError`, never
 * "the repo has no skills".
 */
export const skillRoutes =
    (catalog: () => Skill[], orgs: OrgRegistry): FastifyPluginAsync =>
    async (app) => {
        const builtin = catalog();
        await effectiveCatalog({ builtin, read: undefined, repo: null, branch: null });
        app.get('/api/skills', async (request, reply) => {
            const rt = await orgs.for(orgOf(request));
            const result = await effectiveCatalog({
                builtin,
                read: undefined,
                repo: null,
                branch: null,
                stored: storedOf(rt, request),
                onUnconfirmed: (err) => request.log.warn({ err }, 'stored skills read failed'),
            });
            if (result.storedError !== null) return storedUnavailable(reply, result);
            // A switched-off built-in is listed so an admin can switch it back on, marked so no client offers it.
            const off = builtin
                .filter((skill) => result.switchedOff.includes(skill.name))
                .map((skill) => ({ ...wireOf({ ...skill, source: 'builtin' }), switchedOff: true }));
            return { skills: [...result.entries.map(wireOf), ...off] };
        });

        app.get<RepoSkillsRoute>('/api/repos/:owner/:name/skills', repoSkillsHandler(builtin, orgs));
    };
