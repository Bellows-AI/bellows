import type { Sql, TransactionSql } from 'postgres';
import { INTEGRATION_PROVIDERS, selectedBy } from '@factory-ai/core';
import { bindingStanding, type StandingRow } from '../integrations/credential-resolver.js';

/**
 * Which connections a task thread uses (094). The bindings belong to the thread ROOT and are append-only: each
 * is frozen at bind time (account, resource, grant, access) and stamped with the revision that added it. A
 * provider a skill needs but the execution user has no unambiguous connection for becomes an open requirement
 * instead of a post-claim refusal. Everything here runs in the caller's transaction.
 */

type Db = Sql | TransactionSql;

/** Providers a task can bind a connection for. GitHub is a repository capability, never bindable. */
export const BINDABLE_PROVIDERS: readonly string[] = Object.keys(INTEGRATION_PROVIDERS).filter(
    (provider) => selectedBy(provider) !== null
);

/** A create or follow-up named connections its author may not bind: the store's refusal, rolling the transaction back. */
export class ConnectionRefusedError extends Error {
    constructor(readonly reason: 'not-authorized' | 'duplicate') {
        super(`connections refused: ${reason}`);
        this.name = 'ConnectionRefusedError';
    }
}

export type BindingSource = 'explicit' | 'default' | 'follow_up' | 'requirement' | 'migrated';

export interface ResolvedBinding {
    connectionId: string;
    provider: string;
    credential: string;
    externalAccountId: string | null;
    resource: string;
    grantId: string | null;
    authority: Record<string, unknown>;
    access: string;
    source: 'explicit' | 'default';
}

export interface ResolvedRequirement {
    provider: string;
    reason: 'missing' | 'ambiguous';
}

export interface Resolution {
    ok: true;
    bindings: ResolvedBinding[];
    requirements: ResolvedRequirement[];
}

export type ResolveRefusal = { ok: false; reason: 'not-authorized' | 'duplicate' | 'unknown-provider' };

export interface ResolveInput {
    orgId: string;
    /** The thread's execution identity: its own connections are the only default candidates. */
    executionUser: string;
    explicit: string[];
    /** Providers to bind a default for when no explicit connection covers them. */
    providers: string[];
    /** Providers whose absence records a requirement; defaults to all of `providers`. */
    required?: string[] | undefined;
}

interface BindableRow {
    id: string;
    provider: string;
    credential: string;
    external_account_id: string | null;
    cloud_id: string;
    grant_id: string | null;
    authority: Record<string, unknown> | null;
    access: string;
    principal_user_id: string | null;
}

const toResolved = (row: BindableRow, source: 'explicit' | 'default'): ResolvedBinding => ({
    connectionId: row.id,
    provider: row.provider,
    credential: row.credential,
    externalAccountId: row.external_account_id,
    resource: row.cloud_id,
    grantId: row.grant_id,
    authority: row.authority ?? {},
    access: row.access,
    source,
});

/**
 * The connections `userId` may bind in `orgId`, share-locked so a concurrent disconnect waits for this bind's
 * commit (and recomputes the projection with it) or is seen by it first: active, theirs, an OAuth connection, and an active grant. Anything else (another member's, another org's, disconnected) is absent.
 */
async function bindableByIds(db: Db, orgId: string, userId: string, ids: string[]): Promise<BindableRow[]> {
    if (ids.length === 0) return [];
    return db<BindableRow[]>`
        select c.id, c.provider, c.credential, c.external_account_id, c.cloud_id, c.grant_id, g.authority, c.access,
               c.principal_user_id
        from connector_connection c
        left join integration_grant g on g.id = c.grant_id
        where c.org_id = ${orgId} and c.id in ${db(ids)} and c.status = 'active'
          and c.credential = 'oauth_grant' and c.principal_user_id = ${userId}
          and (c.grant_id is null or g.status = 'active')
        for share of c
    `;
}

