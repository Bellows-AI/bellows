import type { Sql, TransactionSql } from 'postgres';
import { INTEGRATION_PROVIDERS, selectedBy } from '@factory-ai/core';

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
 * commit (and recomputes the projection with it) or is seen by it first: active, theirs, or a legacy org one (explicit only), and for an
 * OAuth connection an active grant. Anything else (another member's, another org's, disconnected) is absent.
 */
async function bindableByIds(db: Db, orgId: string, userId: string, ids: string[]): Promise<BindableRow[]> {
    if (ids.length === 0) return [];
    return db<BindableRow[]>`
        select c.id, c.provider, c.credential, c.external_account_id, c.cloud_id, c.grant_id, g.authority, c.access,
               c.principal_user_id
        from connector_connection c
        left join integration_grant g on g.id = c.grant_id
        where c.org_id = ${orgId} and c.id in ${db(ids)} and c.status = 'active'
          and (c.principal_user_id = ${userId} or (c.principal_user_id is null and c.credential = 'legacy_api_token'))
          and (c.grant_id is null or g.status = 'active')
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
        const candidates = await db<BindableRow[]>`
            select c.id, c.provider, c.credential, c.external_account_id, c.cloud_id, c.grant_id, g.authority, c.access,
                   c.principal_user_id
            from connector_connection c
            left join integration_grant g on g.id = c.grant_id
            where c.org_id = ${orgId} and c.provider = ${provider} and c.status = 'active'
              and c.principal_user_id = ${executionUser} and (c.grant_id is null or g.status = 'active')
            order by c.created_at desc, c.id
            limit 2
            for share of c
        `;
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

/** The per-thread advisory lock the claim, follow-up, remove and done take; re-entrant within a transaction. */
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
    source: 'follow_up' | 'requirement';
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
    // The thread's advisory lock first (the claim's acquire holds it while it reads bindings and records
    // requirements), then the row lock: a bind and an acquire on one thread never interleave.
    await lockThreadInTx(db, rootJobId);
    const [root] = await db<{ execution_user_id: string | null; binding_revision: number }[]>`
        select execution_user_id, binding_revision from job
        where org_id = ${orgId} and id = ${rootJobId} and root_job_id = id
        for update
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
            await satisfyRequirements(db, { orgId, rootJobId, chosen, revision: root.binding_revision });
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
    await satisfyRequirements(db, { orgId, rootJobId, chosen, revision });
    return { ok: true, revision };
}

async function satisfyRequirements(
    db: Db,
    {
        orgId,
        rootJobId,
        chosen,
        revision,
    }: { orgId: string; rootJobId: string; chosen: BindableRow[]; revision: number }
): Promise<void> {
    const providers = [...new Set(chosen.map((row) => row.provider))];
    await db`
        update job_integration_requirement set satisfied_at = now(), satisfied_revision = ${revision}
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

export interface RequirementRecord {
    provider: string;
    reason: 'missing' | 'ambiguous';
    createdAt: string;
}

/** The root's open (unsatisfied) requirements. */
export async function requirementsOf(db: Db, orgId: string, rootJobId: string): Promise<RequirementRecord[]> {
    const rows = await db<{ provider: string; reason: 'missing' | 'ambiguous'; created_at: Date }[]>`
        select provider, reason, created_at from job_integration_requirement
        where org_id = ${orgId} and root_job_id = ${rootJobId} and satisfied_at is null
        order by created_at, id
    `;
    return rows.map((r) => ({ provider: r.provider, reason: r.reason, createdAt: r.created_at.toISOString() }));
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
