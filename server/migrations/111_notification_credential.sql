-- Notification credential (BEL-132): a subscription's channel credential (a chat webhook URL) lives in the secret
-- store, never in the row. The row holds the opaque reference and the version it was written at, like env_var's
-- secret_ref/secret_version (093); both are rebuilt-identity checked on every read (docs/secrets.md,
-- docs/notifications.md). NOT NULL without a default is safe here and is the one exception to
-- docs/persistence.md's expand-only rule: the production connector registry was empty until this release, so no
-- deployment could create a subscription row, and a test database is reset. A row without a credential would be a
-- row that can never send, so the schema refuses it instead of the delivery loop discovering it.
-- This file must contain NO `create extension`, per 005's header.

alter table notification_subscription add column if not exists secret_ref text not null;
alter table notification_subscription add column if not exists secret_version text not null;
