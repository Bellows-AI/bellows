import { connectionEnvNames, ERROR_CODES, isBranchName, selectedBy, type Skill } from '@factory-ai/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { orgOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import { bad, checkReposVisible } from './helpers.js';

const BRANCH_LIMIT = 255;

interface MenuSkill {
    name: string;
    description: string;
    source: 'builtin' | 'repo';
}

/** The built-ins plus the repo's skills; a repo read that did not confirm becomes `repoError`, never an empty list. */
async function listRepoSkillMenu(
    request: FastifyRequest,
    rt: Awaited<ReturnType<OrgRegistry['for']>>,
    target: { repo: string; branch: string | undefined },
    builtins: readonly { name: string; description: string }[]
) {
    const skills: MenuSkill[] = builtins.map(({ name, description }) => ({ name, description, source: 'builtin' }));
    if (!rt?.repoSkills) {
        return { skills, repoError: 'Repository skills cannot be read on this board', unreadable: [] as string[] };
    }
    const abort = new AbortController();
    request.raw.once('close', () => abort.abort());
    try {
        const read = await rt.repoSkills(target.repo, target.branch ?? null, abort.signal);
        // Managed outranks project in Claude Code: a built-in keeps its name.
        const taken = new Set(skills.map((s) => s.name));
        for (const skill of read.skills) if (!taken.has(skill.name)) skills.push({ ...skill, source: 'repo' });
        return { skills, repoError: null, unreadable: [...read.unreadable] };
    } catch (e) {
        request.log.warn({ err: e }, 'repo skills read failed');
        return {
            skills,
            repoError: `Repository skills could not be read: ${(e as Error).message}`,
            unreadable: [] as string[],
        };
    }
}

/**
 * `GET /api/skills`: what a task may select. Name, description and the declared requirements —
 * with each connection's env NAMES — and never the SKILL.md body or any env value. Reading the
 * catalog at registration means a broken catalog fails boot rather than the first request.
 *
 * `GET /api/repos/:owner/:name/skills`: the slash menu's list — the built-ins plus the repository's
 * own `.claude/skills` at a branch tip. A repo read that did not confirm is `repoError`, never
 * "the repo has no skills".
 */
export const skillRoutes =
    (catalog: () => Skill[], orgs: OrgRegistry): FastifyPluginAsync =>
    async (app) => {
        const builtins = catalog().map((skill) => ({
            name: skill.name,
            description: skill.description,
            requires: {
                tools: skill.requires.tools,
                connections: skill.requires.connections.map((name) => ({
                    name,
                    env: connectionEnvNames(name),
                    // A managed connection holds no env: the task selects it by this body field.
                    selectedBy: selectedBy(name),
                })),
            },
        }));
        app.get('/api/skills', async () => ({ skills: builtins }));

        app.get<{ Params: { owner: string; name: string }; Querystring: { branch?: string } }>(
            '/api/repos/:owner/:name/skills',
            async (request, reply) => {
                const { owner, name } = request.params;
                const branch = request.query.branch === '' ? undefined : request.query.branch;
                if (branch !== undefined && (branch.length > BRANCH_LIMIT || !isBranchName(branch))) {
                    return bad(reply, ERROR_CODES.BAD_BASE_BRANCH, 'branch must be a valid git branch name');
                }
                const rt = await orgs.for(orgOf(request));
                const visible = rt
                    ? await checkReposVisible(rt.repos, [{ owner, name }], { subject: 'the repository' })
                    : null;
                if (visible && !visible.ok) return bad(reply, visible.code, visible.message, visible.status);

                const { skills, repoError, unreadable } = await listRepoSkillMenu(
                    request,
                    rt,
                    { repo: `${owner}/${name}`, branch },
                    builtins
                );
                return { skills, repoError, unreadable };
            }
        );
    };
