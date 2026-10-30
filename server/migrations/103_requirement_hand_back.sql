-- A runtime requirement records that its asker still owes a hand-back, independent of whether the requirement is
-- still open: a bind or a dismissal that lands before the asking run is handed back must not make the run look
-- finished to a takeover. Expand only (docs/persistence.md): the column is defaulted, so a pod of the previous
-- release keeps reading and writing the table. This file must contain NO `create extension`, per 005's header.

alter table job_integration_requirement add column if not exists hand_back_pending boolean not null default false;

update job_integration_requirement set hand_back_pending = true
    where source = 'runtime' and satisfied_at is null and hand_back_pending = false;
