-- Per-acquisition reclaim ownership (issue #821): every acquisition of a task_reclaim row — a queue
-- claim, or a threadDone verdict taking it for the completing attempt — writes a claim_token of its
-- own, and the ack and the renew are fenced by it. The row id stays the work order's name; the
-- token says WHICH acquisition holds it, so a driver whose lease ran out and was re-offered can
-- never ack, renew or hold the checkout as the one that took it after. A row with a token has been
-- acquired and is never withdrawn by a reopen, live or expired: only its ack ends it. claimed_by
-- stays the informational worker name.
--
-- task_reclaim_ack is the ack's receipt: the row is deleted by the ack, so the identical ack
-- replayed after its response was lost reads the receipt and answers ok, and an ack under any
-- other token answers lost. No foreign key — a removed thread's reclaim has no job row left.
alter table task_reclaim add column if not exists claim_token uuid;
update task_reclaim set claim_token = gen_random_uuid() where claimed_by is not null and claim_token is null;

create table if not exists task_reclaim_ack (
    org_id      text not null,
    reclaim_id  uuid not null,
    claim_token uuid not null,
    acked_at    timestamptz not null default now(),
    primary key (org_id, reclaim_id)
);
