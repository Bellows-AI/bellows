import type { Sql } from 'postgres';

/**
 * The agent's own title write (`125_job_title.sql`, docs/connections.md). The title lives on the thread
 * ROOT; the caller is a running attempt of any row of the thread. ONE transaction takes the caller's own running
 * row (`for update`) and then the root (`for no key update`) — the lock order of a settle of the caller's own row
 * and of the runtime ask (`connection-bindings.ts` `lockRootRowsInTx`) — and re-checks the lease and the root
 * UNDER those locks, so a takeover that rotates the lease either waits for this write or makes it see the
 * rotation: a superseded attempt never writes. A throw is the caller's to answer as unavailable, never as a
 * refusal or as "unchanged".
 */

/** F6: at most this many distinct agent changes per attempt (`claim_seq`). */
export const AGENT_TITLE_CAP = 5;

export interface AgentTitleInput {
    orgId: string;
    jobId: string;
    rootJobId: string;
    leaseToken: string;
    /** Already normalized by the route. */
    title: string;
}

export type AgentTitleResult =
    | { ok: true; title: string; updated: boolean; version: number; reason?: 'user_title' }
    /** `pending`: the pair is one takeover behind or lapsed on a task that still runs; `refused`: terminal. */
    | { ok: false; refusal: 'pending' | 'refused' | 'limit' };

export type AgentTitle = (input: AgentTitleInput) => Promise<AgentTitleResult>;

interface OwnRow {
    claim_seq: string | number;
    current: unknown;
    prior: unknown;
    live: unknown;
    standing: unknown;
}

interface RootRow {
    title: string | null;
    title_origin: string | null;
    title_revision: number;
}

/** A flag the query must have answered true or false: anything else is an unconfirmed read. */
function flag(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new Error('agent title check answered a non-boolean flag');
    return value;
}

/** The own row's verdict under its lock: null when the pair stands, else why not. */
function ownRefusal(own: OwnRow): 'pending' | 'refused' | null {
    const standing = flag(own.standing);
    if (flag(own.current) && flag(own.live) && standing) return null;
    // A rotated pair, or the current one lapsed, on a task that still runs is a takeover window.
    return standing && (flag(own.prior) || flag(own.current)) ? 'pending' : 'refused';
}

/** What the root's title says about the proposal, before the cap: an answer to give, or null to write. */
function rootAnswer(root: RootRow, title: string): AgentTitleResult | null {
    const version = root.title_revision;
    if (root.title_origin === 'user' && root.title !== null) {
        return { ok: true, title: root.title, updated: false, reason: 'user_title', version };
    }
    return root.title === title ? { ok: true, title, updated: false, version } : null;
}

export function createAgentTitle({ sql, ready }: { sql: Sql; ready?: Promise<unknown> | undefined }): AgentTitle {
    return async ({ orgId, jobId, rootJobId, leaseToken, title }) => {
        if (ready) await ready;
        return sql.begin(async (tx): Promise<AgentTitleResult> => {
            const [own] = await tx<OwnRow[]>`
                select claim_seq,
                       coalesce(lease_token = ${leaseToken}, false) as current,
                       coalesce(prior_lease_token = ${leaseToken}, false) as prior,
                       coalesce(lease_expires_at > now(), false) as live,
                       (coalesce(status = 'running', false) and finished_at is null
                        and cancel_requested_at is null and review_of is null) as standing
                from job where org_id = ${orgId} and id = ${jobId} and root_job_id = ${rootJobId}
                for update
            `;
            if (!own) return { ok: false, refusal: 'refused' };
            const refusal = ownRefusal(own);
            if (refusal) return { ok: false, refusal };
            const [root] = await tx<RootRow[]>`
                select title, title_origin, title_revision from job
                where org_id = ${orgId} and id = ${rootJobId} and root_job_id = id
                for no key update
            `;
            if (!root) return { ok: false, refusal: 'refused' };
            const answered = rootAnswer(root, title);
            if (answered) return answered;
            const claimSeq = Number(own.claim_seq);
            const [spent] = await tx<{ n: string }[]>`
                select count(*) as n from job_title_event
                where org_id = ${orgId} and root_job_id = ${rootJobId} and origin = 'agent'
                  and job_id = ${jobId} and claim_seq = ${claimSeq}
            `;
            if (Number(spent?.n) >= AGENT_TITLE_CAP) return { ok: false, refusal: 'limit' };
            const version = root.title_revision + 1;
            await tx`
                update job set title = ${title}, title_origin = 'agent', title_revision = ${version},
                               title_updated_at = now()
                where org_id = ${orgId} and id = ${rootJobId}
            `;
            await tx`
                insert into job_title_event (org_id, root_job_id, revision, title, origin, job_id, claim_seq)
                values (${orgId}, ${rootJobId}, ${version}, ${title}, 'agent', ${jobId}, ${claimSeq})
            `;
            return { ok: true, title, updated: true, version };
        });
    };
}
