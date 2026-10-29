---
name: github
description: Work with GitHub through the gh CLI — reading PR reviews and line comments, checking CI status, reading issues, and replying to review feedback. Use whenever a GitHub URL, PR number or issue is mentioned, or when asked to address review comments. Covers the reply-with-what-changed convention.
metadata:
  requires-tools: gh
  requires-connections: github
---

# GitHub through gh

Use `gh` for all GitHub work — issues, PRs, checks, releases. Given a GitHub URL, fetch it with
`gh` rather than guessing at the content or scraping the page.

```bash
gh pr view <N> --repo <owner/repo> --comments --json comments,reviews
gh api repos/<owner/repo>/pulls/<N>/comments   # line-level review comments
gh pr status
gh pr checks <N>
gh pr diff <N>
```

## Opening and updating pull requests

Opening and updating the pull request is yours, whenever your work is worth showing — before the
task is done too. Run the declared gates that cover your change first (see the gates skill), fix a red one
before you push, and say in the pull request which did not run (an unavailable gate is reported,
not a blocker). Commit on the task branch, push it, and open the pull request with `gh pr create`
(`gh pr edit` updates it). Never state in a title or description that a gate passed unless it did.

Or ask the driver to do the push and the pull request:

```bash
factory-control publish
```

The driver pushes the branch and opens (or reuses) the pull request — a draft when it opens one —
with a title and description summarized from the branch's commits, and answers
`{"published":true,"prUrl":"…","prNumber":N,…}`. A pull request you opened on the task branch is
the one the driver reuses: the same pull request is updated, never duplicated, and a retried or
resumed task lands on it too. `published: false` means there was nothing new to push. `403` means
this task's workflow publishes at its own step; `409` means a publish is already running, or the
repository's explicit `policy:` refused it (the body says why); `502` carries the failure's
reason. If `/run/factory-control/control.sock` does not exist this environment cannot publish for you.

A PR that already exists is yours to read — reviews, checks, diffs — and to fix on request.
Read a PR's diff with `gh pr diff`, never by checking the branch out:
`gh pr checkout` moves HEAD off the task branch the driver publishes from.

## Addressing review feedback

**Read the review summary on the PR itself, not only the line comments.** The substantive
objection often lives in the summary while the line comments are details.

After pushing fixes, reply to each comment you addressed. Every reply must say *what changed and
how* — "fixed in `<sha>`" alone is not enough:

```bash
gh pr comment <N> --body "Fixed in <sha> — clamped limit to MAX_LIMIT=100 in the validator before
the DB query, so an oversized page can no longer reach Postgres"
```
