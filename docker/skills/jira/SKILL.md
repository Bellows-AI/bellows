---
name: jira
description: Read, search and comment on Jira work items through the jira helper, which uses the Jira connection the task was started with. Use whenever a Jira issue key (ABC-1234), a *.atlassian.net/browse/ URL, or a request to look up or comment on a ticket appears. Also covers Jira authorization failures. Do not use an Atlassian MCP server or `acli` — the helper is the supported path here.
metadata:
  requires-connections: jira
---

# Jira through the jira helper

Reach Jira with `node /usr/local/share/factory-skills/jira/jira.cjs`, which talks to the Jira site of
the connection this task is bound to. You hold no Jira credential and never see one: the helper asks
the board for a short-lived token with the lease this attempt holds now, and only while this attempt
is running. The Atlassian MCP server is deliberately not configured, and `acli` cannot use this
connection — do not use either.

Given a URL like `https://SITE.atlassian.net/browse/ABC-1234`, extract the key and read it through
the helper rather than fetching the page.

## Commands

Every call is one self-contained command that prints JSON on stdout and guidance on stderr; shell
state does not carry between them.

```bash
# Full detail, including the comment thread
node /usr/local/share/factory-skills/jira/jira.cjs issue <KEY> --fields summary,description,status,issuetype,parent,fixVersions,components,labels,comment

# Search by JQL
node /usr/local/share/factory-skills/jira/jira.cjs search "project = ABC AND status = 'In Progress' ORDER BY updated DESC" --fields summary,status,issuetype,parent,fixVersions,components,labels

# The comment thread alone
node /usr/local/share/factory-skills/jira/jira.cjs comments <KEY>

# Comment — plain text; the helper converts it to Atlassian Document Format
node /usr/local/share/factory-skills/jira/jira.cjs comment <KEY> --body-file /tmp/comment.txt
```

If several Jira sites are bound to the task, add `--site HOST` (the site's host name) to choose one.
`comment` posts at most once: the same key and text is one comment however often it is repeated, and
`--key K` names a different comment on purpose. It needs a connection that was allowed to add
comments. Creating or transitioning issues is not supported.

`assignee = currentUser()` matches the connection's own account, not a person.

## Reading a ticket properly

- **Always read the comments.** Clarifications and changed requirements land there, not in the
  description.
- **A subtask is not self-contained.** If `issuetype.subtask` is true or `parent` is non-null,
  fetch the parent too; the actual requirement usually lives there.
- Name the fields you need. `description` and comment bodies come back as ADF JSON: read the
  `text` nodes.

## When the helper stops

Exit 0 is success. Any other exit means **stop and report it** — quote the guidance the helper
printed, which says what to fix — and do not work around it by guessing ticket contents.

- **Exit 3** — the user must act. The closed reason in the JSON says how:
  - `waiting_for_connection` — the board is waiting for the user to connect Jira. End your turn right
    there, with one line saying so, and do not retry or work around it: the task pauses at this point and
    resumes in this same session once Jira is connected.
  - `connection_unavailable` — the user chose to continue without Jira. Carry on with the rest of the
    task without it, and say in your final report which Jira steps you did not do.
  - `no_connection` or `connection` — nothing could be asked of the board here, or the bound connection
    needs the user. Say so; the user connects it and binds it to the task.
  - `insufficient_scopes` — the bound connection was not allowed this step (for example, adding
    comments). Say so; the user widens it.
- **Exit 4** — a `comment` whose outcome is unknown or still in progress. It is never posted again
  by the helper; read the comments to see whether it landed before you decide anything.
- **Exit 1** — refused or failed (the closed reason is in the JSON: `provider-denied`, `not-found`,
  `board_refused`, ...). Do not retry around it.

A refusal that says this attempt holds a lease it no longer has (`board_refused`) is the exception:
every call re-reads the current pair, so retry it once; if a fresh call is refused the same way,
report it, and remember it only for this call — a later turn may succeed. Loading this skill never
grants access; only the connection the task was started with does.
