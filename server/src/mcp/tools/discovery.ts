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

const ExecutorRow = z.object({
    name: z.string(),
    type: z.string(),
    runnerClass: z.string().nullable().optional(),
    suspended: z.boolean().optional(),
    suspendedReason: z.string().nullable().optional(),
    providerConnectionId: z.string().nullable().optional(),
    providerConnectionName: z.string().nullable().optional(),
    providerConnectionProvider: z.string().nullable().optional(),
    providerConnectionScope: z.enum(['org', 'personal']).nullable().optional(),
    configOverridesConnection: z.boolean().optional(),
});
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
                runnerClass: z
                    .string()
                    .nullable()
                    .describe('The runner class its tasks run on; null is the default. Only an org profile names one.'),
                suspended: z.boolean(),
                suspendedReason: z
                    .string()
                    .nullable()
                    .describe('Why the provider migration suspended it, until a connection is chosen; null otherwise.'),
                default: z.boolean(),
                providerConnectionId: z
                    .string()
                    .nullable()
                    .describe(
                        'The provider connection it runs its model on; null only on an executor the provider migration suspended.'
                    ),
                providerConnectionName: z.string().nullable().describe("That connection's name, when you may see it."),
                providerConnectionProvider: z.string().nullable().describe("That connection's model provider."),
                providerConnectionScope: z.enum(['org', 'personal']).nullable(),
                configOverridesConnection: z
                    .boolean()
                    .describe(
                        'True when pasted configuration credentials or endpoints take precedence over the connection.'
                    ),
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
            runnerClass: profile.runnerClass ?? null,
            suspended: profile.suspended === true,
            suspendedReason: profile.suspendedReason ?? null,
            providerConnectionId: profile.providerConnectionId ?? null,
            providerConnectionName: profile.providerConnectionName ?? null,
            providerConnectionProvider: profile.providerConnectionProvider ?? null,
            providerConnectionScope: profile.providerConnectionScope ?? null,
            configOverridesConnection: profile.configOverridesConnection === true,
            default: defaultExecutor?.scope === scope && defaultExecutor.name === profile.name,
        });
        const rows = [...executors.map((p) => row('user', p)), ...orgExecutors.map((p) => row('org', p))];
        return { outcome: 'ok', result: success({ executors: rows }, `${rows.length} executors`) };
    },
});
