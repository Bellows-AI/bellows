/**
 * The writes that bind a task's connections (BEL-59), each inside the caller's transaction: at create, on a
 * follow-up, through the owner's bind route, and the claim's check that a required integration is still bound.
 * The stores they call are `connection-bindings.ts`; this file is only where the job store's rows meet them.
 */

import type { Sql, TransactionSql } from 'postgres';
import { requiredProviders } from '@factory-ai/core';
import { skillCatalog } from '../../skills.js';
import {
    addBindingsInTx,
    applyResolutionInTx,
    BINDABLE_PROVIDERS,
    ConnectionRefusedError,
    dismissedProvidersInTx,
    dismissRequirementInTx,
    lockThreadInTx,
    recordMissingInTx,
    requireAtRuntimeInTx,
    resolveBindingsInTx,
    type ConnectionOutcome,
    type RuntimeAnswer,
    takeConnectionOutcomesInTx,
    unboundProvidersInTx,
} from '../connection-bindings.js';

export type BindConnectionResult =
    | { ok: true; revision: number }
    | { ok: false; reason: 'missing' | 'stale-revision' | 'not-authorized' | 'duplicate' };

/**
 * The create's connections (BEL-59), in the create transaction: a refusal or a failed read rolls the row
 * back, so a task and its requirements commit together. A task with no author cannot bind or default:
 * naming a connection is refused and a required provider stays a requirement.
 */
export async function bindOnCreate(
    tx: TransactionSql,
    {
        orgId,
        rootJobId,
        createdBy,
        target,
    }: {
        orgId: string;
        rootJobId: string;
        createdBy: string | null;
        target: { skills?: readonly string[]; connectionIds?: readonly string[] };
    }
): Promise<void> {
    const required = requiredProviders(skillCatalog(), target.skills ?? []);
    const explicit = [...(target.connectionIds ?? [])];
    if (createdBy === null) {
        if (explicit.length > 0) throw new ConnectionRefusedError('not-authorized');
        await recordMissingInTx(tx, { orgId, rootJobId, providers: required });
        return;
    }
    const resolution = await resolveBindingsInTx(tx, {
        orgId,
        executionUser: createdBy,
        explicit,
        providers: [...BINDABLE_PROVIDERS],
        required,
    });
    if (!resolution.ok) {
        throw new ConnectionRefusedError(resolution.reason === 'duplicate' ? 'duplicate' : 'not-authorized');
    }
    await applyResolutionInTx(tx, { orgId, rootJobId, addedBy: createdBy, resolution });
}

/**
 * A follow-up's `connections` (BEL-59), appended to the thread root's bindings in the follow-up's transaction.
 * The revision is read here, after the advisory lock and the insert, never taken from the request: the
 * follow-up names what to add, not which bindings it saw. A refusal rolls the follow-up row back.
 */
export async function addFollowUpBindings(
    tx: TransactionSql,
    args: { orgId: string; rootJobId: string; createdBy: string | null; connectionIds: readonly string[] }
): Promise<void> {
    const { orgId, rootJobId, createdBy, connectionIds } = args;
    if (connectionIds.length === 0) return;
    if (createdBy === null) throw new ConnectionRefusedError('not-authorized');
    const [root] = await tx<{ binding_revision: number }[]>`
        select binding_revision from job where org_id = ${orgId} and id = ${rootJobId}
    `;
    const added = await addBindingsInTx(tx, {
        orgId,
        rootJobId,
        expectedRevision: root!.binding_revision,
        connectionIds: [...connectionIds],
        actor: { userId: createdBy },
        source: 'follow_up',
    });
    if (!added.ok) throw new ConnectionRefusedError(added.reason === 'duplicate' ? 'duplicate' : 'not-authorized');
}