/**
 * The execution user's own usable OAuth connections for a provider, newest first, at most two (one is the
 * unambiguous default, two are ambiguous), share-locked like `bindableByIds`.
 */
async function defaultCandidates(db: Db, orgId: string, provider: string, userId: string): Promise<BindableRow[]> {
    return db<BindableRow[]>`
        select c.id, c.provider, c.credential, c.external_account_id, c.cloud_id, c.grant_id, g.authority, c.access,
               c.principal_user_id
        from connector_connection c
        left join integration_grant g on g.id = c.grant_id
        where c.org_id = ${orgId} and c.provider = ${provider} and c.status = 'active'
          and c.credential = 'oauth_grant' and c.principal_user_id = ${userId}
          and (c.grant_id is null or g.status = 'active')
        order by c.created_at desc, c.id
        limit 2
        for share of c
    `;
}

export async function resolveBindingsInTx(db: Db, input: ResolveInput): Promise<Resolution | ResolveRefusal> {
    const { orgId, executionUser, explicit, providers } = input;
    if (new Set(explicit).size !== explicit.length) return { ok: false, reason: 'duplicate' };
    if (providers.some((p) => !BINDABLE_PROVIDERS.includes(p))) return { ok: false, reason: 'unknown-provider' };
    const required = new Set(input.required ?? providers);

    const chosen = await bindableByIds(db, orgId, executionUser, explicit);
    if (chosen.length !== explicit.length) return { ok: false, reason: 'not-authorized' };
    const byId = new Map(chosen.map((row) => [row.id, row]));
    const bindings = explicit.map((id) => toResolved(byId.get(id)!, 'explicit'));
    const covered = new Set(bindings.map((b) => b.provider));

    const requirements: ResolvedRequirement[] = [];
    for (const provider of providers) {
        if (covered.has(provider)) continue;
        const candidates = await defaultCandidates(db, orgId, provider, executionUser);
        if (candidates.length === 1) bindings.push(toResolved(candidates[0]!, 'default'));
        else if (required.has(provider)) {
            requirements.push({ provider, reason: candidates.length === 0 ? 'missing' : 'ambiguous' });
        }
    }
    return { ok: true, bindings, requirements };
}

type NewBinding = Omit<ResolvedBinding, 'source'> & { source: BindingSource };

async function insertBindings(
    db: Db,
    args: { orgId: string; rootJobId: string; revision: number; addedBy: string | null; bindings: NewBinding[] }
): Promise<void> {
    for (const b of args.bindings) {
        await db`
            insert into job_connection_binding
                (org_id, root_job_id, revision, connection_id, provider, credential, external_account_id, resource,
                 grant_id, authority, access, source, added_by)
            values (${args.orgId}, ${args.rootJobId}, ${args.revision}, ${b.connectionId}, ${b.provider},
                    ${b.credential}, ${b.externalAccountId}, ${b.resource}, ${b.grantId},
                    ${db.json(b.authority as never)}, ${b.access}, ${b.source}, ${args.addedBy})
        `;
    }
}

/**
 * Rollout projection, dropped with `job.jira_connection_id` by the contract release: an old pod reads the root's
 * column, so new code keeps it equal to the connection of the root's ONE live jira binding, and null when there
 * are none or several (fail closed). An UPDATE, so the `job_binding_mirror_rollout_094` insert trigger never
 * mirrors it into a second `migrated` binding.
 */
export async function projectJiraConnectionInTx(db: Db, orgId: string, rootJobId: string): Promise<void> {
    await db`
        update job set jira_connection_id = (
            select case when count(*) = 1 then (array_agg(b.connection_id))[1] end
            from job_connection_binding b
            join connector_connection c on c.id = b.connection_id and c.org_id = b.org_id and c.status = 'active'
            where b.org_id = ${orgId} and b.root_job_id = ${rootJobId} and b.provider = 'jira'
        )
        where org_id = ${orgId} and id = ${rootJobId}
    `;
}

