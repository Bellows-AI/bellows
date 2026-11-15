-- A connection's 054 rollout column `kind` names the grant's provider (docs/connections.md), so it accepts every
-- provider the board registers: Jira and Linear. Expand only: the check is widened in place under its own name, and
-- no existing row is rewritten.
alter table connector_connection
    drop constraint connector_connection_kind_check,
    add constraint connector_connection_kind_check check (kind in ('jira', 'linear'));
