-- BEL-137: where a secret version's payload lives (server/src/secrets/secret-payloads.ts, docs/secrets.md).
-- 091 held every payload as an AES envelope in the row. A version now names its `storage`:
--
--   database  the envelope is in `envelope`, under `key_id` (every row 091 wrote).
--   aws,vault the plaintext is at the provider object `provider_ref` (at `provider_version` when the provider
--             versions it); the row keeps `payload_mac`, a keyed MAC of the payload that binds it to its
--             identity, reference and logical version. The row holds no envelope and no key id.
--
-- An external version is removed in two phases, so the row outlives its provider object: the new state
-- `deleting` is set first, the payload is removed, and only then is the row dropped. `activate` takes `staged`
-- alone, so a `deleting` version can never become active. A database version is removed by one guarded delete
-- and is never `deleting` (the check below): 091's collector knows no such state, so an older release still
-- finds and removes every database row. Every statement is safe to run again.

alter table secret_version add column if not exists storage text;
-- Rows written by 091 exist on any database that ran it: they are database rows before the column is required.
-- The default keeps an older pod's insert, which names no storage, valid mid-rollout and after a rollback.
update secret_version set storage = 'database' where storage is null;
alter table secret_version alter column storage set default 'database';
alter table secret_version alter column storage set not null;

alter table secret_version add column if not exists provider_ref text;
alter table secret_version add column if not exists provider_version text;
alter table secret_version add column if not exists payload_mac text;
alter table secret_version alter column key_id drop not null;
alter table secret_version alter column envelope drop not null;

alter table secret_version drop constraint if exists secret_version_state_check;
alter table secret_version add constraint secret_version_state_check
    check (state in ('staged', 'active', 'collectable', 'cleanup-pending', 'deleting'));

alter table secret_version drop constraint if exists secret_version_deleting_external;
alter table secret_version add constraint secret_version_deleting_external
    check (state <> 'deleting' or storage <> 'database');

alter table secret_version drop constraint if exists secret_version_storage_check;
alter table secret_version add constraint secret_version_storage_check
    check (storage in ('database', 'aws', 'vault'));

alter table secret_version drop constraint if exists secret_version_payload_shape;
alter table secret_version add constraint secret_version_payload_shape check (
    (storage = 'database'
        and key_id is not null and envelope is not null
        and provider_ref is null and provider_version is null and payload_mac is null)
    or (storage <> 'database'
        and key_id is null and envelope is null
        and provider_ref is not null and payload_mac is not null)
);
