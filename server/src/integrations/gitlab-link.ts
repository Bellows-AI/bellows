import { createHash, randomBytes } from 'node:crypto';
import { GITLAB_OAUTH_SCOPE, gitlabForgeOf } from '@factory-ai/core';
import type { Sql } from 'postgres';
import { safeReturnPath } from '../auth/session.js';
import type { ConnectionView, ForgeConnectionStore, GitlabApplication } from '../db/forge-connections.js';
import {
    classifyUnconsumedLink,
    consumeForgeLink,
    type ForgeLink,
    type ForgeLinkPurpose,
    insertForgeLink,
} from '../db/forge-links.js';
import { orgSql } from '../db/org-sql.js';
import type { GitlabApi } from '../gitlab/gitlab-api.js';
import { INTEGRATIONS_RETURN_PATH } from './authorization-types.js';
import type { MemberForgeGrants, MemberGrantTokens, StoreMemberGrantRefusal } from './member-forge-grant.js';
import type { ExchangeResult } from './oauth-provider.js';
import type { GitlabProvider } from './providers/gitlab.js';

/**
 * A person's GitLab authorization (docs/connections.md): a member links their own account, and the admin's grant
 * activates a pending connection. The state is single-use (`forge_link`); the code is exchanged and the identity found
 * through the org's own application; the pair is kept by the member forge grant keyed `gitlab:<host>`. Activation asks
 * the instance for its version with the admin's token first: a version below the minimum is refused with its reason, and an
 * answer that is not a verdict (unreachable, 5xx, malformed) leaves the connection pending and stores nothing.
 */

/** Where GitLab sends the person back: one path for every host and org, registered once on the OAuth application. */
export const GITLAB_CALLBACK_PATH = '/api/forge-grants/gitlab/callback';

export const GITLAB_LINK_TTL_MS = 600_000;
const EXCHANGE_DEADLINE_MS = 30_000;
const RANDOM_BYTES = 32;
const MS_PER_SECOND = 1000;

export const hashLinkState = (state: string): string => createHash('sha256').update(state).digest('hex');

export type StartLinkResult =
    | { ok: true; authorizeUrl: string; expiresAt: string }
    | { ok: false; reason: 'not-found' | 'not-active' | 'not-configured' | 'unavailable' };

export type LinkFailure =
    | 'denied'
    | 'state-mismatch'
    | 'replayed'
    | 'expired'
    | 'connection-gone'
    | 'not-active'
    | 'forbidden'
    | 'exchange-failed'
    | 'scope-missing'
    | 'unconfirmed'
    | 'version-too-old'
    | 'grant-conflict'
    | 'busy'
    | 'storage-failed'
    | 'unavailable';

export type LinkResult =
    | { ok: true; returnTo: string; result: 'linked' | 'activated' }
    | { ok: false; returnTo: string; failure: LinkFailure };

export interface GitlabLinks {
    start(input: {
        orgId: string;
        userId: string;
        connectionId: string;
        purpose: ForgeLinkPurpose;
        returnTo?: string | undefined;
    }): Promise<StartLinkResult>;
    complete(input: {
        orgId: string;
        userId: string;
        /** Whether the person is an admin of the org now: an activation is the admin's act. */
        admin: boolean;
        state: string | undefined;
        code: string | undefined;
        error: string | undefined;
    }): Promise<LinkResult>;
}

export interface GitlabLinksDeps {
    sql: Sql;
    connectionsOf(orgId: string): Promise<ForgeConnectionStore | undefined>;
    provider: GitlabProvider;
    api: GitlabApi;
    memberGrants: MemberForgeGrants;
    callbackOrigin: string | null;
    ttlMs?: number;
}

const redirectUriOf = (origin: string): string => new URL(GITLAB_CALLBACK_PATH, origin).toString();

type StartInput = Parameters<GitlabLinks['start']>[0];
type CompleteInput = Parameters<GitlabLinks['complete']>[0];
type Refused = { ok: false; failure: LinkFailure };

