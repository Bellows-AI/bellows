-- A task's own title (BEL-252), stored on the thread ROOT only: a follow-up, retry, workflow successor and review
-- row never carries one. `title` null reads as the deterministic fallback derived from the command (core
-- task-title.ts); only `user` and `agent` origins are stored. `title_revision` is the compare-and-set token a
-- rename sends back. `job_title_event` is the audit of every title write. Expand only (docs/persistence.md: a
-- release only expands). This file must contain NO `create extension`, per 005's header.

alter table job add column if not exists title text;
alter table job add column if not exists title_origin text;
alter table job add column if not exists title_revision integer not null default 0;
alter table job add column if not exists title_updated_at timestamptz;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'job_title_shape') then
        alter table job add constraint job_title_shape check (
            (title is null) = (title_origin is null)
            and (title is null or char_length(title) between 1 and 120)
            and (title_origin is null or title_origin in ('user', 'agent'))
            and title_revision >= 0
        );
    end if;
end $$;

create table if not exists job_title_event (
    id uuid primary key default gen_random_uuid(),
    org_id text not null,
    root_job_id uuid not null,
    revision integer not null,
    title text not null,
    origin text not null check (origin in ('user', 'agent')),
    actor_user_id uuid,
    job_id uuid,
    claim_seq bigint,
    created_at timestamptz not null default now(),
    constraint job_title_event_root_fk foreign key (org_id, root_job_id)
        references job (org_id, id) on delete cascade
);

create index if not exists job_title_event_root_idx on job_title_event (org_id, root_job_id, created_at);
