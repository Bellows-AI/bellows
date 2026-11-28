-- The provider setup command's durable operation receipts (docs/persistence.md): 170's `model_setup_operation` under the
-- name of the command that writes it. The command now lives with the provider connections (`POST
-- /api/provider-connections/setup`), so the table, its constraints, its unique index and its row level security policy
-- take that name. The rows stay: a receipt applied before this migration still answers a retry of its request id.
--
-- A rename keeps every row, reference and grant; the constraint and index names are renamed with it so a later
-- migration, a violation message and `\d` all read the one name. The policy is dropped and recreated rather than
-- renamed: its name (`org_isolation`) is the shared one 151 gave every org table, only its table changes.
--
-- This file must contain NO `create extension`, per 005's header: without them postgres wraps the
-- whole body in an implicit transaction, so a crashed run rolls back whole instead of leaving half
-- a schema behind.
alter table if exists model_setup_operation rename to provider_setup_operation;

alter table provider_setup_operation rename constraint model_setup_operation_pk to provider_setup_operation_pk;
alter table provider_setup_operation rename constraint model_setup_operation_org_fk to provider_setup_operation_org_fk;
alter table provider_setup_operation rename constraint model_setup_operation_owner_fk to provider_setup_operation_owner_fk;
alter table provider_setup_operation
    rename constraint model_setup_operation_executor_fk to provider_setup_operation_executor_fk;
alter table provider_setup_operation
    rename constraint model_setup_operation_connection_fk to provider_setup_operation_connection_fk;
alter table provider_setup_operation
    rename constraint model_setup_operation_request_ck to provider_setup_operation_request_ck;
-- The creator's reference was never named in 170: postgres chose `<table>_created_by_fkey`.
alter table provider_setup_operation
    rename constraint model_setup_operation_created_by_fkey to provider_setup_operation_created_by_fkey;

alter index if exists model_setup_operation_request_uk rename to provider_setup_operation_request_uk;

alter table provider_setup_operation enable row level security;
drop policy if exists org_isolation on provider_setup_operation;
create policy org_isolation on provider_setup_operation using (org_id = current_setting('app.org_id', true))
    with check (org_id = current_setting('app.org_id', true));