/**
 * The lock order of every thread writer (BEL-59, BEL-161): batch row -> thread root rows (`for no key update`,
 * ascending ids) -> the PR lock -> the advisory lock of each held root (re-entrant) -> member rows -> grant ->
 * connection -> child inserts. A blocking wait on a thread's advisory lock is only made by a transaction that already
 * holds that root's row, so no transaction waits on an advisory lock held by another order-following one. Two
 * exceptions block only on their FIRST lock: the claim's acquire (its candidate row, then the root row `skip locked`
 * and the advisory lock tried) and a settle of the caller's own running row (then one thread, in order), which the runtime ask is too: its own
 * running row, the root row, then grant and connection. `no key` so
 * the child inserts' FK checks (KEY SHARE on the root) of a claim on another member never wait on it.
 * Returns the ids of `rootIds` that exist as roots, locked in ascending order.
 */
export async function lockRootRowsInTx(db: Db, orgId: string, rootIds: readonly string[]): Promise<string[]> {
    const rows = await db<{ id: string }[]>`
        select id from job
        where org_id = ${orgId} and id = any(${rootIds as string[]}::uuid[]) and root_job_id = id
        order by id for no key update
    `;
    return rows.map((row) => row.id);
}

/** The root row, then the thread's advisory lock (see `lockRootRowsInTx`). Returns false when the root is gone. */
export async function lockThreadRootInTx(db: Db, orgId: string, rootJobId: string): Promise<boolean> {
    if ((await lockRootRowsInTx(db, orgId, [rootJobId])).length !== 1) return false;
    await lockThreadInTx(db, rootJobId);
    return true;
}

/**
 * The per-thread advisory lock, re-entrant within a transaction. Alone it is only for a transaction that already
 * holds the root row, or the ack fallback for a thread whose root is gone.
 */
export async function lockThreadInTx(db: Db, rootJobId: string): Promise<void> {
    await db`select pg_advisory_xact_lock(hashtextextended(${rootJobId}::text, 0))`;
}

/**
 * Persists a create-time resolution for a root job already inserted in `db`: bindings at revision 1 (the root's
 * `binding_revision` follows) and one open requirement per recorded provider.
 */
export async function applyResolutionInTx(
    db: Db,
    args: { orgId: string; rootJobId: string; addedBy: string | null; resolution: Resolution }
): Promise<void> {
    const { orgId, rootJobId, addedBy, resolution } = args;
    if (resolution.bindings.length > 0) {
        await insertBindings(db, { orgId, rootJobId, revision: 1, addedBy, bindings: resolution.bindings });
        await db`update job set binding_revision = 1 where org_id = ${orgId} and id = ${rootJobId}`;
        await projectJiraConnectionInTx(db, orgId, rootJobId);
    }
    for (const r of resolution.requirements) {
        await db`
            insert into job_integration_requirement (org_id, root_job_id, provider, reason)
            values (${orgId}, ${rootJobId}, ${r.provider}, ${r.reason})
            on conflict do nothing
        `;
    }
}

export interface AddBindingsInput {
    orgId: string;
    rootJobId: string;
    /** The revision the caller read; a different current revision answers `stale-revision` and writes nothing. */
    expectedRevision: number;
    connectionIds: string[];
    actor: { userId: string };
    source: 'follow_up' | 'requirement' | 'default';
}

export type AddBindingsResult =
    | { ok: true; revision: number }
    | { ok: false; reason: 'stale-revision' | 'not-authorized' | 'not-execution-user' | 'not-found' | 'duplicate' };

/**
 * Appends bindings to a thread root under its row lock: only the execution user may add, only connections
 * they may bind, each at most once. Earlier bindings are never touched; open requirements for the added
 * providers are satisfied at the new revision.
 */
