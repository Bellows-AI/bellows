-- An organization's status (docs/organizations.md). Every organization is `active` from its first sign-in; only the
-- operator (OPERATOR_GITHUB_IDS) moves it, and a sign-in never does. In cloud mode a `suspended` or `refused` org's
-- creates are refused and the claim offers none of its queued rows; a self-hosted board reads no status.
alter table organization add column if not exists status text not null default 'active'
    check (status in ('active', 'suspended', 'refused'));
