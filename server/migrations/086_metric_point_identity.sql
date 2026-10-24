-- #846: the metric_point dedupe identity. The old key (metric, session_id, time, source,
-- md5(attrs)) left agent, temporality and start_time out, and null session ids never collided
-- (null <> null in a unique index), so an identical retry of a null-session point duplicated.
-- Raw series that differ only in an allowlist-dropped attribute are told apart by attrs.series,
-- a one-way digest written at ingest.

-- Exact duplicates under the new key would block the index: keep the earliest received_at.
-- (tableoid, ctid) names a row across partitions; ctid alone is only unique within one.
delete from metric_point m
using (
    select tableoid as part, ctid as pos, row_number() over (
               partition by agent, metric, coalesce(session_id, ''), time, source, temporality,
                            coalesce(start_time, 'infinity'::timestamptz), md5(attrs::text)
               order by received_at, ctid
           ) as rn
    from metric_point
) ranked
where ranked.rn > 1 and m.tableoid = ranked.part and m.ctid = ranked.pos;

drop index if exists metric_point_dedup;
create unique index if not exists metric_point_dedup
    on metric_point (agent, metric, coalesce(session_id, ''), time, source, temporality,
                     coalesce(start_time, 'infinity'::timestamptz), md5(attrs::text));
