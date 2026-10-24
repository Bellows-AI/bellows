-- Plain views, deliberately not continuous aggregates: a CAGG cannot express the
-- temporality-aware reduction below, and correctness matters more than shaving a query that
-- is already single-digit milliseconds at this volume.
--
-- Week bucketing is absent on purpose. It lives in core (weekStart/isoWeekKey) so the
-- telemetry series lines up exactly with the PR series on the same chart axis; two
-- independent implementations is how the two drift by a day.
--
-- Dropped before being recreated, not just `create or replace`d: replacing a view cannot
-- change a column's type, so a fix that widens or narrows one would fail on every existing
-- database while passing on a fresh one. Dropped in reverse dependency order.
drop view if exists metric_point_suppressed;
drop view if exists session_summary;
drop view if exists branch_field_total;
drop view if exists session_field_total;
drop view if exists session_branch_slice;
drop view if exists metric_point_used;
drop view if exists session_source;

-- Exactly one source per session, so a session covered by BOTH the live OTEL export and a
-- backfilled transcript is counted once. OTEL wins: it has edit decisions and active time,
-- which transcripts do not record at all.
--
-- Per session, not global — a run of transcript-only sessions is not displaced by one OTEL
-- session existing somewhere else.
--
-- No org_id, on purpose: this reads metric_point, which has none. A datapoint's organization is
-- resolved through session_branch, exactly as its repo is. See the header of 005_organizations.sql.
create or replace view session_source as
select
    agent,
    session_id,
    case when bool_or(source = 'otel') then 'otel' else min(source) end as source
from metric_point
group by agent, session_id;

-- Every view below reads THIS, never metric_point directly. Reading the table would
-- reintroduce the double count that session_source exists to prevent.
--
-- Carries no org_id either, for the same reason as session_source above. The views that need one
-- pick it up from session_branch when they join.
--
-- A null session is its own selection group per agent (session_source groups the nulls together),
-- so those rows are kept, not lost to `null = null`. Two branches rather than one
-- `is not distinct from` join, which Postgres cannot hash. session_summary and the branch views
-- leave them out: they have no session to attach to.
create or replace view metric_point_used as
select mp.*
from metric_point mp
join session_source ss
    on ss.agent = mp.agent
   and ss.session_id = mp.session_id
   and ss.source = mp.source
union all
select mp.*
from metric_point mp
join session_source ss
    on ss.agent = mp.agent
   and ss.session_id is null
   and ss.source = mp.source
where mp.session_id is null;

-- The rows source selection set aside (a transcript copy of a session OTEL owns). Diagnostics
-- only, never added to anything: the same usage is already in metric_point_used.
create or replace view metric_point_suppressed as
select mp.*
from metric_point mp
join session_source ss
    on ss.agent = mp.agent
   and ss.session_id is not distinct from mp.session_id
where ss.source <> mp.source;

-- A session's non-overlapping branch slices.
--
-- The upsert widens first_seen/last_seen, so consecutive branches can overlap and a raw join
-- would count the same datapoint twice. Clamping each slice to the next one's start makes the
-- attribution a genuine partition.
--
-- org_id is in the window partition, not merely projected. Without it the clamp would run across
-- organizations: one org's slice would be truncated by the start of another's, silently dropping
-- datapoints from the interval that used to contain them.
create or replace view session_branch_slice as
select
    org_id,
    agent,
    session_id,
    repo,
    branch,
    head_sha,
    samples,
    first_seen,
    least(
        last_seen,
        coalesce(
            lead(first_seen) over (partition by org_id, agent, session_id order by first_seen)
                - interval '1 microsecond',
            last_seen
        )
    ) as last_seen
from session_branch;

