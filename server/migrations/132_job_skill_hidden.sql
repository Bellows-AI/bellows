-- Skills a job row's CLI must not list (BEL-286). `skill_hidden` is the array of `{name, source, reason, connection?}`
-- (`source`: builtin | org | workspace; `reason`: switched_off | needs_connection, naming the missing `connection`)
-- decided once when the row's skills are pinned, in the same transaction and after the task's bindings: a create and a
-- follow-up decide it, a retry, a workflow successor and a durable-wake row copy it, a reviewer row decides it with no
-- bindings. The claim hands the row's own value to the runner; nothing re-reads the switch or the bindings later.
--
-- Expand only (docs/persistence.md): one defaulted column, so rows made before it hide nothing.

alter table job add column if not exists skill_hidden jsonb not null default '[]'::jsonb;
