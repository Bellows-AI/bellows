-- Every table with an org_id references organization and is removed with it (docs/persistence.md).
-- These are the tables that carried org_id without the key; server/src/db/org-tables.ts lists all of
-- them and server/test-db/org-tables.test.ts fails when a new one lacks the registry entry or the key.
--
-- Each key is added NOT VALID, then validated. The runner applies every pending file in one
-- transaction, so splitting the VALIDATE into a later file of the same release would not shorten the
-- lock; the split is what lets a failed validation name the orphan below. Orphan rows are never
-- deleted: the migration refuses, naming the table and the organization, and the boot stays failed
-- until an operator removes or re-homes those rows by hand.
--
-- This file must contain NO `create extension`, per 005's header.

do $$
declare
    t text;
    orphan text;
begin
    foreach t in array array[
        'artifact_chunk', 'artifact_manifest', 'batch_acceptance', 'batch_attempt', 'batch_decision',
        'batch_idempotency', 'batch_merge', 'batch_pr_observation', 'batch_stage', 'batch_stage_verification',
        'batch_target', 'batch_task', 'commerce_usage_report', 'integration_operation_receipt', 'job',
        'job_conclusion', 'job_connection_binding', 'job_execution', 'job_execution_session', 'job_gate_run',
        'job_integration_requirement', 'job_phase_checkpoint', 'job_pr_operation', 'job_question',
        'job_settle_receipt', 'job_title_event', 'notification_event', 'notification_outbox', 'org_plan',
        'session_branch', 'task_reclaim', 'task_reclaim_ack', 'transcript_tool_event'
    ] loop
        execute format(
            'alter table %I add constraint %I foreign key (org_id) references organization (id) on delete cascade not valid',
            t, t || '_org_id_fkey'
        );
        begin
            execute format('alter table %I validate constraint %I', t, t || '_org_id_fkey');
        exception when foreign_key_violation then
            execute format(
                'select x.org_id from %I x where not exists (select 1 from organization o where o.id = x.org_id) limit 1',
                t
            ) into orphan;
            raise exception 'table % holds rows of organization % that does not exist; nothing was deleted', t, orphan
                using errcode = 'foreign_key_violation',
                      hint = 'remove or re-home that organization''s rows by hand, then restart the board';
        end;
    end loop;
end
$$;
