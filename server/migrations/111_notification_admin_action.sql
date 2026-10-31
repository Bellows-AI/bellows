-- Notifications: task.admin_action when an org admin follows up, retries, pokes or cancels the wait of another
-- member's task (BEL-165). The event is written by the action's own transaction (job-store-admin-event.ts), not a
-- trigger, so it exists only when the actor is not the thread's execution_user_id. One event per created job (per
-- cancelling transaction for a wait cancel): the id is md5(<subject> || '/task.admin_action'). It names the actor and
-- the author; the logins are a snapshot like `command`, so a removed user still reads. No FK, as 102 has none.
-- Recipients are the org's subscriptions to the kind (103 is org-owned channels, never a person). Fan-out is
-- 106's notification_event_fan_out().
-- The two kind checks are widened under their auto-generated names, looked up on a database built from 102 and 103
-- (notification_event_kind_check, notification_subscription_event_kinds_check) and kept as the explicit names.
-- Expand only (docs/persistence.md: a release only expands). This file must contain NO `create extension`, per
-- 005's header.

alter table notification_event add column if not exists action text;
alter table notification_event add column if not exists actor_user_id uuid;
alter table notification_event add column if not exists actor_login text;
alter table notification_event add column if not exists author_user_id uuid;
alter table notification_event add column if not exists author_login text;

alter table notification_event drop constraint if exists notification_event_action_check;
alter table notification_event add constraint notification_event_action_check
    check (action is null or action in ('follow-up', 'retry', 'wait-poke', 'wait-cancel'));

alter table notification_event drop constraint if exists notification_event_kind_check;
alter table notification_event add constraint notification_event_kind_check
    check (kind in ('task.ready', 'task.blocked', 'task.question', 'task.admin_action'));

alter table notification_subscription drop constraint if exists notification_subscription_event_kinds_check;
alter table notification_subscription add constraint notification_subscription_event_kinds_check
    check (cardinality(event_kinds) > 0
           and event_kinds <@ array['task.ready', 'task.blocked', 'task.question', 'task.admin_action']);
