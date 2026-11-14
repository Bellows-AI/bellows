-- A point and its session's evidence serialize per session (docs/telemetry.md). Without it, an older board's
-- uncommitted org-less point and a binding committed meanwhile miss each other: the fill trigger (145) found no
-- evidence, the repair trigger (147) found no point, and once both commit the point stays org-less for good.
--
-- Both triggers now take one transaction-scoped advisory lock per session before they look: whichever side comes
-- second waits for the first to commit, and its next statement (a plpgsql function is volatile, so each statement
-- takes a fresh READ COMMITTED snapshot) sees the first's row. Every writer of a point or a binding runs in READ
-- COMMITTED. The key is namespaced ('telemetry-session:'), so it cannot equal another lock's string key; the hash is
-- the one every advisory lock here uses (hashtextextended(text, 0)).
--
-- Only an org-less point pays: the fill trigger fires only when the point names no org, which the current board never
-- writes. Evidence rows are rare (a claim, a session report, a branch report's first sample, an owner reservation).
-- An ON CONFLICT path that inserts no row brings no new evidence (the row it met already ran this trigger), so it
-- needs none. This file must contain NO `create extension`, per 005's header.

create or replace function metric_point_org_lock(text) returns void
language sql volatile as $$
    select pg_advisory_xact_lock(hashtextextended('telemetry-session:' || $1, 0))
$$;

create or replace function metric_point_fill_org() returns trigger
language plpgsql volatile as $$
begin
    perform metric_point_org_lock(new.session_id);
    new.org_id := metric_point_org_of(new.session_id);
    return new;
end
$$;

create or replace function metric_point_repair_org() returns trigger
language plpgsql volatile as $$
begin
    perform metric_point_org_lock(new.session_id);
    if metric_point_org_of(new.session_id) = new.org_id then
        update metric_point set org_id = new.org_id
        where session_id = new.session_id and org_id is null;
    end if;
    return null;
end
$$;
