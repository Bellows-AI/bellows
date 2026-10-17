-- GitHub is the App's alone (docs/connections.md): the runner obtains a renewing installation token
-- from the board, and `GITHUB_TOKEN` / `GH_TOKEN` are reserved names a PUT refuses in every scope
-- (core/src/env.ts). A row stored before the reservation would still reach a claim, so it goes.
delete from env_var where name in ('GITHUB_TOKEN', 'GH_TOKEN');
