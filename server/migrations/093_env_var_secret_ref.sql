-- BEL-54: an environment secret is one record in the secret store (docs/secrets.md); the row keeps only
-- the opaque reference and the stored version it was written at, and `value` is null for it.
--
-- ADDITIONS ONLY, and no check constraint or trigger tying `value` to `secret_ref`: a pod still running the
-- previous release keeps inserting plaintext secrets during a rolling upgrade (docs/persistence.md), and
-- the reader (env-var-store.ts) accepts both formats until the contract follow-up removes the old one.

alter table env_var
    add column if not exists secret_ref     text unique,
    add column if not exists secret_version text,
    alter column value drop not null;
