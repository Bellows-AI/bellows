-- GitLab's credential names are the member grant's alone (docs/connections.md): the runner fetches the starter's token
-- from the board on demand, and `GITLAB_TOKEN` / `GL_TOKEN` / `CI_JOB_TOKEN` are reserved names a PUT refuses in every
-- scope (core/src/env.ts). A row stored before the reservation would still reach a claim, so it goes.
delete from env_var where name in ('GITLAB_TOKEN', 'GL_TOKEN', 'CI_JOB_TOKEN');
