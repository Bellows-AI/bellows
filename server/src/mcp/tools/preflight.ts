import { z } from 'zod';
import { inconclusive, judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { MAX_CONNECTIONS, MAX_NAME_CHARS, MAX_SELECTED } from './paging.js';

const Check = z.object({
    subject: z.enum(['repo', 'executor', 'skill', 'connection']),
    name: z.string().nullable(),
    status: z.enum(['ok', 'blocked', 'unverified']),
    detail: z.string(),
    integration: z
        .object({ provider: z.string(), reason: z.enum(['missing', 'ambiguous', 'reconnect', 'unknown']) })
        .optional(),
});
const PreflightSchema = z.object({ ready: z.boolean(), checks: z.array(Check).min(1) });

/**
 * The one word a caller acts on. `integration_required` only when every blocker is a connection of the caller's own
 * to make; any other blocker is `blocked`. With nothing blocked, a check the board could not confirm is `unverified`.
 */
function verdictOf(
    checks: readonly z.infer<typeof Check>[]
): 'ready' | 'blocked' | 'integration_required' | 'unverified' {
    const blocked = checks.filter((check) => check.status === 'blocked');
    if (blocked.length > 0) return blocked.every((check) => check.integration) ? 'integration_required' : 'blocked';
    return checks.some((check) => check.status === 'unverified') ? 'unverified' : 'ready';
}

/** The board's advisory check of a task's selection, as `job preflight` asks it. Writes nothing. */
export const preflightTask = defineTool({
    name: 'preflight_task',
    description:
        'Check, without creating anything, whether a task with this selection would be accepted. `verdict`: "ready" (every check passed), "blocked" (something must change), "integration_required" (only a connection of yours is missing, lapsed or ambiguous: see `integrationRequired`, connect it on the board, then pass its id in `connections`) or "unverified" (the board could not confirm some check: not a pass). Advisory: the board rechecks at create and at claim. Connects nothing and starts no OAuth.',
    scope: 'factory:read',
    routes: [['POST', '/api/jobs/preflight']],
    annotations: READ_ONLY,
    input: z.object({
        repo: z.string().max(MAX_NAME_CHARS).optional().describe('owner/name of the repository.'),
        baseBranch: z
            .string()
            .max(MAX_NAME_CHARS)
            .optional()
            .describe("The branch to check out and publish against; default is the repository's default branch."),
        executor: z
            .string()
            .max(MAX_NAME_CHARS)
            .optional()
            .describe('An executor profile name from list_executors; omit to check your default.'),
        executorScope: z.enum(['user', 'org']).optional().describe('Which profile list `executor` names.'),
        skills: z
            .array(z.string().max(MAX_NAME_CHARS))
            .max(MAX_SELECTED)
            .optional()
            .describe('Skill names from list_skills.'),
        connections: z
            .array(z.string().max(MAX_NAME_CHARS))
            .max(MAX_CONNECTIONS)
            .optional()
            .describe('Connection ids from list_connections to select for the task; omit to use your defaults.'),
    }),
    output: z.object({
        verdict: z.enum(['ready', 'blocked', 'integration_required', 'unverified']),
        ready: z.boolean(),
        checks: z.array(Check),
        integrationRequired: z.array(
            z.object({
                provider: z.string(),
                reason: z.enum(['missing', 'ambiguous', 'reconnect', 'unknown']),
                check: z.string(),
            })
        ),
    }),
    async run(args, ctx) {
        const judged = judge(
            await ctx.fetch({ method: 'POST', url: '/api/jobs/preflight', body: args }),
            PreflightSchema
        );
        if (!judged.ok) return judged.tagged;
        const { ready, checks } = judged.data;
        // `ready` and the checks must agree; an answer that contradicts itself is no answer.
        if (ready !== checks.every((check) => check.status !== 'blocked')) {
            return { outcome: 'inconclusive', result: inconclusive('the board preflight answer is inconsistent') };
        }
        const verdict = verdictOf(checks);
        const integrationRequired = checks.flatMap((check) =>
            check.status === 'blocked' && check.integration
                ? [{ ...check.integration, check: `${check.subject}:${check.name ?? ''}` }]
                : []
        );
        return {
            outcome: 'ok',
            result: success({ verdict, ready, checks, integrationRequired }, `preflight: ${verdict}`),
        };
    },
});