/** bindConnection's body: one owner answer to a requirement, CAS on the root's `binding_revision`. */
export async function bindConnectionRow(
    sql: Sql,
    args: { orgId: string; id: string; connectionId: string; bindingRevision: number; userId: string }
): Promise<BindConnectionResult> {
    const { orgId, id, connectionId, bindingRevision, userId } = args;
    return sql.begin(async (tx) => {
        const [job] = await tx<
            { root_job_id: string }[]
        >`select root_job_id from job where org_id = ${orgId} and id = ${id}`;
        if (!job) return { ok: false, reason: 'missing' };
        const added = await addBindingsInTx(tx, {
            orgId,
            rootJobId: job.root_job_id,
            expectedRevision: bindingRevision,
            connectionIds: [connectionId],
            actor: { userId },
            source: 'requirement',
        });
        if (added.ok) return added;
        return {
            ok: false,
            reason: added.reason === 'not-found' || added.reason === 'not-execution-user' ? 'missing' : added.reason,
        };
    });
}

/**
 * The OAuth return binds the new connection to the task it was started from. The revision is read here,
 * under the thread lock, never carried through the browser: the person named the connection, not a revision. Answers
 * what the owner's own bind would: refusals are values.
 */
export async function bindAuthorizedConnectionRow(
    sql: Sql,
    args: { orgId: string; jobId: string; connectionId: string; userId: string }
): Promise<BindConnectionResult> {
    const { orgId, jobId, connectionId, userId } = args;
    return sql.begin(async (tx) => {
        const [job] = await tx<
            { root_job_id: string }[]
        >`select root_job_id from job where org_id = ${orgId} and id = ${jobId}`;
        if (!job) return { ok: false, reason: 'missing' };
        const [root] = await tx<
            { binding_revision: number }[]
        >`select binding_revision from job where org_id = ${orgId} and id = ${job.root_job_id}`;
        const added = await addBindingsInTx(tx, {
            orgId,
            rootJobId: job.root_job_id,
            expectedRevision: root!.binding_revision,
            connectionIds: [connectionId],
            actor: { userId },
            source: 'requirement',
        });
        if (added.ok) return added;
        return {
            ok: false,
            reason: added.reason === 'not-found' || added.reason === 'not-execution-user' ? 'missing' : added.reason,
        };
    });
}

/**
 * An authorization made several usable connections for a task's open requirement: none is picked for the person, so
 * the requirement asks them to choose (`ambiguous`). Only the execution user's own `missing` requirement changes.
 */
export async function markRequirementAmbiguousRow(
    sql: Sql,
    args: { orgId: string; jobId: string; provider: string; userId: string }
): Promise<void> {
    const { orgId, jobId, provider, userId } = args;
    await sql`
        update job_integration_requirement r set reason = 'ambiguous'
        from job j join job root on root.org_id = j.org_id and root.id = j.root_job_id
        where j.org_id = ${orgId} and j.id = ${jobId} and root.execution_user_id = ${userId}
          and r.org_id = j.org_id and r.root_job_id = root.id and r.provider = ${provider}
          and r.satisfied_at is null and r.reason = 'missing'
    `;
}

/**
 * True when the root's selected skills require a provider with no live binding (and none dismissed), after
 * recording a `missing` requirement for each. The skills are the root's (a follow-up or retry reads them there). A read that
 * throws propagates and rolls the claim back; only a confirmed empty answer records anything.
 */
export async function recordUnboundRequirements(
    tx: TransactionSql,
    orgId: string,
    rootJobId: string
): Promise<boolean> {
    // Under the thread lock the bind route also takes: the unbound read and the requirement write are one step.
    // The acquire holds its candidate row already (and, for a member, the root row via `skip locked`, BEL-161): it
    // never waits for the root row here, and the requirement insert needs only KEY SHARE on it.
    await lockThreadInTx(tx, rootJobId);
    const [root] = await tx<
        { skills: string[] }[]
    >`select skills from job where org_id = ${orgId} and id = ${rootJobId}`;
    // A provider the owner dismissed at this binding revision is absent by choice: the task launches without it.
    const dismissed = await dismissedProvidersInTx(tx, orgId, rootJobId);
    const required = requiredProviders(skillCatalog(), root?.skills ?? []).filter((p) => !dismissed.includes(p));
    const unbound = await unboundProvidersInTx(tx, { orgId, rootJobId, required });
    if (unbound.length === 0) return false;
    await recordMissingInTx(tx, { orgId, rootJobId, providers: unbound });
    return true;
}

