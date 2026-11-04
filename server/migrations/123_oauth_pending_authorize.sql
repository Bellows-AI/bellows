-- An authorize request parked while its visitor signs in: no session exists yet, so the vetted parameters wait here
-- and only an opaque id rides the sign-in return path. Bound once to the new session by turning it into a consent
-- transaction (oauth_consent_transaction).
create table if not exists oauth_pending_authorize (
    id_hash        bytea not null,
    client_id      text not null,
    redirect_uri   text not null,
    resource       text not null,
    scopes         text[] not null,
    code_challenge text not null,
    client_state   text,
    created_at     timestamptz not null default now(),
    expires_at     timestamptz not null,
    used_at        timestamptz,
    constraint oauth_pending_authorize_pk primary key (id_hash),
    constraint oauth_pending_authorize_client_fk foreign key (client_id) references oauth_client (client_id)
);
