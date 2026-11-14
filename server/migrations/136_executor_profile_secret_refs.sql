-- Executor settings keep no provider key (docs/workspace.md): a credential-shaped value in `config` is replaced by
-- `stored-credential:<ref>`, and this column holds each reference's version and the config path it stands at.
-- Rows saved before it are converted by the executor store before its first read (server/src/db/executor-credentials.ts).
alter table executor_profile add column if not exists secret_refs jsonb not null default '[]'::jsonb;
alter table executor_profile drop constraint if exists executor_profile_secret_refs_ck;
alter table executor_profile add constraint executor_profile_secret_refs_ck check (jsonb_typeof(secret_refs) = 'array');
