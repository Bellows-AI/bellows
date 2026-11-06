-- Built-in skills move to the reserved `factory-` namespace (BEL-269): backend-fix is now factory-fix and every
-- other built-in is `factory-<name>`. A follow-up or retry of any thread, finished or not, reads the root job's
-- `skills`, so every row is rewritten, not only open ones. A name outside the seven is left alone.
update job
set skills = array(
    select case s
        when 'backend-fix' then 'factory-fix'
        when 'gates' then 'factory-gates'
        when 'github' then 'factory-github'
        when 'jira' then 'factory-jira'
        when 'pr-land' then 'factory-pr-land'
        when 'review' then 'factory-review'
        when 'task-title' then 'factory-task-title'
        else s
    end
    from unnest(skills) with ordinality as t(s, n)
    order by n
)
where skills && array['backend-fix', 'gates', 'github', 'jira', 'pr-land', 'review', 'task-title'];
