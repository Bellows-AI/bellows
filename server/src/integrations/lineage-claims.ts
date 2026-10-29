import { randomUUID } from 'node:crypto';
import type { LineageKind } from '../db/connection-grants.js';
import type { ClaimRefusal, ClaimResult, LineageClaim, LineageCtx } from './lineage-types.js';

/**
 * The claim statements. Each is ONE update (or read) on the grant row with no other lock and no transaction held
 * after it returns, which is what keeps the BEL-59 lock order intact: nothing here is ever held while waiting.
 */

interface ClaimRow {
    provider: string;
    principal_user_id: string;
    version: string;
    secret_ref: string | null;
    secret_version: string | null;
    authority: Record<string, unknown>;
    wedged: boolean;
}

export interface LineageRow {
    id: string;
    provider: string;
    principal_user_id: string;
    status: string;
    version: string;
    secret_ref: string | null;
    secret_version: string | null;
    authority: Record<string, unknown>;
    secret_wedged_at: Date | null;
    lineage_claim: string | null;
    lineage_claim_kind: LineageKind | null;
    lineage_operation_id: string | null;
    lineage_secret_ref: string | null;
    expired: boolean | null;
}

const ALLOWED_STATUS: Record<LineageKind, string[]> = {
    refresh: ['active'],
    reconsent: ['active', 'reconnect_required'],
    destroy: ['revoked'],
};

export async function readLineage(ctx: LineageCtx, grantId: string): Promise<LineageRow | null> {
    const rows = await ctx.sql<LineageRow[]>`
        select id, provider, principal_user_id, status, version, secret_ref, secret_version, authority,
               secret_wedged_at, lineage_claim, lineage_claim_kind, lineage_operation_id, lineage_secret_ref,
               (lineage_claim_expires_at < now()) as expired
        from integration_grant where id = ${grantId} and org_id = ${ctx.orgId}
    `;
    return rows[0] ?? null;
}

/**
 * Takes the claim. It applies only when no live claim stands and no operation is recorded: a recorded operation is
 * recovery's. An expired claim with no operation is taken over, except a rotating refresh, whose holder may have
 * spent the token (`abandoned`). A wedged grant refuses refresh and destroy; only a reconsent may leave the wedge.
 */
export async function claimLineage(
    ctx: LineageCtx,
    grantId: string,
    kind: LineageKind,
    rotates: boolean
): Promise<ClaimResult> {
    const { sql, orgId, leaseMs } = ctx;
    const token = randomUUID();
    const startedAt = Date.now();
    const reconsent = kind === 'reconsent';
    const refresh = kind === 'refresh';
    const destroy = kind === 'destroy';
    const rows = await sql<ClaimRow[]>`
        update integration_grant
        set lineage_claim = ${token}, lineage_claim_kind = ${kind},
            lineage_claim_expires_at = now() + (${leaseMs}::double precision * interval '1 millisecond'),
            updated_at = now()
        where id = ${grantId} and org_id = ${orgId} and status in ${sql(ALLOWED_STATUS[kind])}
          and (lineage_operation_id is null or (${reconsent}::boolean and secret_wedged_at is not null))
          and (${reconsent}::boolean or secret_wedged_at is null)
          and (not ${refresh}::boolean or (secret_ref is not null and secret_version is not null))
          and (not ${destroy}::boolean or secret_version is not null)
          and (lineage_claim is null
               or (lineage_claim_expires_at < now() and lineage_operation_id is null
                   and not (${rotates}::boolean and lineage_claim_kind = 'refresh')))
        returning provider, principal_user_id, version, secret_ref, secret_version, authority,
                  (secret_wedged_at is not null) as wedged
    `;
    const row = rows[0];
    if (!row) return { ok: false, reason: await classifyRefusal(ctx, grantId, kind, rotates) };
    const claim: LineageClaim = {
        token,
        kind,
        grantId,
        orgId,
        principalUserId: row.principal_user_id,
        provider: row.provider,
        version: Number(row.version),
        secretRef: row.secret_ref,
        secretVersion: row.secret_version,
        authority: row.authority,
        wedged: row.wedged,
        deadlineAt: startedAt + leaseMs,
    };
    return { ok: true, claim };
}

