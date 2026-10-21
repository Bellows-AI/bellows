-- Lease-owned clone rows and token-owned purge stamps (issue #830). The single-process assumption
-- of 011 and 044 is retired: a `cloning` row is held by a claim_token and a lease, a `purging` row
-- by a purge_token and its stamp, and every publish, move and terminal write is fenced by its token.
--
-- Rows already `cloning` get a token and a lease that has run out, so the first pass requeues them;
-- rows already `purging` get a token and keep (or get) a stamp, so recovery claims them once stale.
-- A `failed` row keeps its purge_token: it names the tombstone the failed removal left, which the retry removes.
alter table user_repo add column if not exists claim_token uuid;
alter table user_repo add column if not exists lease_expires_at timestamptz;
alter table user_repo add column if not exists purge_token uuid;

update user_repo set claim_token = gen_random_uuid(), lease_expires_at = now()
    where status = 'cloning' and claim_token is null;
update user_repo set purge_token = gen_random_uuid(), purge_started_at = coalesce(purge_started_at, now())
    where status = 'purging' and purge_token is null;

alter table user_repo drop constraint if exists user_repo_clone_lease_ck;
alter table user_repo
    add constraint user_repo_clone_lease_ck check (
        (status = 'cloning') = (claim_token is not null and lease_expires_at is not null)
    );
alter table user_repo drop constraint if exists user_repo_purge_claim_ck;
alter table user_repo
    add constraint user_repo_purge_claim_ck check (
        status <> 'purging' or (purge_token is not null and purge_started_at is not null)
    );
