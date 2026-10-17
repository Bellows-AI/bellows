-- The claim that asked (issue #822): the asking claim's `job.claim_seq` (057). `attempt` cannot
-- name it — a claim that recovers an expired lease runs in the same attempt, so the lost claim's
-- never-answered question would count against its takeover. The per-claim question cap and the
-- batch's "died holding an unanswered question" read both key by this column.
--
-- Existing rows: a row whose lease still holds its job was asked by the job's current claim; a
-- settled job's row of its last attempt takes the job's last claim, the row the batch read matched
-- before; every other row keeps 0, which no claim carries (each claim bumps the sequence first).
--
-- This file must contain NO `create extension`, per 005's header.

alter table job_question add column if not exists claim_seq bigint not null default 0;

update job_question q
set claim_seq = j.claim_seq
from job j
where j.org_id = q.org_id and j.id = q.job_id
  and (j.lease_token = q.lease_token or (j.lease_token is null and q.attempt = j.attempts));
