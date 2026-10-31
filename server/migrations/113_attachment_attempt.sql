-- Task attachments, bounded writes: an upload stamps `last_attempt_at` in the statement that checks the row is still
-- `pending`, before it writes the object, and its write is aborted a fixed bound after that stamp. The sweep expires a
-- draft from the later of `created_at` and this stamp, and deletes the object of a `deleting` row only a grace longer
-- than that bound after `deleting_at`, so no write that passed the check can land after the delete.
--
-- Expand only (docs/persistence.md): a nullable column. This file must contain NO `create extension`, per 005's header.

alter table input_attachment add column if not exists last_attempt_at timestamptz;
