-- Automatic gate repair for objective-mode tasks. `gate_fix_rounds` is the round limit frozen on a
-- thread's root row at create, read off the selected executor profile (`executor_profile.gate_fix_rounds`, 0-10, 0
-- turns repair off); a later profile edit changes later tasks, never a running thread. `gate_fix_round` marks a
-- follow-up row the board queued itself to repair a failed gate: its 1-based round, null on every other row, so
-- the rounds a thread has spent are a count of its marked rows and the task view can say "round N of M".
--
-- Null `gate_fix_rounds` is "no repair": a root created before this file, a task that resolved no profile and a
-- follow-up or retry row (the limit is read off the root). This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists gate_fix_rounds integer;
alter table job add column if not exists gate_fix_round integer;

alter table job add constraint job_gate_fix_rounds_ck check (gate_fix_rounds is null or gate_fix_rounds between 0 and 10);
alter table job add constraint job_gate_fix_round_ck check (gate_fix_round is null or gate_fix_round >= 1);
