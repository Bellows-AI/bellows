-- The generic OpenAI-compatible (custom endpoint) connection provider: 167's provider check gains
-- 'openai-compatible' (MODEL_PROVIDERS, core/src/model-providers.ts), and such a row must carry its
-- endpoint, since there is no default one to reach.
--
-- The base URL check is added NOT VALID and then validated: no existing row can hold the new
-- provider, and the two steps keep the table lock short. Both statements are idempotent on a rerun.
alter table provider_connection drop constraint if exists provider_connection_provider_ck;
alter table provider_connection add constraint provider_connection_provider_ck
    check (provider in ('anthropic', 'openrouter', 'openai', 'litellm', 'openai-compatible', 'subscription'));

alter table provider_connection drop constraint if exists provider_connection_compatible_base_url_ck;
alter table provider_connection add constraint provider_connection_compatible_base_url_ck
    check (provider <> 'openai-compatible' or base_url is not null) not valid;
alter table provider_connection validate constraint provider_connection_compatible_base_url_ck;
