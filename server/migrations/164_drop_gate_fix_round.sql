-- The board no longer queues a follow-up row to repair a failed gate: the agent's finish is gated inside its run
-- (163's finish passes), so no row is ever a board-queued repair round and the marker 162 added goes. The root's
-- `gate_fix_rounds` stays: it is the in-run cap on failed finish passes, frozen at create.
-- This file must contain NO `create extension`, per 005's header.

alter table job drop constraint if exists job_gate_fix_round_ck;
alter table job drop column if exists gate_fix_round;
