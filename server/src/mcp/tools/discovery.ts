import { z } from 'zod';
import { inconclusive, judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { pageOf, PAGING_INPUT } from './paging.js';

const ReposSchema = z.object({
    repos: z.array(
        z.object({
            owner: z.string(),
            name: z.string(),
            private: z.boolean(),
            defaultBranch: z.string().nullable(),
            pushedAt: z.string().nullable(),
        })
    ),
    meta: z.object({ fetchedAt: z.string().nullable(), error: z.string().nullable() }),
});

/** The repositories the board tracks. A refresh that failed keeps the last good list and says so: `stale`. */
export const listRepos = defineTool({
    name: 'list_repos',
    description:
        'List the repositories the board tracks, sorted by name. `stale` is true when the board could not refresh the list: then `error` names why and the list may be old or incomplete, so a repository missing from it is not proof it is absent.',
    scope: 'factory:read',
    routes: [['GET', '/api/repos']],
    annotations: READ_ONLY,
    input: z.object(PAGING_INPUT),
    output: z.object({
        repos: z.array(
            z.object({
                repo: z.string(),
                private: z.boolean(),
                defaultBranch: z.string().nullable(),
                pushedAt: z.string().nullable(),
            })
        ),
        cursor: z.string().nullable(),
        stale: z.boolean(),
        error: z.string().nullable(),
        fetchedAt: z.string().nullable(),
    }),
    async run(args, ctx) {
        const judged = judge(await ctx.fetch({ method: 'GET', url: '/api/repos' }), ReposSchema);
        if (!judged.ok) return judged.tagged;
        const rows = judged.data.repos.map((r) => ({
            repo: `${r.owner}/${r.name}`,
            private: r.private,
            defaultBranch: r.defaultBranch,
            pushedAt: r.pushedAt,
        }));
        const { page, cursor } = pageOf(rows, (row) => row.repo, args);
        const { error, fetchedAt } = judged.data.meta;
        const stale = error !== null;
        return {
            outcome: 'ok',
            result: success(
                { repos: page, cursor, stale, error, fetchedAt },
                `${page.length} repositories${stale ? ` (stale: ${error})` : ''}${cursor ? ', more available' : ''}`
            ),
        };
    },
});

const ExecutorRow = z.object({ name: z.string(), type: z.string(), suspended: z.boolean().optional() });
const WorkspaceSchema = z.object({
    executors: z.array(ExecutorRow),
    orgExecutors: z.array(ExecutorRow),
    defaultExecutor: z.object({ scope: z.string(), name: z.string() }).nullable(),
    executorsAvailable: z.boolean(),
});

/** The executor profiles a task may name: the caller's own, then the organization's. */
export const listExecutors = defineTool({
    name: 'list_executors',
    description:
        'List the executor profiles a task can run on: your personal ones (scope "user") and the organization\'s (scope "org"). `default` marks what a task naming no executor gets. Pass `name` and `scope` as the executor and executorScope of a task. Credentials are never returned.',
    scope: 'factory:read',
    routes: [['GET', '/api/workspace']],
    annotations: READ_ONLY,
    input: z.object({}),
    output: z.object({
        executors: z.array(
            z.object({
                scope: z.enum(['user', 'org']),
                name: z.string(),
                type: z.string(),
                suspended: z.boolean(),
                default: z.boolean(),
            })
        ),
    }),
    async run(_args, ctx) {
        const judged = judge(await ctx.fetch({ method: 'GET', url: '/api/workspace' }), WorkspaceSchema);
        if (!judged.ok) return judged.tagged;
        const { executors, orgExecutors, defaultExecutor, executorsAvailable } = judged.data;
        if (!executorsAvailable) {
            return { outcome: 'inconclusive', result: inconclusive('this board has no executor store to read') };
        }
        const row = (scope: 'user' | 'org', profile: z.infer<typeof ExecutorRow>) => ({
            scope,
            name: profile.name,
            type: profile.type,
            suspended: profile.suspended === true,
            default: defaultExecutor?.scope === scope && defaultExecutor.name === profile.name,
        });
        const rows = [...executors.map((p) => row('user', p)), ...orgExecutors.map((p) => row('org', p))];
        return { outcome: 'ok', result: success({ executors: rows }, `${rows.length} executors`) };
    },
});
