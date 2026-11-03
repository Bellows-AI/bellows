import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { mintMcpToken } from './access-token.js';
import { hashToken } from './session.js';
import { toCaller, type Caller, type CallerRow } from './store.js';

/**
 * Inbound OAuth storage for the MCP server (BEL-101): clients, authorization codes, grant families, the `mat_` /
 * `mrt_` token pair and the consent transaction. Every refusal is a closed `OAuthError` value, never a thrown
 * message; the token endpoint maps it to the RFC 6749 code of the same name.
 *
 * Invariants a reader cannot see from one function:
 * - Reach is the live `org_membership` join in `findAccessToken`, never a column here.
 * - The family row is the lock: `refresh`, `revoke` and a code replay all `select … for update` it first.
 * - Only hashes are stored; a raw code, token, consent id or CSRF value is returned once, at creation.
 */

export type OAuthError = 'invalid_grant' | 'invalid_scope' | 'invalid_target';
export type OAuthResult<T> = ({ ok: true } & T) | { ok: false; error: OAuthError };

export interface TokenGrant {
    accessToken: string;
    refreshToken: string;
    /** Access token lifetime, seconds. */
    expiresIn: number;
    scopes: readonly string[];
    familyId: string;
}

/** What `findAccessToken` resolves: the live caller plus the grant that authorizes it. */
export type McpCaller = Caller & {
    scopes: readonly string[];
    clientId: string;
    resource: string;
    familyId: string;
};

export type OAuthClientKind = 'cimd' | 'dcr';

export interface OAuthClient {
    clientId: string;
    kind: OAuthClientKind;
    name: string | null;
    redirectUris: readonly string[];
    metadata: Record<string, unknown> | null;
    /** CIMD only: when the metadata document was last fetched. */
    fetchedAt: Date | null;
}

export interface ConsentView {
    sessionHash: Buffer;
    clientId: string;
    redirectUri: string;
    resource: string;
    scopes: readonly string[];
    codeChallenge: string;
    clientState: string | null;
}

export interface OAuthStore {
    upsertClient(input: {
        clientId: string;
        kind: OAuthClientKind;
        name: string | null;
        redirectUris: readonly string[];
        metadata?: Record<string, unknown>;
        fetchedAt?: Date;
    }): Promise<void>;
    findClient(clientId: string): Promise<OAuthClient | null>;
    /** Deletes DCR clients with no grant and no use for 30 days; answers how many. */
    deleteUnusedClients(): Promise<number>;

    createCode(input: {
        clientId: string;
        userId: string;
        orgId: string;
        scopes: readonly string[];
        codeChallenge: string;
        resource: string;
        redirectUri: string;
        ttlSeconds?: number;
    }): Promise<{ code: string }>;
    /**
     * One transaction: spend the code, create the family, mint the first pair. A code presented with another client,
     * redirect, resource or PKCE verifier is burned and refused; a replay of a spent code revokes its family.
     */
    consumeCode(input: {
        code: string;
        clientId: string;
        redirectUri: string;
        resource: string;
        codeVerifier: string;
    }): Promise<OAuthResult<TokenGrant>>;

    /**
     * Rotates a refresh token under the family lock. The grant's client, org and resource are fixed; scopes may only
     * narrow. A spent refresh token (including the loser of a concurrent refresh) revokes the family.
     */
    refresh(input: {
        refreshToken: string;
        clientId: string;
        scopes?: readonly string[];
        resource?: string;
        orgId?: string;
    }): Promise<OAuthResult<TokenGrant>>;
    /** RFC 7009: a refresh token ends its family, an access token only itself; another client's token is ignored. */
    revoke(input: { token: string; clientId: string }): Promise<void>;
    revokeFamily(familyId: string): Promise<void>;
    findAccessToken(tokenHash: Buffer): Promise<McpCaller | null>;

    createConsent(input: {
        sessionHash: Buffer;
        clientId: string;
        redirectUri: string;
        resource: string;
        scopes: readonly string[];
        codeChallenge: string;
        clientState?: string | null;
        ttlSeconds?: number;
    }): Promise<{ id: string; csrf: string }>;
    /** An unspent, unexpired transaction by its raw id. */
    readConsent(id: string): Promise<ConsentView | null>;
    /** Spends the transaction once, for the session and CSRF value it was created with; a wrong value burns nothing. */
    consumeConsent(input: { id: string; sessionHash: Buffer; csrf: string }): Promise<ConsentView | null>;
}