export async function addBindingsInTx(db: Db, input: AddBindingsInput): Promise<AddBindingsResult> {
    const { orgId, rootJobId, expectedRevision, connectionIds, actor, source } = input;
    // The root row first, then the advisory lock (see `lockThreadRootInTx`); the claim's acquire holds its candidate
    // row and only tries the advisory lock, so it never waits on a bind.
    if (!(await lockThreadRootInTx(db, orgId, rootJobId))) return { ok: false, reason: 'not-found' };
    const [root] = await db<{ execution_user_id: string | null; binding_revision: number }[]>`
        select execution_user_id, binding_revision from job
        where org_id = ${orgId} and id = ${rootJobId} and root_job_id = id
    `;
    if (!root) return { ok: false, reason: 'not-found' };
    if (root.execution_user_id === null || root.execution_user_id !== actor.userId) {
        return { ok: false, reason: 'not-execution-user' };
    }
    if (root.binding_revision !== expectedRevision) return { ok: false, reason: 'stale-revision' };
    if (new Set(connectionIds).size !== connectionIds.length) return { ok: false, reason: 'duplicate' };

    const chosen = await bindableByIds(db, orgId, actor.userId, connectionIds);
    if (chosen.length !== connectionIds.length) return { ok: false, reason: 'not-authorized' };
    const bound = await db<{ connection_id: string }[]>`
        select connection_id from job_connection_binding
        where org_id = ${orgId} and root_job_id = ${rootJobId} and connection_id in ${db(connectionIds)}
    `;
    if (bound.length > 0) {
        // The owner answering a requirement with a connection the thread already holds must not strand the task:
        // the requirement is satisfied by the live binding, at the current revision, nothing new is written.
        if (source === 'requirement' && bound.length === connectionIds.length) {
            await satisfyRequirements(db, {
                orgId,
                rootJobId,
                chosen,
                revision: root.binding_revision,
                actor: actor.userId,
            });
            return { ok: true, revision: root.binding_revision };
        }
        return { ok: false, reason: 'duplicate' };
    }

    const revision = root.binding_revision + 1;
    const byId = new Map(chosen.map((row) => [row.id, row]));
    await insertBindings(db, {
        orgId,
        rootJobId,
        revision,
        addedBy: actor.userId,
        bindings: connectionIds.map((id) => ({ ...toResolved(byId.get(id)!, 'default'), source })),
    });
    await db`update job set binding_revision = ${revision} where org_id = ${orgId} and id = ${rootJobId}`;
    await projectJiraConnectionInTx(db, orgId, rootJobId);
    await satisfyRequirements(db, { orgId, rootJobId, chosen, revision, actor: actor.userId });
    return { ok: true, revision };
}

async function satisfyRequirements(
    db: Db,
    {
        orgId,
        rootJobId,
        chosen,
        revision,
        actor,
    }: { orgId: string; rootJobId: string; chosen: BindableRow[]; revision: number; actor: string }
): Promise<void> {
    const providers = [...new Set(chosen.map((row) => row.provider))];
    await db`
        update job_integration_requirement
        set satisfied_at = now(), satisfied_revision = ${revision}, outcome = 'bound', closed_by = ${actor}
        where org_id = ${orgId} and root_job_id = ${rootJobId} and satisfied_at is null
          and provider in ${db(providers)}
    `;
}

export interface BindingRecord {
    connectionId: string | null;
    provider: string;
    credential: string;
    externalAccountId: string | null;
    resource: string | null;
    /** The connection's site while its row exists; the history keeps the frozen account and resource only. */
    site: string | null;
    revision: number;
    source: BindingSource;
    /** The connection still exists and is active: a deleted or disconnected one stays in the history. */
    live: boolean;
}

