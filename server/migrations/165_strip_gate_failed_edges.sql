-- The workflow grammar no longer has a `gate-failed` rule or the `{{gate.name}}` / `{{gate.output}}` placeholders:
-- the agent's finish is gated inside its run (163), so a run that ends on a red gate follows the ordinary `failed`
-- edge. A definition stored before that keeps both, and the engine would meet a rule it no longer knows and a
-- placeholder it refuses to fill. This file removes them from every stored definition (`workflow.definition`) and
-- every frozen snapshot (`job.workflow_snapshot`): each edge whose `when` is "gate-failed" goes, the other edges keep
-- their order, and each `{{gate.name}}` / `{{gate.output}}` token is cut from a node's prompt. A parked
-- `workflow_round` stores an interpolated command, never a definition, so it has nothing to strip.
--
-- A value whose shape is not the one the grammar stores — not an object, `nodes` or `edges` not an array, an edge
-- that is not an object — is left exactly as it is: a value this file cannot read is not one without edges.
--
-- One pass over `job` under the boot lock, the same shape as 163's backfill: workflows are not offered by any UI,
-- so the rows it rewrites are few, and the scan is a text match on the snapshot column.
--
-- This file must contain NO `create extension`, per 005's header.

create function pg_temp.strip_gate_failed(definition jsonb) returns jsonb
language plpgsql immutable as $$
declare
    edges jsonb;
    nodes jsonb;
begin
    if jsonb_typeof(definition) is distinct from 'object'
        or jsonb_typeof(definition -> 'edges') is distinct from 'array'
        or jsonb_typeof(definition -> 'nodes') is distinct from 'array' then
        return definition;
    end if;
    if exists (select 1 from jsonb_array_elements(definition -> 'edges') as edge where jsonb_typeof(edge) <> 'object') then
        return definition;
    end if;

    select coalesce(jsonb_agg(edge order by position), '[]'::jsonb)
      into edges
      from jsonb_array_elements(definition -> 'edges') with ordinality as listed(edge, position)
     where edge -> 'when' is distinct from '"gate-failed"'::jsonb;

    select coalesce(jsonb_agg(
               case
                   when jsonb_typeof(node) = 'object' and jsonb_typeof(node -> 'prompt') = 'string'
                   then jsonb_set(
                       node,
                       '{prompt}',
                       to_jsonb(regexp_replace(node ->> 'prompt', '\{\{\s*gate\.(name|output)\s*\}\}', '', 'g'))
                   )
                   else node
               end
               order by position), '[]'::jsonb)
      into nodes
      from jsonb_array_elements(definition -> 'nodes') with ordinality as listed(node, position);

    return jsonb_set(jsonb_set(definition, '{edges}', edges), '{nodes}', nodes);
end
$$;

update workflow set definition = pg_temp.strip_gate_failed(definition)
 where definition::text like '%gate-failed%' or definition::text ~ 'gate\.(name|output)';

update job set workflow_snapshot = pg_temp.strip_gate_failed(workflow_snapshot)
 where workflow_snapshot is not null
   and (workflow_snapshot::text like '%gate-failed%' or workflow_snapshot::text ~ 'gate\.(name|output)');

drop function pg_temp.strip_gate_failed(jsonb);
