-- One non-revoked grant per external account in an organization: another organization connecting the same account
-- holds its own lineage, and a refusal never reveals that some other organization has it.
drop index if exists integration_grant_account_uk;
create unique index if not exists integration_grant_account_uk
    on integration_grant (org_id, provider, external_account_id) where status <> 'revoked';