export async function bindingsOf(db: Db, orgId: string, rootJobId: string): Promise<BindingRecord[]> {
    const rows = await db<
        {
            connection_id: string | null;
            provider: string;
            credential: string;
            external_account_id: string | null;
            resource: string | null;
            site: string | null;
            revision: number;
            source: BindingSource;
            live: boolean;
        }[]
    >`
        select b.connection_id, b.provider, b.credential, b.external_account_id, b.resource, c.site, b.revision, b.source,
               (c.id is not null and c.status = 'active') as live
        from job_connection_binding b
        left join connector_connection c on c.id = b.connection_id and c.org_id = b.org_id
        where b.org_id = ${orgId} and b.root_job_id = ${rootJobId}
        order by b.revision, b.added_at, b.id
    `;
    return rows.map((r) => ({
        connectionId: r.connection_id,
        provider: r.provider,
        credential: r.credential,
        externalAccountId: r.external_account_id,
        resource: r.resource,
        site: r.site,
        revision: r.revision,
        source: r.source,
        live: r.live,
    }));
}

/** One of a thread root's usable OAuth connections, as the runner's helper is told of it: no credential, no account. */
export interface LiveConnection {
    id: string;
    provider: string;
    site: string;
    resource: string;
    /** What the binding froze at bind time, the ceiling the broker holds the connection to. */
    access: string;
}

/** The root's bindings whose connection still exists, is active and is an OAuth grant's (never a legacy token). */
export async function liveOAuthConnectionsOf(db: Db, orgId: string, rootJobId: string): Promise<LiveConnection[]> {
    const rows = await db<{ id: string; provider: string; site: string; resource: string; access: string }[]>`
        select c.id, b.provider, c.site, b.resource, coalesce(b.access, c.access) as access
        from job_connection_binding b
        join connector_connection c on c.id = b.connection_id and c.org_id = b.org_id
        where b.org_id = ${orgId} and b.root_job_id = ${rootJobId}
          and c.status = 'active' and c.credential = 'oauth_grant' and b.resource is not null
        order by b.revision, b.added_at, b.id
    `;
    return rows;
}

export interface RequirementRecord {
    provider: string;
    /** What a person calls the provider (`INTEGRATION_PROVIDERS`). */
    label: string;
    reason: 'missing' | 'ambiguous' | 'reconnect';
    /** `create`: the task never started and waits to; `runtime`: it ran, asked, and was handed back. */
    source: 'create' | 'runtime';
    /** The bound connection a `reconnect` requirement is about; null for every other reason. */
    connectionId: string | null;
    createdAt: string;
}

/** What a person calls `provider`; an unknown one is its own name. */
export const providerLabel = (provider: string): string =>
    Object.hasOwn(INTEGRATION_PROVIDERS, provider)
        ? INTEGRATION_PROVIDERS[provider as keyof typeof INTEGRATION_PROVIDERS].label
        : provider;

/** The root's open (unsatisfied) requirements. */
export async function requirementsOf(db: Db, orgId: string, rootJobId: string): Promise<RequirementRecord[]> {
    const rows = await db<
        {
            provider: string;
            reason: RequirementRecord['reason'];
            source: RequirementRecord['source'];
            connection_id: string | null;
            created_at: Date;
        }[]
    >`
        select r.provider, r.reason, r.source, r.created_at,
               case when r.reason = 'reconnect' then (
                   select b.connection_id from job_connection_binding b
                   where b.org_id = r.org_id and b.root_job_id = r.root_job_id and b.provider = r.provider
                   order by b.revision desc, b.added_at desc, b.id desc limit 1
               ) end as connection_id
        from job_integration_requirement r
        where r.org_id = ${orgId} and r.root_job_id = ${rootJobId} and r.satisfied_at is null
        order by r.created_at, r.id
    `;
    return rows.map((r) => ({
        provider: r.provider,
        label: providerLabel(r.provider),
        reason: r.reason,
        source: r.source,
        connectionId: r.connection_id,
        createdAt: r.created_at.toISOString(),
    }));
}

/**
 * The required providers (of `required`) the root has no live binding for. A read that throws propagates:
 * only a confirmed answer inside the caller's locked transaction licenses recording a requirement.
 */
