-- The artifact index (issue #764, openspec/changes/task-owned-runner): immutable chunk and manifest
-- records for the streams a task's runner uploads, replacing `job_artifact` (046) — one capped,
-- overwritable text row per (job, kind, attempt) — outright. Nothing is migrated: that table's
-- rows were tail-kept 512 KiB excerpts, not the source the new streams are cut from.
--
-- A stream is keyed org / member / root / job / claim sequence / executor / session / stream.
-- The bytes live in the object store under the same coordinates plus the chunk's source byte
-- offset (server/src/artifacts/keys.ts); this schema is the arbiter of what those objects are.
-- The chunk row is inserted BEFORE the object write and is unique on (stream, byte_offset): the
-- object stores answer an identical retry and a different body alike with a 412, so a 412 is
-- success only when the sha256 recorded here matches the body being retried.
--
-- Both tables are insert-only. A chunk is never updated; a manifest is written once, when its
-- stream is finalized, and a second finalize with different content is refused by the store layer.
--
-- `state` is the ARTIFACT-FINALIZATION status of one stream — whether the bytes the reader sees
-- are all the bytes there were — and is deliberately not a column of `job`: a task that succeeded
-- can leave a truncated transcript, and a task that failed can leave a complete one. The task
-- verdict stays `job.status`.
--
-- No foreign key to `job`: removing a task deletes its objects asynchronously through the index,
-- so these rows must outlive the job row until the store has been emptied.
--
-- This file must contain NO `create extension`, per 005's header.

drop table if exists job_artifact;

create table if not exists artifact_chunk (
    org_id text not null,
    member_id text not null,
    root_job_id text not null,
    job_id text not null,
    claim_seq integer not null check (claim_seq >= 0),
    executor text not null,
    session_id text not null,
    stream text not null,
    byte_offset bigint not null check (byte_offset >= 0),
    length integer not null check (length >= 0),
    sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now(),
    primary key (org_id, member_id, root_job_id, job_id, claim_seq, executor, session_id, stream, byte_offset)
);

create table if not exists artifact_manifest (
    org_id text not null,
    member_id text not null,
    root_job_id text not null,
    job_id text not null,
    claim_seq integer not null check (claim_seq >= 0),
    executor text not null,
    session_id text not null,
    stream text not null,
    producer text not null,
    schema_version integer not null check (schema_version >= 1),
    started_at timestamptz not null,
    finished_at timestamptz not null,
    state text not null check (state in ('complete', 'partial', 'truncated')),
    -- Why a stream is not `complete`: `stream_cap`, `org_quota`, `lost_unacknowledged`, ... Free
    -- text to the schema (the producers name their own causes); null exactly when complete.
    terminal_cause text,
    created_at timestamptz not null default now(),
    primary key (org_id, member_id, root_job_id, job_id, claim_seq, executor, session_id, stream),
    check ((state = 'complete') = (terminal_cause is null))
);

-- A task's whole artifact set, for listing and for the removal sweep.
create index if not exists artifact_chunk_job_idx on artifact_chunk (org_id, job_id);
create index if not exists artifact_manifest_job_idx on artifact_manifest (org_id, job_id);
