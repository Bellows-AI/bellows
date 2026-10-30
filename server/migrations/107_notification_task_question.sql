-- Notifications: task.question when a running agent asks a question a person can answer (BEL-135). One event per
-- question, not per job: a job holds several, so the id is md5(job_id || '/' || question_id || '/task.question'),
-- the job id in the hash because question_id is only unique within its job. The event snapshots the asked texts in
-- ask order (`questions`) and the asking `question_id`; headers and options never ride the event. Emission is an
-- insert-only deferred constraint trigger on job_question, judged at commit on the re-read row: still pending,
-- on a running job holding the question's lease, no stop requested (the answerable condition of
-- job-store-questions.ts). Answering, closing or expiring a question never fires it, so the channel is not told
-- when a question is answered or closed. Fan-out is 106's notification_event_fan_out().
-- Expand only (docs/persistence.md: a release only expands). This file must contain NO `create extension`, per
-- 005's header.

alter table notification_event add column if not exists question_id text;
alter table notification_event add column if not exists questions text[];

create or replace function job_question_notification_event() returns trigger as $$
declare
    v_org text;
    v_id uuid;
begin
    insert into notification_event (org_id, id, kind, job_id, root_job_id, repo, workflow, command, reason, pr_url,
                                    question_id, questions, occurred_at)
    select j.org_id,
           md5(q.job_id::text || '/' || q.question_id || '/task.question')::uuid,
           'task.question',
           j.id,
           j.root_job_id,
           j.repo,
           j.workflow_name,
           j.command,
           null,
           null,
           q.question_id,
           array(select t.e->>'question' from jsonb_array_elements(q.questions) with ordinality as t(e, n) order by t.n),
           q.asked_at
    from job_question q
    join job j on j.org_id = q.org_id and j.id = q.job_id
    where q.org_id = new.org_id
      and q.job_id = new.job_id
      and q.question_id = new.question_id
      and q.state = 'pending'
      and j.status = 'running'
      and j.lease_token = q.lease_token
      and j.cancel_requested_at is null
    on conflict (org_id, id) do nothing
    returning org_id, id into v_org, v_id;
    if found then
        perform notification_event_fan_out(v_org, v_id);
    end if;
    return null;
end;
$$ language plpgsql;

drop trigger if exists job_question_notification_event on job_question;
create constraint trigger job_question_notification_event
    after insert on job_question
    deferrable initially deferred
    for each row execute function job_question_notification_event();
