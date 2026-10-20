-- Issue #775: the task's newest checkpoint. The supervisor's finalize stage uploads the branch
-- bundle and the session database as the `checkpoint` artifact stream; its manifest finalizing
-- advances this pointer, in the same transaction, on the thread's ROOT row — and only when the
-- manifest's claim_seq is the claim sequence the uploading job row holds now. A superseded
-- claim's manifest is stored and leaves the pointer alone.
--
-- checkpoint_job_id / _claim_seq / _executor / _session  the manifest's identity in
--                                                        artifact_manifest (with the root's own
--                                                        org_id, member and root_job_id).
-- checkpoint_truncated    the producer hit its cap and uploaded the header only (`checkpoint_cap`).
-- checkpoint_finalized_at when the manifest landed.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job
    add column if not exists checkpoint_job_id text,
    add column if not exists checkpoint_claim_seq bigint,
    add column if not exists checkpoint_executor text,
    add column if not exists checkpoint_session text,
    add column if not exists checkpoint_truncated boolean,
    add column if not exists checkpoint_finalized_at timestamptz;
