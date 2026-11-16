-- The model a run got (docs/jobs.md): every claim writes the model it handed the runner — the task's chosen model,
-- else its agent default's, else the profile's `config.model` — beside `agent_model`, which stays what was requested.
-- Null until a claim records one, and when the profile sets no model. Nullable with no default: metadata only, so no
-- row is rewritten under the boot lock.
alter table job add column if not exists run_model text;
