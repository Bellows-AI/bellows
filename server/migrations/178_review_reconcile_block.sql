-- The review block is no longer named for one forge: `builtin/github-review-reconcile` became
-- `builtin/review-reconcile`, and the registry keeps no alias for the old id, so a stored graph that still names it
-- would refuse to expand. The compiler stamps the id into every `runtime` node (`runtime.block`), which lives in
-- `workflow.definition` and is frozen in `job.workflow_snapshot` (027). This file rewrites that one field in both.
--
-- The rewrite is structural, never a text replace: only a node whose `runtime` is an object with that exact `block`
-- changes, in place and in order; a prompt that happens to contain the old id is data and stays. A value the file
-- cannot read — not an object, `nodes` not an array — is left exactly as it is, as 165 does.
--
-- Two updates under the boot lock, pre-filtered by a text match on the stored column: workflows are not offered by
-- any UI, so the rows are few.
--
-- This file must contain NO `create extension`, per 005's header.

create function pg_temp.rename_review_block(definition jsonb) returns jsonb
language plpgsql immutable as $$
declare
    nodes jsonb;
begin
    if jsonb_typeof(definition) is distinct from 'object'
        or jsonb_typeof(definition -> 'nodes') is distinct from 'array' then
        return definition;
    end if;

    select coalesce(jsonb_agg(
               case
                   when jsonb_typeof(node) = 'object'
                        and jsonb_typeof(node -> 'runtime') = 'object'
                        and node -> 'runtime' ->> 'block' = 'builtin/github-review-reconcile'
                   then jsonb_set(node, '{runtime,block}', '"builtin/review-reconcile"'::jsonb)
                   else node
               end
               order by position), '[]'::jsonb)
      into nodes
      from jsonb_array_elements(definition -> 'nodes') with ordinality as listed(node, position);

    return jsonb_set(definition, '{nodes}', nodes);
end
$$;

update workflow set definition = pg_temp.rename_review_block(definition)
 where definition::text like '%builtin/github-review-reconcile%';

update job set workflow_snapshot = pg_temp.rename_review_block(workflow_snapshot)
 where workflow_snapshot is not null
   and workflow_snapshot::text like '%builtin/github-review-reconcile%';

drop function pg_temp.rename_review_block(jsonb);