export interface OAuthStoreOptions {
    sql: Sql;
    ready?: Promise<unknown>;
    /** Injected so expiry is testable; every comparison in this store uses it, never the database clock. */
    now?: () => Date;
    accessTtlSeconds?: number;
    refreshTtlSeconds?: number;
}

const HOUR = 3600;
const DAY = 86400;
const CODE_TTL_SECONDS = 60;
const CONSENT_TTL_SECONDS = 600;
const UNUSED_CLIENT_DAYS = 30;
const SECRET_BYTES = 32;
const MS_PER_SECOND = 1000;
const REFRESH_DAYS = 30;

const invalid = (error: OAuthError): { ok: false; error: OAuthError } => ({ ok: false, error });
const secret = (): string => randomBytes(SECRET_BYTES).toString('base64url');
const plus = (at: Date, seconds: number): Date => new Date(at.getTime() + seconds * MS_PER_SECOND);
const isSubset = (wanted: readonly string[], allowed: readonly string[]): boolean =>
    wanted.length > 0 && wanted.every((scope) => allowed.includes(scope));

const challengeOf = (verifier: string): Buffer => createHash('sha256').update(verifier).digest();
const verifierMatches = (verifier: string, challenge: string): boolean => {
    const expected = Buffer.from(challenge);
    const provided = Buffer.from(challengeOf(verifier).toString('base64url'));
    return expected.length === provided.length && timingSafeEqual(expected, provided);
};

interface ClientRow {
    client_id: string;
    kind: OAuthClientKind;
    client_name: string | null;
    redirect_uris: string[];
    metadata: Record<string, unknown> | null;
    fetched_at: Date | null;
}

interface CodeRow {
    client_id: string;
    user_id: string;
    org_id: string;
    scopes: string[];
    code_challenge: string;
    resource: string;
    redirect_uri: string;
}

interface FamilyRow {
    id: string;
    client_id: string;
    org_id: string;
    resource: string;
    revoked_at: Date | null;
    expires_at: Date;
}

interface TokenRow {
    family_id: string;
    scopes: string[];
    expires_at: Date;
    revoked_at: Date | null;
    rotated_at: Date | null;
}

interface ConsentRow {
    session_hash: Buffer;
    client_id: string;
    redirect_uri: string;
    resource: string;
    scopes: string[];
    code_challenge: string;
    client_state: string | null;
}

type Tx = TransactionSql;

const toConsent = (row: ConsentRow): ConsentView => ({
    sessionHash: row.session_hash,
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    resource: row.resource,
    scopes: row.scopes,
    codeChallenge: row.code_challenge,
    clientState: row.client_state,
});

interface Ctx {
    sql: Sql;
    now: () => Date;
    accessTtl: number;
    refreshTtl: number;
    gate: () => Promise<void>;
}

/** Takes the family lock; every writer of a family's tokens goes through it. */
const lockFamily = async (tx: Tx, familyId: string): Promise<FamilyRow | undefined> => {
    const rows = await tx<FamilyRow[]>`
        select id, client_id, org_id, resource, revoked_at, expires_at
        from oauth_grant_family where id = ${familyId} for update
    `;
    return rows[0];
};

const revokeLocked = async (tx: Tx, familyId: string, at: Date): Promise<void> => {
    await tx`update oauth_grant_family set revoked_at = ${at} where id = ${familyId} and revoked_at is null`;
    await tx`update oauth_token set revoked_at = ${at} where family_id = ${familyId} and revoked_at is null`;
};

interface PairInput {
    familyId: string;
    scopes: readonly string[];
    familyExpiresAt: Date;
    at: Date;
    rotatedFrom: Buffer | null;
}

const mintPair = async (ctx: Ctx, tx: Tx, input: PairInput): Promise<TokenGrant> => {
    const accessToken = mintMcpToken('access');
    const refreshToken = mintMcpToken('refresh');
    const rows = [
        { token: accessToken, kind: 'access', expires: plus(input.at, ctx.accessTtl), from: null },
        { token: refreshToken, kind: 'refresh', expires: input.familyExpiresAt, from: input.rotatedFrom },
    ];
    for (const row of rows) {
        await tx`
            insert into oauth_token (token_hash, kind, family_id, scopes, created_at, expires_at, rotated_from)
            values (${hashToken(row.token)}, ${row.kind}, ${input.familyId}, ${ctx.sql.array([...input.scopes])},
                    ${input.at}, ${row.expires}, ${row.from})
        `;
    }
    return {
        accessToken,
        refreshToken,
        expiresIn: ctx.accessTtl,
        scopes: [...input.scopes],
        familyId: input.familyId,
    };
};