export async function unboundProvidersInTx(
    db: Db,
    args: { orgId: string; rootJobId: string; required: readonly string[] }
): Promise<string[]> {
    if (args.required.length === 0) return [];
    const live = new Set(
        (await bindingsOf(db, args.orgId, args.rootJobId)).filter((b) => b.live).map((b) => b.provider)
    );
    return args.required.filter((provider) => !live.has(provider));
}

/** Records an open `missing` requirement per provider; one already open stays as it is. */
export async function recordMissingInTx(
    db: Db,
    args: { orgId: string; rootJobId: string; providers: readonly string[] }
): Promise<void> {
    for (const provider of args.providers) {
        await db`
            insert into job_integration_requirement (org_id, root_job_id, provider, reason)
            values (${args.orgId}, ${args.rootJobId}, ${provider}, 'missing')
            on conflict do nothing
        `;
    }
}

export type RuntimeAnswer = 'bound' | 'unavailable' | 'waiting';

/**
 * A running task asks for a provider (BEL-174), in the caller's transaction, which already holds the asking
 * row. Answers `bound` when the thread has a binding the broker would serve, or after binding the execution user's
 * lone usable candidate; `unavailable` when nobody can bind (no execution user, a provider the board never binds) or
 * the owner dismissed the requirement at this binding revision; otherwise opens (or refreshes) the runtime
 * requirement and answers `waiting`: `reconnect` for a binding that no longer serves, else `missing` or `ambiguous`.
 * A read that throws propagates: only a confirmed answer licenses recording a requirement.
 */
export async function requireAtRuntimeInTx(
    db: Db,
    args: { orgId: string; rootJobId: string; askedJobId: string; claimSeq: number; provider: string }
): Promise<RuntimeAnswer> {
    const { orgId, rootJobId, askedJobId, claimSeq, provider } = args;
    if (!BINDABLE_PROVIDERS.includes(provider)) return 'unavailable';
    if (!(await lockThreadRootInTx(db, orgId, rootJobId))) return 'unavailable';
    const [root] = await db<{ execution_user_id: string | null; binding_revision: number }[]>`
        select execution_user_id, binding_revision from job where org_id = ${orgId} and id = ${rootJobId}
    `;
    const held = await db<StandingRow[]>`
        select b.grant_id as b_grant_id, c.status as c_status, c.credential as c_credential,
               c.grant_id as c_grant_id, g.id as g_id, g.status as g_status
        from job_connection_binding b
        left join connector_connection c on c.id = b.connection_id and c.org_id = b.org_id
        left join integration_grant g on g.id = c.grant_id and g.org_id = c.org_id
        where b.org_id = ${orgId} and b.root_job_id = ${rootJobId} and b.provider = ${provider}
    `;
    const standings = held.map(bindingStanding);
    if (standings.includes('usable')) return 'bound';
    const executionUser = root?.execution_user_id ?? null;
    if (!root || executionUser === null) return 'unavailable';
    if ((await dismissedProvidersInTx(db, orgId, rootJobId)).includes(provider)) return 'unavailable';

    let reason: RecordedReason = 'reconnect';
    if (!standings.includes('reconnect')) {
        const candidates = await defaultCandidates(db, orgId, provider, executionUser);
        if (candidates.length === 1) {
            const added = await addBindingsInTx(db, {
                orgId,
                rootJobId,
                expectedRevision: root.binding_revision,
                connectionIds: [candidates[0]!.id],
                actor: { userId: executionUser },
                source: 'default',
            });
            if (!added.ok) throw new Error(`binding the lone ${provider} candidate was refused: ${added.reason}`);
            return 'bound';
        }
        reason = candidates.length === 0 ? 'missing' : 'ambiguous';
    }
    await db`
        insert into job_integration_requirement
            (org_id, root_job_id, provider, reason, source, asked_job_id, asked_claim_seq)
        values (${orgId}, ${rootJobId}, ${provider}, ${reason}, 'runtime', ${askedJobId}, ${claimSeq})
        on conflict (org_id, root_job_id, provider) where satisfied_at is null
        do update set reason = excluded.reason, source = 'runtime', asked_job_id = excluded.asked_job_id,
                      asked_claim_seq = excluded.asked_claim_seq
    `;
    return 'waiting';
}

