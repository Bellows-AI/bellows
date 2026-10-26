-- Transcript tool events (issue #983): the gate runs and pull-request operations an executor's own
-- transcript shows, read by the board when a `transcript-raw` chunk lands and again when its stream
-- is finalized. One row per HALF of a tool call: `call` when the call was seen, `result` when its
-- paired result was seen and classified, so a call with no result row is interrupted or unknown,
-- never a success, and a chunk delivered twice, an export taken again or a resumed session replaying
-- its history inserts nothing.
--
--   session_id     the session the RECORD names (opencode `sessionID`, claude `sessionId`), never the
--                  label of the artifact it arrived in.
--   run_claim_seq  the run: the claim whose `job_execution_session` row owns that session (the
--                  ingesting stream's claim when it does, else the earliest owner). A session the job
--                  does not own is dropped, never stored.
--   kind/operation gate run | PR create, publish. A `gh pr view|list` lookup is classified, not stored.
--   outcome        passed | failed | unknown; null on a `call` row.
--   execution_id   the `executionId` of the gate server's answer: joins job_gate_run.
--   operation_id   the `operationId` of the publish reply: joins job_pr_operation. Neither id has a
--                  foreign key: one that points at no row (its write may have failed) is an unlinked
--                  observation and never fails the ingest.
--   pr_*           set only on a result that confirmed a PR of the job's own repository.
--   stream, claim_seq, byte_offset
--                  provenance: the artifact stream and the record's byte offset in it.
--
-- Only classified fields are stored: never a command, raw output, environment or token.
-- Removing a thread deletes its rows.
--
-- This file must contain NO `create extension`, per 005's header.

create table if not exists transcript_tool_event (
    org_id        text        not null,
    job_id        uuid        not null,
    executor      text        not null,
    session_id    text        not null,
    tool_call_id  text        not null,
    part          text        not null check (part in ('call', 'result')),
    run_claim_seq bigint      not null,
    kind          text        not null check (kind in ('gate', 'pr')),
    operation     text        not null check (operation in ('run', 'create', 'publish')),
    gate          text,
    filtered      boolean,
    outcome       text        check (outcome in ('passed', 'failed', 'unknown')),
    exit_code     integer,
    execution_id  uuid,
    operation_id  uuid,
    pr_repo       text,
    pr_number     integer     check (pr_number is null or pr_number > 0),
    pr_url        text,
    stream        text        not null,
    claim_seq     bigint      not null,
    byte_offset   bigint      not null,
    created_at    timestamptz not null default now(),
    primary key (org_id, job_id, executor, session_id, tool_call_id, part),
    check ((part = 'call') = (outcome is null)),
    foreign key (org_id, job_id) references job (org_id, id) on delete cascade
);

create index if not exists transcript_tool_event_gate on transcript_tool_event (org_id, job_id, execution_id)
    where execution_id is not null;
create index if not exists transcript_tool_event_operation on transcript_tool_event (org_id, job_id, operation_id)
    where operation_id is not null;
