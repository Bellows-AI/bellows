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
    recordMissingInTx,
    resolveBindingsInTx,
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
 * True when the root's selected skills require a provider with no live binding, after recording a `missing`
 * requirement for each. The skills are the root's (a follow-up or retry reads them there). A read that
 * throws propagates and rolls the claim back; only a confirmed empty answer records anything.
 */
export async function recordUnboundRequirements(
    tx: TransactionSql,
    orgId: string,
    rootJobId: string
): Promise<boolean> {
    const [root] = await tx<
        { skills: string[] }[]
    >`select skills from job where org_id = ${orgId} and id = ${rootJobId}`;
    const required = requiredProviders(skillCatalog(), root?.skills ?? []);
    const unbound = await unboundProvidersInTx(tx, { orgId, rootJobId, required });
    if (unbound.length === 0) return false;
    await recordMissingInTx(tx, { orgId, rootJobId, providers: unbound });
    return true;
}