type RecordedReason = RequirementRecord['reason'];

/** The providers whose requirement the owner dismissed at the root's CURRENT binding revision (sticky until it moves). */
export async function dismissedProvidersInTx(db: Db, orgId: string, rootJobId: string): Promise<string[]> {
    const rows = await db<{ provider: string }[]>`
        select distinct r.provider
        from job_integration_requirement r
        join job root on root.org_id = r.org_id and root.id = r.root_job_id
        where r.org_id = ${orgId} and r.root_job_id = ${rootJobId} and r.outcome = 'dismissed'
          and r.satisfied_revision = root.binding_revision
    `;
    return rows.map((r) => r.provider);
}

/**
 * The owner declines a provider for the thread: closes its open requirement as `dismissed` at the current revision.
 * `missing` when the root is gone or the caller is not its execution user, `none-open` when nothing is open.
 */
export async function dismissRequirementInTx(
    db: Db,
    args: { orgId: string; rootJobId: string; provider: string; userId: string }
): Promise<'ok' | 'missing' | 'none-open'> {
    const { orgId, rootJobId, provider, userId } = args;
    if (!(await lockThreadRootInTx(db, orgId, rootJobId))) return 'missing';
    const [root] = await db<{ execution_user_id: string | null; binding_revision: number }[]>`
        select execution_user_id, binding_revision from job where org_id = ${orgId} and id = ${rootJobId}
    `;
    if (!root || root.execution_user_id === null || root.execution_user_id !== userId) return 'missing';
    const closed = await db<{ id: string }[]>`
        update job_integration_requirement
        set satisfied_at = now(), satisfied_revision = ${root.binding_revision}, outcome = 'dismissed',
            closed_by = ${userId}
        where org_id = ${orgId} and root_job_id = ${rootJobId} and provider = ${provider} and satisfied_at is null
        returning id
    `;
    return closed.length === 0 ? 'none-open' : 'ok';
}

export interface ConnectionOutcome {
    provider: string;
    label: string;
    outcome: 'bound' | 'dismissed';
}

/**
 * What became of the requirements this job asked for while it ran, told to the claim that continues it (BEL-174).
 * Each is stamped with the claim it was told to; a TAKEOVER of that claim is told again (its session never saw
 * the answer), an ordinary re-claim is not (the resumed session already did).
 */
export async function takeConnectionOutcomesInTx(
    db: Db,
    args: { orgId: string; jobId: string; claimSeq: number; takeover: boolean }
): Promise<ConnectionOutcome[]> {
    const { orgId, jobId, claimSeq, takeover } = args;
    const rows = await db<{ provider: string; outcome: ConnectionOutcome['outcome'] }[]>`
        update job_integration_requirement
        set delivered_claim_seq = ${claimSeq}
        where org_id = ${orgId} and source = 'runtime' and asked_job_id = ${jobId} and outcome is not null
          and (delivered_claim_seq is null or (${takeover}::boolean and delivered_claim_seq = ${claimSeq - 1}))
        returning provider, outcome
    `;
    return rows
        .sort((a, b) => a.provider.localeCompare(b.provider))
        .map((r) => ({ provider: r.provider, label: providerLabel(r.provider), outcome: r.outcome }));
}

/** Whether an open runtime requirement on the root was asked by `jobId`: the asker, or its takeover, must stop. */
export async function requirementWaitOf(db: Db, orgId: string, jobId: string): Promise<boolean> {
    const rows = await db<{ one: number }[]>`
        select 1 as one from job_integration_requirement
        where org_id = ${orgId} and source = 'runtime' and asked_job_id = ${jobId} and satisfied_at is null
        limit 1
    `;
    return rows.length > 0;
}