type ConsumeInput = Parameters<OAuthStore['consumeCode']>[0];
type RefreshInput = Parameters<OAuthStore['refresh']>[0];

const codeMismatch = (code: CodeRow, input: ConsumeInput): boolean =>
    code.client_id !== input.clientId ||
    code.redirect_uri !== input.redirectUri ||
    code.resource !== input.resource ||
    !verifierMatches(input.codeVerifier, code.code_challenge);

/** A spent code that already created a family is a replay: that grant ends. */
const revokeReplayedFamily = async (tx: Tx, codeHash: Buffer, at: Date): Promise<void> => {
    // A concurrent winner has committed by now (the spend waited on its row lock), so its family is visible.
    const prior = await tx<{ family_id: string | null }[]>`
        select family_id from oauth_authorization_code where code_hash = ${codeHash} and used_at is not null
    `;
    const familyId = prior[0]?.family_id;
    if (!familyId) return;
    await lockFamily(tx, familyId);
    await revokeLocked(tx, familyId, at);
};

const consumeCodeTx = async (ctx: Ctx, tx: Tx, input: ConsumeInput, at: Date): Promise<OAuthResult<TokenGrant>> => {
    const codeHash = hashToken(input.code);
    const spent = await tx<CodeRow[]>`
        update oauth_authorization_code set used_at = ${at}
        where code_hash = ${codeHash} and used_at is null and expires_at > ${at}
        returning client_id, user_id, org_id, scopes, code_challenge, resource, redirect_uri
    `;
    const code = spent[0];
    if (!code) {
        await revokeReplayedFamily(tx, codeHash, at);
        return invalid('invalid_grant');
    }
    // A mismatch leaves the code spent: a guessed verifier or redirect gets one try.
    if (codeMismatch(code, input)) return invalid('invalid_grant');
    const familyExpiresAt = plus(at, ctx.refreshTtl);
    const families = await tx<{ id: string }[]>`
        insert into oauth_grant_family (client_id, user_id, org_id, resource, scopes, created_at, expires_at)
        values (${code.client_id}, ${code.user_id}, ${code.org_id}, ${code.resource},
                ${ctx.sql.array(code.scopes)}, ${at}, ${familyExpiresAt})
        returning id
    `;
    const familyId = families[0]!.id;
    await tx`update oauth_authorization_code set family_id = ${familyId} where code_hash = ${codeHash}`;
    await tx`update oauth_client set last_used_at = ${at} where client_id = ${code.client_id}`;
    const pair = await mintPair(ctx, tx, { familyId, scopes: code.scopes, familyExpiresAt, at, rotatedFrom: null });
    return { ok: true, ...pair };
};

/** The refusal for a refresh request against its (locked) family and token, or null when it may proceed. */
const refreshRefusal = (
    family: FamilyRow,
    token: TokenRow,
    input: RefreshInput,
    at: Date
): { error: OAuthError; revokeFamily: boolean } | null => {
    if (family.client_id !== input.clientId || family.revoked_at || family.expires_at <= at) {
        return { error: 'invalid_grant', revokeFamily: false };
    }
    // A spent refresh token presented again — a theft, a lost response, or the loser of a concurrent refresh.
    if (token.rotated_at || token.revoked_at) return { error: 'invalid_grant', revokeFamily: true };
    if (token.expires_at <= at) return { error: 'invalid_grant', revokeFamily: false };
    if (input.orgId !== undefined && input.orgId !== family.org_id) {
        return { error: 'invalid_grant', revokeFamily: false };
    }
    if (input.resource !== undefined && input.resource !== family.resource) {
        return { error: 'invalid_target', revokeFamily: false };
    }
    if (input.scopes !== undefined && !isSubset(input.scopes, token.scopes)) {
        return { error: 'invalid_scope', revokeFamily: false };
    }
    return null;
};

