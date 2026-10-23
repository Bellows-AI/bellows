-- The pre-agent setup's outcome as a phase checkpoint (issue #917): a failed `environment.setup` was
-- held only in the first driver's memory, so a holder that adopted or took the run over could skip the
-- end-of-run pass that would have refused it. The setup phase runs before the others and is written
-- once, passed or failed, before the agent starts; the adopter reads it back with the other phases.
--
-- This file must contain NO `create extension`, per 005's header.

alter table job_phase_checkpoint drop constraint if exists job_phase_checkpoint_phase_check;
alter table job_phase_checkpoint
    add constraint job_phase_checkpoint_phase_check check (phase in ('setup', 'gates', 'post', 'publish'));
