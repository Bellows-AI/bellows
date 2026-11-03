import { z } from 'zod';
import { judge, success } from '../result.js';
import { defineTool, READ_ONLY } from '../tool.js';

const MeSchema = z.object({
    authenticated: z.literal(true),
    user: z.object({ id: z.string(), login: z.string(), name: z.string().nullable().optional() }),
    role: z.string(),
    scopes: z.union([z.literal('all'), z.array(z.string())]),
    organization: z.object({ id: z.string() }).loose(),
    mode: z.string(),
});
const VersionSchema = z.object({ version: z.string() });

/** Who the connected credential acts as: the account, the organization, what the grant may do, and the board build. */
export const whoami = defineTool({
    name: 'whoami',
    description:
        'Show the account, organization, role and granted scopes this connection acts as, and the board version.',
    scope: 'factory:read',
    routes: [
        ['GET', '/api/auth/me'],
        ['GET', '/api/version'],
    ],
    annotations: READ_ONLY,
    input: z.object({}),
    output: z.object({
        account: z.object({ id: z.string(), login: z.string(), name: z.string().nullable().optional() }),
        role: z.string(),
        organization: z.object({ id: z.string() }).loose(),
        scopes: z.union([z.literal('all'), z.array(z.string())]),
        mode: z.string(),
        version: z.string(),
    }),
    async run(_args, ctx) {
        const [me, build] = await Promise.all([
            ctx.fetch({ method: 'GET', url: '/api/auth/me' }),
            ctx.fetch({ method: 'GET', url: '/api/version' }),
        ]);
        const identity = judge(me, MeSchema);
        if (!identity.ok) return identity.tagged;
        const version = judge(build, VersionSchema);
        if (!version.ok) return version.tagged;
        const { user, role, scopes, organization, mode } = identity.data;
        return {
            outcome: 'ok',
            result: success(
                { account: user, role, organization, scopes, mode, version: version.data.version },
                `${user.login} in ${organization.id} as ${role}, version ${version.data.version}`
            ),
        };
    },
});
