import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createIntegrationRuntime, type IntegrationRuntime } from '../src/integrations/integration-recovery.js';
import { jiraRegistration } from '../src/integrations/providers/jira.js';
import { contextOfExecution, contextOfSession } from '../src/integrations/trusted-context.js';
import type { StartAuthorizationInput } from '../src/integrations/authorization-flow.js';
import { type FakeAtlassian, fakeResource } from '../test/fake-atlassian.js';
import { lineageHarness } from './integration-store-faults.js';

/**
 * The Jira tests' rig: the real runtime composed as main.ts does it, with the real Jira hooks pointed at a scripted
 * Atlassian on 127.0.0.1 as the only boundary. Every account, site and token is synthetic and unique to one test, so
 * tests share a database without sharing a row.
 */

export const READ_SCOPE = 'read:jira-work read:jira-user offline_access';
export const WRITE_SCOPE = `${READ_SCOPE} write:jira-work`;

export interface Script {
    tag: string;
    scope?: string;
    /** Host (without the domain) of each accessible site; the first is the one `/myself` is asked on. */
    sites?: string[];
    expiresIn?: number;
}

export const accountOf = (tag: string): string => `acct-${tag}`;
export const hostOf = (tag: string, site: string): string => `${site}-${tag}.atlassian.net`;
export const cloudOf = (tag: string, site: string): string => `cloud-${site}-${tag}`;
export const newTag = (): string => randomUUID().slice(0, 8);

/** Scripts the whole Atlassian for one account: code and refresh exchange, accessible sites, `/myself`. */
export function script(fake: FakeAtlassian, s: Script): void {
    const scope = s.scope ?? READ_SCOPE;
    const sites = s.sites ?? ['one'];
    fake.on('POST', /^\/oauth\/token$/, (call, n) => {
        const refresh = (call.body as { grant_type?: string } | null)?.grant_type === 'refresh_token';
        return {
            status: 200,
            json: {
                access_token: refresh ? `${s.tag}-access-r${n}` : `${s.tag}-access`,
                expires_in: refresh ? 3600 : (s.expiresIn ?? 3600),
                refresh_token: `${s.tag}-refresh-${n}`,
                scope,
            },
        };
    });
    fake.on('GET', /^\/oauth\/token\/accessible-resources$/, () => ({
        status: 200,
        json: sites.map((site) =>
            fakeResource({
                id: cloudOf(s.tag, site),
                url: `https://${hostOf(s.tag, site)}`,
                name: site,
                scopes: scope.split(' '),
            })
        ),
    }));
    fake.on('GET', /^\/ex\/jira\/[^/]+\/rest\/api\/3\/myself$/, () => ({
        status: 200,
        json: { accountId: accountOf(s.tag), displayName: `Name ${s.tag}`, emailAddress: `${s.tag}@example.com` },
    }));
}

/** How many refresh-token exchanges the fake has seen. */
export const refreshCalls = (fake: FakeAtlassian): number =>
    fake.calls.filter(
        (c) =>
            c.method === 'POST' &&
            c.path === '/oauth/token' &&
            (c.body as { grant_type?: string })?.grant_type === 'refresh_token'
    ).length;

export const codeCalls = (fake: FakeAtlassian): number =>
    fake.calls.filter(
        (c) =>
            c.method === 'POST' &&
            c.path === '/oauth/token' &&
            (c.body as { grant_type?: string })?.grant_type !== 'refresh_token'
    ).length;

/** One board replica: its own runtime over the shared database. */
export function jiraRuntime(
    sql: Sql,
    fake: FakeAtlassian,
    options: { configured?: boolean; secretsOf?: ReturnType<typeof lineageHarness> } = {}
): IntegrationRuntime {
    const h = options.secretsOf ?? lineageHarness(sql);
    const registration = jiraRegistration(
        options.configured === false
            ? null
            : {
                  clientId: 'client-1',
                  clientSecret: 'client-secret-1',
                  authorizeUrl: fake.authorizeUrl,
                  tokenUrl: fake.tokenUrl,
                  apiOrigin: fake.origin,
              }
    );
    return createIntegrationRuntime({
        sql,
        secrets: h.open(),
        providers: registration.providers,
        clients: registration.clients,
        callbackOrigin: 'https://board.example.test',
        timing: { retryDelayMs: 0 },
    });
}

export const stateOf = (authorizeUrl: string): string => new URL(authorizeUrl).searchParams.get('state')!;

/** Starts an authorization as `userId`; throws when refused. */
export async function begin(
    runtime: IntegrationRuntime,
    orgId: string,
    userId: string,
    input: Omit<StartAuthorizationInput, 'provider'> = {}
) {
    const ctx = contextOfSession({ user: { id: userId } }, orgId);
    const flow = runtime.flowOf(orgId);
    const started = await flow.startAuthorization(ctx, { provider: 'jira', ...input });
    if (!started.ok) throw new Error(`start refused: ${started.reason}`);
    const state = stateOf(started.authorizeUrl);
    return {
        ...started,
        state,
        scopes: new URL(started.authorizeUrl).searchParams.get('scope')!.split(' '),
        complete: (over: { code?: string | undefined; error?: string | undefined } = {}, as = ctx) =>
            flow.completeAuthorization(as, { state, code: 'code-1', ...over }),
    };
}

/** The resolver's answer for `connectionId` bound on `rootJobId`, as that root's execution user. */
export const resolveAs = (
    runtime: IntegrationRuntime,
    orgId: string,
    executionUserId: string,
    request: { rootJobId: string; connectionId: string }
) =>
    runtime
        .resolverOf(orgId)
        .resolveCredential(
            contextOfExecution({ orgId, executionUserId, jobId: randomUUID(), attempt: 1 }),
            request,
            {}
        );

export const connectionsOf = (sql: Sql, tag: string) =>
    sql<
        {
            id: string;
            status: string;
            access: string;
            site: string;
            cloud_id: string;
            email: string;
            grant_id: string;
        }[]
    >`
        select id, status, access, site, cloud_id, email, grant_id from connector_connection
        where external_account_id = ${accountOf(tag)} order by site
    `;

export const grantsOf = (sql: Sql, tag: string) =>
    sql<
        {
            id: string;
            status: string;
            authority: { scopes: string[] };
            secret_version: string | null;
            lineage_claim: string | null;
        }[]
    >`
        select id, status, authority, secret_version, lineage_claim from integration_grant
        where external_account_id = ${accountOf(tag)}
    `;
