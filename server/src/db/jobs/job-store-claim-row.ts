import type { JobMode } from '@factory-ai/core';

/** The claimed row as the acquisition's RETURNING reads it (`job-store-claim.ts`): what `buildClaimResult` turns into a `Claim`. */
export interface ClaimCandidateRow {
    id: string;
    command: string;
    attempts: number;
    max_attempts: number;
    claim_seq: string;
    lease_token: string;
    lease_expires_at: Date;
    created_by: string | null;
    session_id: string | null;
    repo: string | null;
    parent_job_id: string | null;
    executor: string | null;
    follow_up: boolean;
    workflow_node: string | null;
    workflow_name: string | null;
    mode: JobMode;
    root_command: string;
    /** The thread ROOT's selected skills (055), read in the claim's RETURNING. */
    skills: string[];
    /** The providers the thread ROOT holds a live binding for (094), read in the same RETURNING. */
    live_providers: string[];
    /** The frozen target branch of the batch task the thread works (059), read in the same RETURNING; null outside a batch. */
    base_branch: string | null;
    /** Whether this attempt's loss retires the job: attempts and interruption budget spent (issue #822). */
    last_attempt: boolean;
    /** Whether this claim continues, in its session, the interrupted attempt it supersedes (issue #822). */
    resumes_interrupted: boolean;
    /** Whether `session_id` was minted by this row's own attempt rather than inherited from an earlier row (`claimRules`). */
    own_session: boolean;
}
