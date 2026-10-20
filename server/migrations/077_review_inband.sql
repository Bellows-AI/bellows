-- In-band reviews (issue #774): a review is leased to its caller's claim in the request's own
-- transaction, never offered to the open claim queue.
--
--   review_caller_seq  the caller's claim_seq the review is leased under. A caller that is
--                      claimed again (a lost runner, a drained node) asks the same key under a
--                      newer claim_seq, which re-leases the running review and resumes its session.
--
-- A review queued before this migration was waiting for a driver slot that no longer claims it:
-- it settles failed, and its caller's next ask for the key reads that.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists review_caller_seq bigint;

update job
set status = 'failed', failure_kind = 'runner_error', finished_at = now(), lease_token = null
where review_of is not null and status = 'queued';