export type RequireConnectionResult = { result: 'ok'; answer: RuntimeAnswer } | { result: 'lost' | 'missing' };

/**
 * requireConnection's body: the running attempt asks for a provider. Lock order: the asker's own running
 * row (a settle of the caller's own row), then the thread root and its advisory lock, then grant and connection
 * (`lockRootRowsInTx`). A row not running under that lease is `lost`, an unknown one `missing`.
 */
export async function requireConnectionRow(
    sql: Sql,
    args: { orgId: string; id: string; leaseToken: string; provider: string }
): Promise<RequireConnectionResult> {
    const { orgId, id, leaseToken, provider } = args;
    return sql.begin(async (tx) => {
        const [held] = await tx<{ root_job_id: string; claim_seq: string }[]>`
            select root_job_id, claim_seq from job
            where org_id = ${orgId} and id = ${id} and status = 'running' and lease_token = ${leaseToken}
            for update
        `;
        if (!held) {
            const [known] = await tx<{ id: string }[]>`select id from job where org_id = ${orgId} and id = ${id}`;
            return { result: known ? 'lost' : 'missing' } as const;
        }
        const answer = await requireAtRuntimeInTx(tx, {
            orgId,
            rootJobId: held.root_job_id,
            askedJobId: id,
            claimSeq: Number(held.claim_seq),
            provider,
        });
        return { result: 'ok', answer } as const;
    });
}

export type DismissRequirementResult = { ok: true } | { ok: false; reason: 'missing' | 'none-open' };

/** dismissRequirement's body: the owner declines a provider for the thread `id` belongs to. */
export async function dismissRequirementRow(
    sql: Sql,
    args: { orgId: string; id: string; provider: string; userId: string }
): Promise<DismissRequirementResult> {
    const { orgId, id, provider, userId } = args;
    return sql.begin(async (tx) => {
        const [job] = await tx<
            { root_job_id: string }[]
        >`select root_job_id from job where org_id = ${orgId} and id = ${id}`;
        if (!job) return { ok: false, reason: 'missing' } as const;
        const closed = await dismissRequirementInTx(tx, { orgId, rootJobId: job.root_job_id, provider, userId });
        return closed === 'ok' ? ({ ok: true } as const) : ({ ok: false, reason: closed } as const);
    });
}

export interface ClaimConnections {
    /** Providers the owner dismissed at the root's current revision: absent by choice, the skill check passes. */
    dismissed: string[];
    /** What the requirements this job asked for came to, to tell the continuing claim. */
    outcomes: ConnectionOutcome[];
}

/**
 * What the claim's transaction reads of the thread's connection choices, for the claimed `job` (its
 * `claim_seq` is the post-update one): the dismissed providers and the outcomes to tell. A read that throws
 * rolls the claim back.
 */
export async function claimConnectionsInTx(
    tx: TransactionSql,
    { orgId, rootJobId }: { orgId: string; rootJobId: string },
    job: { id: string; claim_seq: string },
    takeover: boolean
): Promise<ClaimConnections> {
    const claimSeq = Number(job.claim_seq);
    // An ordinary re-claim of an answered requirement means the run was released some other way: nothing is owed.
    if (!takeover) {
        await tx`
            update job_integration_requirement set hand_back_pending = false
            where org_id = ${orgId} and source = 'runtime' and asked_job_id = ${job.id} and hand_back_pending
              and satisfied_at is not null
        `;
    }
    return {
        dismissed: await dismissedProvidersInTx(tx, orgId, rootJobId),
        outcomes: await takeConnectionOutcomesInTx(tx, { orgId, jobId: job.id, claimSeq, takeover }),
    };
}
