-- Where an agent default's model comes from (docs/workspace.md): the key provider the model setup saved beside it, or
-- `platform` when the deployment's operator supplies the model. Null for a row saved without a provider (the plain
-- agent-default route). The model setup reads it to tell Anthropic from LiteLLM, and removes the recorded provider's
-- names when a scope switches provider. Nullable, no default: no row is rewritten under the boot lock.
alter table agent_default add column if not exists provider text;
alter table agent_default drop constraint if exists agent_default_provider_ck;
alter table agent_default add constraint agent_default_provider_ck
    check (provider in ('anthropic', 'openrouter', 'openai', 'litellm', 'subscription', 'platform'));