/*
 * THE correctness hazard in this whole feature; core/src/token-contributions.ts is the reference
 * this must equal (server/test-db/telemetry.token-reduction.test.ts compares them).
 *
 * A delta counter reports an increment, so a series' total is the sum. A cumulative counter
 * reports the running total since start_time, so a series' total is its high-water mark, not the
 * sum: `sum(value)` over a cumulative series is a plausible, wildly wrong number with no error
 * anywhere. A series is one raw counter: agent, session, metric, field, temporality, start_time
 * and every retained attribute (model and query_source among them, plus the ingest `series`
 * digest). A restart begins a new start_time, so series totals are added across series. Two
 * counters that merely share a start_time are two series, both counted.
 *
 * `session.id` and `type` are left out of the series key: the key carries them already.
 * Attributes are jsonb, so their order never matters.
 *
 * Rows stored before the ingest digest (legacy) have no `series`. A legacy cumulative row folds
 * into the one digest series equal in every other key component (one counter, never counted
 * twice); with no digest sibling it stands alone; with several it is ambiguous and not added.
 * Deltas need no fold: each point is its own contribution.
 *
 * Unspecified temporality (a gauge, or an exporter that said nothing) is neither a delta nor a
 * running total, so it is not added: a field with only such readings has no row, i.e. unmeasured.
 * A null session is its own group per agent (session_id null in the result).
 *
 * Do not "simplify" this to a plain SUM.
 */
create or replace view session_field_total as
with deltas as (
    select agent, session_id, field, sum(value) as value
    from metric_point_used
    where field is not null and temporality = 'delta'
    group by agent, session_id, field
),
cumulative as (
    select agent, session_id, field, value, attrs ->> 'series' as digest,
           jsonb_build_array(agent, session_id, metric, field, temporality, start_time,
                             attrs - 'series' - 'session.id' - 'type') as fold
    from metric_point_used
    where field is not null and temporality = 'cumulative'
),
siblings as (
    select fold, count(distinct digest) as digests, min(digest) as digest
    from cumulative
    where digest is not null
    group by fold
),
high_water as (
    select c.agent, c.session_id, c.field, max(c.value) as value
    from cumulative c
    left join siblings s on s.fold = c.fold
    where c.digest is not null or coalesce(s.digests, 0) <= 1
    group by c.agent, c.session_id, c.field, c.fold, coalesce(c.digest, s.digest)
)
select agent, session_id, field, sum(value) as value
from (
    select agent, session_id, field, value from deltas
    union all
    select agent, session_id, field, value from high_water
) series
group by agent, session_id, field;

-- Per (session, branch, field), by time containment. Restricted to delta points: a cumulative
-- total has no position in time, so it cannot be divided across branches, and an unspecified
-- reading is not an amount.
--
-- The org comes from the slice, which is the only side of this join that knows one.
create or replace view branch_field_total as
select
    slice.org_id,
    mp.agent,
    mp.session_id,
    slice.branch,
    mp.field,
    sum(mp.value) as value
from metric_point_used mp
join session_branch_slice slice
    on slice.agent = mp.agent
   and slice.session_id = mp.session_id
   and mp.time >= slice.first_seen
   and mp.time <= slice.last_seen
where mp.field is not null
  and mp.temporality = 'delta'
group by slice.org_id, mp.agent, mp.session_id, slice.branch, mp.field;

-- One row per session: its window, its repo, and whether it can be divided at all.
create or replace view session_summary as
with observed as (
    select agent, session_id, min(time) as first_seen, max(time) as last_seen,
           bool_or(temporality = 'cumulative') as any_cumulative,
           bool_and(temporality = 'cumulative') as all_cumulative
    from metric_point_used
    where session_id is not null
    group by agent, session_id
),
branches as (
    -- ::int matters. postgres.js returns bigint as a string, so a bare count(*) makes
    -- `branch_count === 1` false in the client, and a single-branch session silently falls
    -- through to the multi-branch path with a share of 0.
    select agent, session_id, min(org_id) as org_id, min(repo) as repo, count(*)::int as branch_count
    from session_branch
    group by agent, session_id
)
select
    o.agent,
    o.session_id,
    b.org_id,                                   -- null when the hook never reported, exactly as repo is
    b.repo,                                     -- null when the hook never reported
    coalesce(b.branch_count, 0) as branch_count,
    o.first_seen,
    o.last_seen,
    -- 'session' means only an end-of-session total exists. Combined with more than one branch
    -- that is what makes a session indivisible; on its own it is still exactly attributable.
    case when o.all_cumulative then 'session' else 'window' end as granularity,
    o.any_cumulative
from observed o
left join branches b on b.agent = o.agent and b.session_id = o.session_id;
