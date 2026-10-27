# Issue source: GitHub

The `fix` skill's default issue source. Each item below fills the slot of the same name in `fix`.

- **Argument**: an issue number or URL.
- **REF**: `#<number>` — how prose, briefs and the PR name the issue.
- **`<N>`**: the issue number.
- **Fetch**:
  `gh issue view <url-or-number> --json number,title,body,labels,comments,state > <scratchpad>/issue-<N>.json`.
  Closed means `state` is `CLOSED`.
- **Close line**: `Fixes #<N>` — the issue auto-closes on merge.
- **File a follow-up**: `gh issue create --title <title> --body <body>`; its REF is `#<number>`.
- **After the PR**: nothing.
