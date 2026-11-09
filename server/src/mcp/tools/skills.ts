import { z } from 'zod';
import { judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { ConnectionRows, standingOf, type ConnectionStanding } from './connections.js';

const SOURCES = ['builtin', 'org', 'workspace', 'repo'] as const;

const SkillsSchema = z.object({
    repoError: z.string().nullable().optional(),
    complete: z.boolean().optional(),
    // The repo route lists overridden entries apart (declared requirements are not read for them).
    shadowed: z
        .array(
            z.object({
                name: z.string(),
                description: z.string(),
                source: z.enum(SOURCES),
                shadowedBy: z.enum(SOURCES),
            })
        )
        .optional(),
    skills: z.array(
        z.object({
            name: z.string(),
            description: z.string(),
            source: z.enum(SOURCES),
            shadowedBy: z.enum(SOURCES).optional(),
            switchedOff: z.boolean().optional(),
            requires: z.object({
                tools: z.array(z.string()),
                connections: z.array(z.object({ name: z.string(), selectedBy: z.string().nullable() })),
            }),
        })
    ),
});

type RequirementState = ConnectionStanding | 'unmanaged';

/**
 * The board's skill catalog. A skill that needs a provider connection is `provider`; its `state` is read from YOUR
 * connections now, so a skill name alone never says an operation is allowed.
 */
export const listSkills = defineTool({
    name: 'list_skills',
    description:
        'List the skills a task can select. `source` says where each comes from (`builtin`, `org`, `workspace`, `repo`); a name held by two sources lists the lower one with `shadowedBy`. Pass `repo` (owner/name, optionally `branch`) to include that repository\'s own `.claude/skills`; a failed read is `repoError`, never "no repo skills". `kind` is "manual" for a skill that needs nothing else, or "provider" for one that needs a connection: each of its `connections` says whether you currently have one (`connected`), have one whose grant lapsed (`needs_reconnect`), or have none (`missing`). A skill name alone authorizes nothing: the board checks your connection at create and at claim.',
    scope: 'factory:read',
    routes: [
        ['GET', '/api/skills'],
        ['GET', '/api/repos/:owner/:name/skills'],
        ['GET', '/api/connections'],
    ],
    annotations: READ_ONLY,
    input: z.object({
        repo: z
            .string()
            .regex(/^[^/\s]+\/[^/\s]+$/)
            .optional()
            .describe("owner/name: include this repository's own skills"),
        branch: z
            .string()
            .optional()
            .describe("the branch to read the repository's skills at; default branch if omitted"),
    }),
    output: z.object({
        repoError: z.string().nullable(),
        repoComplete: z
            .boolean()
            .describe('false when a repo was asked for and its skill listing was cut or unconfirmed: more may exist'),
        skills: z.array(
            z.object({
                name: z.string(),
                description: z.string(),
                source: z.enum(SOURCES),
                shadowedBy: z.enum(SOURCES).optional(),
                kind: z.enum(['manual', 'provider']),
                tools: z.array(z.string()),
                connections: z.array(
                    z.object({
                        provider: z.string(),
                        selectedBy: z.string().nullable(),
                        state: z.enum(['connected', 'needs_reconnect', 'missing', 'unmanaged']),
                    })
                ),
            })
        ),
    }),
    async run(args, ctx) {
        const url = args.repo
            ? `/api/repos/${args.repo}/skills${args.branch ? `?branch=${encodeURIComponent(args.branch)}` : ''}`
            : '/api/skills';
        const skills = judge(await ctx.fetch({ method: 'GET', url }), SkillsSchema);
        if (!skills.ok) return skills.tagged;
        // A built-in the org switched off is not selectable: it is not listed here.
        skills.data.skills = skills.data.skills.filter((skill) => skill.switchedOff !== true);
        const managed = skills.data.skills.some((skill) =>
            skill.requires.connections.some((connection) => connection.selectedBy !== null)
        );
        // Read only when a skill needs a managed connection; a read that fails leaves every state unknown, so no verdict.
        let rows: z.infer<typeof ConnectionRows>['connections'] = [];
        if (managed) {
            const read = judge(await ctx.fetch({ method: 'GET', url: '/api/connections' }), ConnectionRows);
            if (!read.ok) return read.tagged;
            rows = read.data.connections;
        }
        const out = skills.data.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
            ...(skill.shadowedBy === undefined ? {} : { shadowedBy: skill.shadowedBy }),
            kind: skill.requires.connections.length > 0 ? ('provider' as const) : ('manual' as const),
            tools: skill.requires.tools,
            connections: skill.requires.connections.map((connection) => ({
                provider: connection.name,
                selectedBy: connection.selectedBy,
                state: (connection.selectedBy === null
                    ? 'unmanaged'
                    : standingOf(rows, connection.name)) satisfies RequirementState,
            })),
        }));
        const overridden = (skills.data.shadowed ?? []).map((skill) => ({
            ...skill,
            kind: 'manual' as const,
            tools: [] as string[],
            connections: [] as (typeof out)[number]['connections'],
        }));
        out.push(...overridden);
        return {
            outcome: 'ok',
            result: success(
                {
                    skills: out,
                    repoError: skills.data.repoError ?? null,
                    repoComplete: !args.repo || skills.data.complete === true,
                },
                `${out.length} skills`
            ),
        };
    },
});
