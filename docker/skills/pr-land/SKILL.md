---
name: pr-land
description: Take a pull request you pushed to landable in one bounded loop — wait for its CI checks to settle, fix red checks at the root cause, address and reply to review feedback, and repeat until CI is green and no review comment is left unanswered. Use right after you push and open or update a pull request, or when asked to "wait for CI", "fix the failing checks", "address the review" or "land this PR".
metadata:
  requires-tools: gh
  requires-connections: github
---

# Land a pull request

One loop takes the pull request on the task branch from "just pushed" to "nothing blocks the
merge". Merging stays a person's call.

The helper `pr-status.sh` is installed at a fixed path outside the skills directory, where your shell
can read it. Run it as `sh /usr/local/share/factory-skills/pr-land/pr-status.sh`. It waits for the checks, then prints `key=value`
lines: `pr`, `state`, `head`, `review_decision`, `ci` (`green`, `red`, `pending` or `none`), one
`failing=<check> <link>` per failed or cancelled check, and `unanswered_threads` — unresolved
review threads whose last comment is not yours. Exit 2 means it could not read the pull request;
the reason is on stderr.

## Hard rules

- At most 5 fix-and-push iterations. Waiting is never an iteration, and neither is a re-poll that
  finds nothing new.
- At most 45 minutes of waiting in total, in calls of 540 seconds or less (the helper's default):
  a foreground tool call is killed at 600 seconds, having printed nothing.
- Done only when `ci=green` (or `none`, reported), `unanswered_threads=0`, and every review
  summary you read has been addressed or answered. A `CHANGES_REQUESTED` decision clears only when
  the reviewer reviews again, and `REVIEW_REQUIRED` only when a required reviewer approves: once
  you have answered everything, name that decision as still blocking the merge and finish.
- Fix the root cause. Never `--no-verify`, never skip, delete or loosen a failing test, never
  disable a CI step to get green.
- Never merge, close or reopen the pull request, and never enable auto-merge.
- Stay on the task branch: commit and push there, never check out or switch to another one.

## The loop

1. **Find the pull request.** `sh /usr/local/share/factory-skills/pr-land/pr-status.sh --no-wait` resolves the
   current branch's pull request and samples it once. Pass a number or URL to name another.
2. **Wait for CI.** `sh /usr/local/share/factory-skills/pr-land/pr-status.sh <N>`. If `head` is not your
   `git rev-parse HEAD`: your push has not landed, so push again — or, when the remote is ahead
   because someone else pushed, report it and stop. Then act on `ci`:
   - `pending` — run it again while the waiting budget lasts.
   - `red` — step 3.
   - `green` — step 4.
   - `none` — no check registered on this head even after the helper's grace period: note it for
     your report and go on to step 4.
3. **Fix a red check.** Read each failure's log to a file, then search it — never read a whole
   log into the conversation. A `failing=` link of the form `…/actions/runs/<run-id>/job/…` is a
   GitHub Actions run: `gh run view <run-id> --log-failed > /tmp/ci-<run-id>.log`. Any other link
   is an external CI provider: fetch it with `curl -sL <link> > /tmp/ci-<name>.log`; if it needs
   a login you lack, report the check as unreadable and treat it as infrastructure. Decide what
   failed:
   - Your change: fix it and run the relevant declared gates — the names under `gates:` in
     `.bellows.yaml`, one per call:
     `factory-gate <name>`. The answer's `exitCode` 0 is a
     pass; otherwise its `output` tail says what to fix (a gate that sets `filter: true` also takes
     `--filter <tests>`, see the gates skill). With `BELLOWS_GATE_URL` unset, run the
     failing check's own command instead. Commit, push, back to step 2.
   - A flake the log proves (a network timeout, a runner lost mid-job): `gh run rerun <run-id>
     --failed` once per run, back to step 2.
   - Infrastructure, secrets or permissions outside the repository: report it and stop.
4. **Address the review.** Read the review summaries, not only the line comments:
   `gh pr view <N> --json reviews,comments` and
   `gh api --paginate repos/{owner}/{repo}/pulls/<N>/comments`. Fix what is real, commit, push,
   then reply to each comment you addressed saying what changed and how — never "fixed in <sha>"
   alone. A review summary or PR-level comment gets `gh pr comment <N> --body '<what changed>'`;
   a line comment gets a reply in its own thread:
   `gh api repos/{owner}/{repo}/pulls/<N>/comments/<comment-id>/replies -f body='<what changed>'`.
   A comment you disagree with gets a reply saying why, not silence. A reply that only
   acknowledges your fix asks nothing: never answer it, and count a thread it ends as answered.
   Pushed anything? Back to step 2; otherwise run the helper once more to confirm no thread is
   left unanswered, and finish.

Factory's publish after your turn reuses this pull request and never pushes over your commits.

## Finish

End with at most six lines: the pull request URL, `ci`, the review state, what you fixed, and —
when the iteration cap or the waiting budget ran out first — exactly what is still pending or
blocking, as "still waiting on <check>" or "still blocked by <reason>".