function statusRefusal(row: LineageRow, kind: LineageKind): ClaimRefusal | null {
    if (kind === 'destroy') {
        if (row.status !== 'revoked') return 'not-revoked';
        if (row.secret_version === null) return 'nothing-to-destroy';
        return row.secret_wedged_at === null ? null : 'wedged';
    }
    if (row.status === 'revoked') return 'revoked';
    if (kind !== 'refresh') return null;
    if (row.status === 'reconnect_required') return 'reconnect_required';
    if (row.secret_wedged_at !== null) return 'wedged';
    return row.secret_ref === null || row.secret_version === null ? 'no-secret' : null;
}

function standingClaimRefusal(row: LineageRow, rotates: boolean): ClaimRefusal {
    if (row.lineage_claim === null) return row.secret_wedged_at === null ? 'held' : 'wedged';
    if (row.expired !== true) return 'held';
    if (row.lineage_operation_id !== null) return 'recovery-needed';
    return rotates && row.lineage_claim_kind === 'refresh' ? 'abandoned' : 'held';
}

/** Zero rows is not an answer by itself: a re-read says why, and a thrown read propagates. */
async function classifyRefusal(
    ctx: LineageCtx,
    grantId: string,
    kind: LineageKind,
    rotates: boolean
): Promise<ClaimRefusal> {
    const row = await readLineage(ctx, grantId);
    if (!row) return 'not-found';
    return statusRefusal(row, kind) ?? standingClaimRefusal(row, rotates);
}

export interface EndClaimOptions {
    /** The grant needs the person again (unless it was revoked meanwhile). */
    reconnect?: boolean;
    /** Forget a recorded operation too. */
    operation?: boolean;
    /** The reference's operation was lost: it is wedged. */
    wedged?: boolean;
}

/** Ends a claim by clearing every `lineage_*` column but, unless asked, the recorded operation. */
export async function endClaim(
    ctx: LineageCtx,
    claim: { token: string; grantId: string },
    options: EndClaimOptions = {}
): Promise<boolean> {
    const reconnect = options.reconnect === true;
    const operation = options.operation === true;
    const wedged = options.wedged === true;
    const rows = await ctx.sql<{ id: string }[]>`
        update integration_grant
        set lineage_claim = null, lineage_claim_kind = null, lineage_claim_expires_at = null,
            lineage_secret_ref = null,
            lineage_operation_id = case when ${operation}::boolean then null else lineage_operation_id end,
            status = case when ${reconnect}::boolean and status <> 'revoked' then 'reconnect_required' else status end,
            secret_wedged_at = case when ${wedged}::boolean then now() else secret_wedged_at end,
            updated_at = now()
        where id = ${claim.grantId} and org_id = ${ctx.orgId} and lineage_claim = ${claim.token}
        returning id
    `;
    return rows.length > 0;
}

/**
 * Step 4: records the operation the claim is about to run and the reference it targets, so recovery can tell
 * "never reached the store" from "payload lost". A destroy runs on a revoked grant; everything else must not.
 */
export async function recordOperation(
    ctx: LineageCtx,
    claim: LineageClaim,
    operationId: string,
    ref: string
): Promise<boolean> {
    const rows = await ctx.sql<{ id: string }[]>`
        update integration_grant
        set lineage_operation_id = ${operationId}, lineage_secret_ref = ${ref}, updated_at = now()
        where id = ${claim.grantId} and org_id = ${ctx.orgId} and lineage_claim = ${claim.token}
          and (status <> 'revoked' or lineage_claim_kind = 'destroy')
        returning id
    `;
    return rows.length > 0;
}

/** The holder of a rotating refresh died mid-exchange: the token may be spent, so it is never replayed. */
export async function abandonExpiredRefresh(ctx: LineageCtx, grantId: string): Promise<void> {
    await ctx.sql`
        update integration_grant
        set status = case when status <> 'revoked' then 'reconnect_required' else status end,
            lineage_claim = null, lineage_claim_kind = null, lineage_claim_expires_at = null,
            lineage_secret_ref = null, updated_at = now()
        where id = ${grantId} and org_id = ${ctx.orgId} and lineage_claim_kind = 'refresh'
          and lineage_claim is not null and lineage_claim_expires_at < now() and lineage_operation_id is null
    `;
}