const refreshTx = async (ctx: Ctx, tx: Tx, input: RefreshInput, at: Date): Promise<OAuthResult<TokenGrant>> => {
    const tokenHash = hashToken(input.refreshToken);
    const found = await tx<{ family_id: string }[]>`
        select family_id from oauth_token where token_hash = ${tokenHash} and kind = 'refresh'
    `;
    if (!found[0]) return invalid('invalid_grant');
    const family = await lockFamily(tx, found[0].family_id);
    // Re-read under the lock: a concurrent refresh may have spent this token while we waited.
    const rows = await tx<TokenRow[]>`
        select family_id, scopes, expires_at, revoked_at, rotated_at from oauth_token where token_hash = ${tokenHash}
    `;
    const token = rows[0];
    if (!family || !token) return invalid('invalid_grant');
    const refusal = refreshRefusal(family, token, input, at);
    if (refusal) {
        if (refusal.revokeFamily) await revokeLocked(tx, family.id, at);
        return invalid(refusal.error);
    }
    await tx`update oauth_token set rotated_at = ${at} where token_hash = ${tokenHash}`;
    const pair = await mintPair(ctx, tx, {
        familyId: family.id,
        scopes: input.scopes ?? token.scopes,
        familyExpiresAt: family.expires_at,
        at,
        rotatedFrom: tokenHash,
    });
    return { ok: true, ...pair };
};

type ClientOps = Pick<OAuthStore, 'upsertClient' | 'findClient' | 'deleteUnusedClients'>;

const clientOps = (ctx: Ctx): ClientOps => ({
    async upsertClient(input) {
        await ctx.gate();
        await ctx.sql`
            insert into oauth_client (client_id, kind, client_name, redirect_uris, metadata, fetched_at, created_at)
            values (${input.clientId}, ${input.kind}, ${input.name}, ${ctx.sql.array([...input.redirectUris])},
                    ${input.metadata ? ctx.sql.json(input.metadata as never) : null}, ${input.fetchedAt ?? null},
                    ${ctx.now()})
            on conflict (client_id) do update set
                client_name = excluded.client_name, redirect_uris = excluded.redirect_uris,
                metadata = excluded.metadata, fetched_at = excluded.fetched_at
        `;
    },

    async findClient(clientId) {
        await ctx.gate();
        const rows = await ctx.sql<ClientRow[]>`
            select client_id, kind, client_name, redirect_uris, metadata, fetched_at
            from oauth_client where client_id = ${clientId}
        `;
        const row = rows[0];
        if (!row) return null;
        return {
            clientId: row.client_id,
            kind: row.kind,
            name: row.client_name,
            redirectUris: row.redirect_uris,
            metadata: row.metadata,
            fetchedAt: row.fetched_at,
        };
    },

    async deleteUnusedClients() {
        await ctx.gate();
        const cutoff = plus(ctx.now(), -UNUSED_CLIENT_DAYS * DAY);
        const rows = await ctx.sql`
            delete from oauth_client c
            where c.kind = 'dcr' and coalesce(c.last_used_at, c.created_at) < ${cutoff}
              and not exists (select 1 from oauth_grant_family f where f.client_id = c.client_id)
              and not exists (select 1 from oauth_authorization_code a where a.client_id = c.client_id)
              and not exists (select 1 from oauth_consent_transaction t where t.client_id = c.client_id)
            returning c.client_id
        `;
        return rows.length;
    },
});

type ConsentOps = Pick<OAuthStore, 'createConsent' | 'readConsent' | 'consumeConsent'>;

const consentOps = (ctx: Ctx): ConsentOps => ({
    async createConsent(input) {
        await ctx.gate();
        const id = secret();
        const csrf = secret();
        const at = ctx.now();
        await ctx.sql`
            insert into oauth_consent_transaction
                (id_hash, session_hash, client_id, redirect_uri, resource, scopes, code_challenge, client_state,
                 csrf_hash, created_at, expires_at)
            values (${hashToken(id)}, ${input.sessionHash}, ${input.clientId}, ${input.redirectUri},
                    ${input.resource}, ${ctx.sql.array([...input.scopes])}, ${input.codeChallenge},
                    ${input.clientState ?? null}, ${hashToken(csrf)}, ${at},
                    ${plus(at, input.ttlSeconds ?? CONSENT_TTL_SECONDS)})
        `;
        return { id, csrf };
    },

    async readConsent(id) {
        await ctx.gate();
        const rows = await ctx.sql<ConsentRow[]>`
            select session_hash, client_id, redirect_uri, resource, scopes, code_challenge, client_state
            from oauth_consent_transaction
            where id_hash = ${hashToken(id)} and used_at is null and expires_at > ${ctx.now()}
        `;
        return rows[0] ? toConsent(rows[0]) : null;
    },

    async consumeConsent(input) {
        await ctx.gate();
        const at = ctx.now();
        const rows = await ctx.sql<ConsentRow[]>`
            update oauth_consent_transaction set used_at = ${at}
            where id_hash = ${hashToken(input.id)} and session_hash = ${input.sessionHash}
              and csrf_hash = ${hashToken(input.csrf)} and used_at is null and expires_at > ${at}
            returning session_hash, client_id, redirect_uri, resource, scopes, code_challenge, client_state
        `;
        return rows[0] ? toConsent(rows[0]) : null;
    },
});

