-- The built-in CLI client: `bellows auth login` signs in through the board's own authorization server as a public
-- client that never registers. Its only redirect is the loopback callback, where the redirect-URI rule lets the port
-- differ (RFC 8252 section 7.3), and it is bound to the API audience with the `factory:full` scope
-- (server/src/routes/oauth-http.ts). The unused-client purge never deletes a builtin row. Re-runnable: the constraint
-- is dropped and re-added, and the seed does nothing when the row exists. This file must contain NO
-- `create extension`, per 005's header.

alter table oauth_client drop constraint if exists oauth_client_kind_ck;
alter table oauth_client add constraint oauth_client_kind_ck check (kind in ('cimd', 'dcr', 'builtin'));

insert into oauth_client (client_id, kind, client_name, redirect_uris)
values ('bellows-cli', 'builtin', 'Bellows CLI', '{http://127.0.0.1/callback}')
on conflict do nothing;
