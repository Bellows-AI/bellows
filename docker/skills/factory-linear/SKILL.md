---
name: factory-linear
description: Read, search and comment on Linear issues through the linear helper, which uses the Linear connection the task was started with. Use whenever a linear.app/<workspace>/issue/ URL, a Linear issue key (ENG-123) or a request to look up or comment on a Linear issue appears. Also covers Linear authorization failures. Do not use a Linear MCP server or a Linear API key — the helper is the supported path here.
metadata:
  requires-connections: linear
---

# Linear through the linear helper

Reach Linear with `node /usr/local/share/factory-skills/factory-linear/linear.cjs`, which talks to the
Linear workspace of the connection this task is bound to. You hold no Linear credential and never see
one: the helper asks the board for a short-lived token with the lease this attempt holds now, and only
while this attempt is running. A Linear MCP server is deliberately not configured, and a personal API
key cannot use this connection — do not use either.

Given a URL like `https://linear.app/WORKSPACE/issue/ENG-123/some-title`, extract the key (`ENG-123`)
and read it through the helper rather than fetching the page; pass `--workspace WORKSPACE` if several
Linear workspaces are bound.

A bare key like `ABC-123` names no tracker: use the tracker whose connection this task is bound to. If
both Jira and Linear are bound, ask the user which one before you read or comment.

## Commands

Every call is one self-contained command that prints JSON on stdout and guidance on stderr; shell
state does not carry between them.

```bash
# One issue: title, state, assignee, team, project, labels and description
node /usr/local/share/factory-skills/factory-linear/linear.cjs issue <KEY>

# Search with a structured filter: at least one of the flags, combined with AND
node /usr/local/share/factory-skills/factory-linear/linear.cjs search --team ENG --state "In Progress" --assignee me --label Bug --project "Project name" --text "words in the issue"

# The comment thread
node /usr/local/share/factory-skills/factory-linear/linear.cjs comments <KEY>

# Comment — Markdown
node /usr/local/share/factory-skills/factory-linear/linear.cjs comment <KEY> --body-file /tmp/comment.md
```

`--team` takes the team key, `--state`, `--label` and `--project` take names (case does not matter),
and `--assignee` takes `me` or an email address. If several Linear workspaces are bound to the task,
add `--workspace URLKEY` (the workspace's key in its `linear.app/URLKEY` address) to choose one.
`comment` posts at most once: the same key and text is one comment however often it is repeated, and
`--key K` names a different comment on purpose. It needs a connection that was allowed to add
comments. Creating, assigning or moving issues is not supported.

`--assignee me` matches the connection's own account, not a person.

## Reading an issue properly

**Always read the comments.** Clarifications and changed requirements land there, not in the
description.

## Naming the task after a ticket

Only after `issue <KEY>` exited 0, and only if the task's title is still generic or does not describe
the ticket's work, give the task a title with the task-title helper: the ticket's actionable subject
in a few words (up to 120 characters), not its description and not the key alone.

```bash
node /usr/local/share/factory-skills/factory-task-title/task-title.cjs "Fix redirect loop after login"
```

If the read failed, was refused or returned nothing usable, never invent a subject: do not call the
helper, and carry on with the task as the helper's guidance says. A failing title call never blocks the
work. This sets the Bellows task's title only; never rename the Linear issue.

## When the helper stops

Exit 0 is success. Any other exit means **stop and report it** — quote the guidance the helper
printed, which says what to fix — and do not work around it by guessing issue contents.

- **Exit 3** — the user must act. The closed reason in the JSON says how:
  - `waiting_for_connection` — the board is waiting for the user to connect Linear. End your turn right
    there, with one line saying so, and do not retry or work around it: the task pauses at this point and
    resumes in this same session once Linear is connected.
  - `connection_unavailable` — the user chose to continue without Linear. Carry on with the rest of the
    task without it, and say in your final report which Linear steps you did not do.
  - `no_connection` or `connection` — nothing could be asked of the board here, or the bound connection
    needs the user. Say so; the user connects it and binds it to the task.
  - `insufficient_scopes` — the bound connection was not allowed this step (for example, adding
    comments). Say so; the user widens it.
- **Exit 4** — a `comment` whose outcome is unknown or still in progress. The helper never posts it
  twice: running the same command again later checks whether it landed before it posts.
- **Exit 1** — refused or failed (the closed reason is in the JSON: `provider-denied`, `not-found`,
  `board_refused`, `malformed`, ...). Do not retry around it.

A refusal that says this attempt holds a lease it no longer has (`board_refused`) is the exception:
every call re-reads the current pair, so retry it once; if a fresh call is refused the same way,
report it, and remember it only for this call — a later turn may succeed. Loading this skill never
grants access; only the connection the task was started with does.
