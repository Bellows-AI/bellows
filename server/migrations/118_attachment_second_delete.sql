-- Task attachments, second delete: the sweep deletes a `deleting` row's object once and marks the row `deleted`, so an
-- object-store write that the store accepted before a client abort but finished after that delete is never revisited.
-- A `deleted` tombstone's key is deleted once more a fixed time after `deleted_at`; `purged_at` records that second delete.
--
-- Expand only (docs/persistence.md): a nullable column and a partial index. This file must contain NO `create extension`,
-- per 005's header.

alter table input_attachment add column if not exists purged_at timestamptz;

create index if not exists input_attachment_unpurged on input_attachment (deleted_at)
    where state = 'deleted' and purged_at is null;
