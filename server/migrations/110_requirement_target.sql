-- A runtime requirement records what the asking helper needs of the provider (for Jira, the site): the Connect block
-- shows it and the OAuth return binds a new connection only when it matches. Expand only (docs/persistence.md): the
-- column is nullable, so a pod of the previous release keeps reading and writing the table. This file must contain NO
-- `create extension`, per 005's header.

alter table job_integration_requirement add column if not exists target text;