const refuse = (returnTo: string, failure: LinkFailure): LinkResult => ({ ok: false, returnTo, failure });

async function start(deps: GitlabLinksDeps, input: StartInput): Promise<StartLinkResult> {
    const { orgId, userId, connectionId, purpose } = input;
    const { callbackOrigin } = deps;
    const store = await deps.connectionsOf(orgId);
    const connection = await store?.get(connectionId);
    if (!connection) return { ok: false, reason: 'not-found' };
    if (purpose === 'link' && !connection.active) return { ok: false, reason: 'not-active' };
    if (callbackOrigin === null) return { ok: false, reason: 'not-configured' };
    const hooks = deps.provider.hooksFor(orgId, gitlabForgeOf(connection.host));
    const client = await deps.provider.clientOf(orgId, connection.host);
    if (!hooks || !client) return { ok: false, reason: 'not-found' };
    const state = randomBytes(RANDOM_BYTES).toString('base64url');
    const { expiresAt } = await insertForgeLink(orgSql(deps.sql, orgId), {
        orgId,
        userId,
        connectionId,
        purpose,
        stateHash: hashLinkState(state),
        returnTo: safeReturnPath(input.returnTo ?? INTEGRATIONS_RETURN_PATH, callbackOrigin),
        ttlMs: deps.ttlMs ?? GITLAB_LINK_TTL_MS,
    });
    const authorizeUrl = hooks.authorizeUrl({
        clientId: client.clientId,
        redirectUri: redirectUriOf(callbackOrigin),
        scopes: client.scopesFor('read'),
        state,
    });
    return { ok: true, authorizeUrl, expiresAt };
}

/** Consumes the callback's state: the link it was started for, or why it was not. */
async function consume(
    deps: GitlabLinksDeps,
    input: CompleteInput
): Promise<{ ok: true; link: ForgeLink } | { ok: false; returnTo: string; failure: LinkFailure }> {
    const { orgId, userId } = input;
    const stateMismatch = {
        ok: false as const,
        returnTo: INTEGRATIONS_RETURN_PATH,
        failure: 'state-mismatch' as const,
    };
    if (!input.state || deps.callbackOrigin === null) return stateMismatch;
    const db = orgSql(deps.sql, orgId);
    const owner = { orgId, userId, stateHash: hashLinkState(input.state) };
    const link = await consumeForgeLink(db, owner);
    if (link) return { ok: true, link };
    const why = await classifyUnconsumedLink(db, owner);
    return 'returnTo' in why ? { ok: false, returnTo: why.returnTo, failure: why.failure } : stateMismatch;
}

async function complete(deps: GitlabLinksDeps, input: CompleteInput): Promise<LinkResult> {
    const consumed = await consume(deps, input);
    if (!consumed.ok) return consumed;
    const { link } = consumed;
    const { returnTo } = link;
    if (input.error !== undefined || !input.code) return refuse(returnTo, 'denied');
    const target = await targetOf(deps, input, link);
    if (!target.ok) return refuse(returnTo, target.failure);
    const issued = await issuedFor(deps.provider, target, input.code, redirectUriOf(deps.callbackOrigin!));
    if (!issued.ok) return refuse(returnTo, issued.failure);
    const checked = link.purpose === 'activate' ? await versionOf(deps, target, issued.accessToken) : null;
    if (checked && !checked.ok) return refuse(returnTo, checked.failure);
    const stored = await deps.memberGrants.store({
        orgId: input.orgId,
        userId: input.userId,
        forge: target.forge,
        externalAccountId: issued.externalAccountId,
        tokens: issued.tokens,
    });
    if (!stored.ok) return refuse(returnTo, storeFailureOf(stored.reason));
    if (!checked) return { ok: true, returnTo, result: 'linked' };
    if (!(await target.store.activate(target.connection.id, checked.version)))
        return refuse(returnTo, 'connection-gone');
    return { ok: true, returnTo, result: 'activated' };
}