type GrantOps = Pick<
    OAuthStore,
    'createCode' | 'consumeCode' | 'refresh' | 'revoke' | 'revokeFamily' | 'findAccessToken'
>;

type AccessRow = CallerRow & { scopes: string[]; client_id: string; resource: string; family_id: string };

const grantOps = (ctx: Ctx): GrantOps => ({
    async createCode(input) {
        await ctx.gate();
        const code = secret();
        const at = ctx.now();
        await ctx.sql`
            insert into oauth_authorization_code
                (code_hash, client_id, user_id, org_id, scopes, code_challenge, resource, redirect_uri,
                 created_at, expires_at)
            values (${hashToken(code)}, ${input.clientId}, ${input.userId}, ${input.orgId},
                    ${ctx.sql.array([...input.scopes])}, ${input.codeChallenge}, ${input.resource},
                    ${input.redirectUri}, ${at}, ${plus(at, input.ttlSeconds ?? CODE_TTL_SECONDS)})
        `;
        return { code };
    },

    async consumeCode(input) {
        await ctx.gate();
        const at = ctx.now();
        return ctx.sql.begin((tx) => consumeCodeTx(ctx, tx, input, at));
    },

    async refresh(input) {
        await ctx.gate();
        const at = ctx.now();
        return ctx.sql.begin((tx) => refreshTx(ctx, tx, input, at));
    },

    async revoke(input) {
        await ctx.gate();
        const at = ctx.now();
        const tokenHash = hashToken(input.token);
        await ctx.sql.begin(async (tx) => {
            const rows = await tx<{ kind: string; family_id: string; client_id: string }[]>`
                select t.kind, t.family_id, f.client_id
                from oauth_token t join oauth_grant_family f on f.id = t.family_id
                where t.token_hash = ${tokenHash}
            `;
            const row = rows[0];
            if (!row || row.client_id !== input.clientId) return;
            if (row.kind === 'refresh') {
                await lockFamily(tx, row.family_id);
                await revokeLocked(tx, row.family_id, at);
                return;
            }
            await tx`update oauth_token set revoked_at = ${at} where token_hash = ${tokenHash} and revoked_at is null`;
        });
    },

    async revokeFamily(familyId) {
        await ctx.gate();
        const at = ctx.now();
        await ctx.sql.begin(async (tx) => {
            if (await lockFamily(tx, familyId)) await revokeLocked(tx, familyId, at);
        });
    },

    async findAccessToken(tokenHash) {
        await ctx.gate();
        const at = ctx.now();
        const rows = await ctx.sql<AccessRow[]>`
            select u.id, u.github_user_id, u.github_login, u.display_name,
                   u.avatar_url, u.created_at, u.last_login_at,
                   m.invited_at, m.claimed_at, m.role,
                   o.id as org_id, o.name as org_name,
                   t.scopes, f.client_id, f.resource, f.id as family_id
            from oauth_token t
            join oauth_grant_family f on f.id = t.family_id
            join app_user u on u.id = f.user_id
            join organization o on o.id = f.org_id
            -- The same live join findPersonalToken runs: losing the membership ends the grant's reach on the
            -- very next request, and nothing in this schema cascades from it.
            join org_membership m on m.user_id = u.id and m.org_id = f.org_id
            where t.token_hash = ${tokenHash} and t.kind = 'access'
              and t.revoked_at is null and t.expires_at > ${at}
              and f.revoked_at is null and f.expires_at > ${at}
        `;
        const row = rows[0];
        if (!row) return null;
        return {
            ...toCaller(row),
            scopes: row.scopes,
            clientId: row.client_id,
            resource: row.resource,
            familyId: row.family_id,
        };
    },
});

export function createOAuthStore(options: OAuthStoreOptions): OAuthStore {
    const { sql, ready } = options;
    const ctx: Ctx = {
        sql,
        now: options.now ?? ((): Date => new Date()),
        accessTtl: options.accessTtlSeconds ?? HOUR,
        refreshTtl: options.refreshTtlSeconds ?? REFRESH_DAYS * DAY,
        gate: async (): Promise<void> => {
            if (ready) await ready;
        },
    };
    return { ...clientOps(ctx), ...grantOps(ctx), ...consentOps(ctx) };
}
