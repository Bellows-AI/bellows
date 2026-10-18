import type { JobMode } from '@factory-ai/core';
import type { ReviewerSpec } from './job-store-types.js';

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
    /** Set only on a named-profile review's row (issue #549): the profile it runs as and the ref it starts from. */
    review_of: string | null;
    review_spec: ReviewerSpec | null;
    review_ref: string | null;
    /** The thread ROOT's selected skills (055), read in the claim's RETURNING. */
    skills: string[];
    /** Whether the thread ROOT selected a managed Jira connection (054), read in the same RETURNING. */
    has_jira_connection: boolean;
    /** The frozen target branch of the batch task the thread works (059), read in the same RETURNING; null outside a batch. */
    base_branch: string | null;
    /** Whether this attempt's loss retires the job: attempts and interruption budget spent (issue #822). */
    last_attempt: boolean;
    /** Whether this claim continues, in its session, the interrupted attempt it supersedes (issue #822). */
    resumes_interrupted: boolean;
    /** Whether `session_id` was minted by this row's own attempt rather than inherited from an earlier row (`claimRules`). */
    own_session: boolean;
}
