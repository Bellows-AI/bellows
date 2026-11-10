-- The gcp backend (Google Cloud Secret Manager) names its own storage; the payload-shape check already covers
-- every storage but 'database', so only the closed list of storages widens.
alter table secret_version drop constraint if exists secret_version_storage_check;
alter table secret_version add constraint secret_version_storage_check
    check (storage in ('database', 'aws', 'vault', 'gcp'));
