import { z } from 'zod';
import { judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { ConnectionRows, standingOf, type ConnectionStanding } from './connections.js';

const SkillsSchema = z.object({
    skills: z.array(
        z.object({
            name: z.string(),
            description: z.string(),
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
        'List the skills a task can select. `kind` is "manual" for a skill that needs nothing else, or "provider" for one that needs a connection: each of its `connections` says whether you currently have one (`connected`), have one whose grant lapsed (`needs_reconnect`), or have none (`missing`). A skill name alone authorizes nothing: the board checks your connection at create and at claim.',
    scope: 'factory:read',
    routes: [
        ['GET', '/api/skills'],
        ['GET', '/api/connections'],
    ],
    annotations: READ_ONLY,
    input: z.object({}),
    output: z.object({
        skills: z.array(
            z.object({
                name: z.string(),
                description: z.string(),
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
    async run(_args, ctx) {
        const skills = judge(await ctx.fetch({ method: 'GET', url: '/api/skills' }), SkillsSchema);
        if (!skills.ok) return skills.tagged;
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
        return { outcome: 'ok', result: success({ skills: out }, `${out.length} skills`) };
    },
});