interface Target {
    ok: true;
    orgId: string;
    store: ForgeConnectionStore;
    connection: ConnectionView;
    application: GitlabApplication;
    forge: string;
}

/** The connection the link was for and its application, and whether this person may complete it. */
async function targetOf(deps: GitlabLinksDeps, input: CompleteInput, link: ForgeLink): Promise<Target | Refused> {
    const store = await deps.connectionsOf(input.orgId);
    const connection = await store?.get(link.connectionId);
    if (!store || !connection) return { ok: false, failure: 'connection-gone' };
    if (link.purpose === 'link' && !connection.active) return { ok: false, failure: 'not-active' };
    if (link.purpose === 'activate' && !input.admin) return { ok: false, failure: 'forbidden' };
    let application: GitlabApplication | null;
    try {
        application = await store.application(connection.host);
    } catch {
        return { ok: false, failure: 'unavailable' };
    }
    if (!application) return { ok: false, failure: 'connection-gone' };
    return { ok: true, orgId: input.orgId, store, connection, application, forge: gitlabForgeOf(connection.host) };
}

/** The authenticated version check that activates a connection; unconfirmed leaves it pending, too old refuses it. */
async function versionOf(
    deps: GitlabLinksDeps,
    target: Target,
    token: string
): Promise<{ ok: true; version: string } | Refused> {
    const checked = await deps.api.checkVersion({
        host: target.connection.host,
        token,
        caBundle: target.application.caBundle,
        signal: AbortSignal.timeout(EXCHANGE_DEADLINE_MS),
    });
    if (checked.ok) return checked;
    if (checked.reason === 'inconclusive') return { ok: false, failure: 'unconfirmed' };
    await target.store.refuseActivation(target.connection.id, 'version-too-old');
    return { ok: false, failure: 'version-too-old' };
}

export const createGitlabLinks = (deps: GitlabLinksDeps): GitlabLinks => ({
    start: (input) => start(deps, input),
    complete: (input) => complete(deps, input),
});

const storeFailureOf = (reason: StoreMemberGrantRefusal): LinkFailure => {
    if (reason === 'conflict') return 'grant-conflict';
    return reason === 'busy' ? 'busy' : 'storage-failed';
};

/** What the code exchange and the identity lookup yield: the pair to keep and whose it is. */
async function issuedFor(
    provider: GitlabProvider,
    target: Target,
    code: string,
    redirectUri: string
): Promise<{ ok: true; accessToken: string; externalAccountId: string; tokens: MemberGrantTokens } | Refused> {
    const hooks = provider.hooksFor(target.orgId, target.forge);
    if (!hooks) return { ok: false, failure: 'connection-gone' };
    const exchanged: ExchangeResult = await hooks
        .exchangeCode({ code, redirectUri, signal: AbortSignal.timeout(EXCHANGE_DEADLINE_MS) })
        .catch((): ExchangeResult => ({ ok: false, failure: 'ambiguous' }));
    if (!exchanged.ok) return { ok: false, failure: 'exchange-failed' };
    const { accessToken, refreshToken, expiresAt, authority } = exchanged.tokens;
    if (!refreshToken || expiresAt === null) return { ok: false, failure: 'exchange-failed' };
    if (!authority?.scopes.includes(GITLAB_OAUTH_SCOPE)) return { ok: false, failure: 'scope-missing' };
    const identity = await hooks
        .discoverIdentity({ accessToken, signal: AbortSignal.timeout(EXCHANGE_DEADLINE_MS) })
        .catch(() => null);
    if (!identity) return { ok: false, failure: 'unconfirmed' };
    return {
        ok: true,
        accessToken,
        externalAccountId: identity.externalAccountId,
        tokens: {
            accessToken,
            refreshToken,
            expiresIn: Math.max(1, Math.round((expiresAt - Date.now()) / MS_PER_SECOND)),
        },
    };
}
