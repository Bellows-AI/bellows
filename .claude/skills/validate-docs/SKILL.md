---
name: validate-docs
description: Validate and update the public user docs in `site/` (Mintlify) against the code — map every user-facing change since a ref to the pages it touches, fix the pages, then run the docs test, the Mintlify build and link checks and the anonymization scan. Also adds a release's changelog entry. Use when the user says "validate docs", "check the user docs", "are the docs up to date", "update the docs for this change", "/validate-docs", and from the `release` skill.
---

# Validate the user docs

`site/` is the user documentation, published by Mintlify from `main` on every merge
(<https://bellows.mintlify.app>). `docs/` is the maintainer index and belongs to the
`doc-maintenance` skill, not this one. The code is the source of truth: a page that disagrees with
it is wrong, whatever the page says.

Input: a ref to compare against (default: the last tag, `git describe --tags --abbrev=0`), and in
release mode the tag and its notes file. Work in a worktree on a branch; never commit to `main`.

## 1. Find what changed for users

```bash
REF=${REF:-$(git describe --tags --abbrev=0)}
git diff --stat "$REF"..HEAD -- web/src cli/src server/src/mcp server/src/workspace server/src/routes \
  core/src driver/src/config.ts server/src/config.ts charts docker/skills .env.example
```

Map each change to the pages that state it. Read the diff, not only the stat: a renamed label or a
new limit is one line.

| Change in | Check these pages |
| --- | --- |
| `web/src` labels, buttons, statuses, settings screens | `overview/quickstart`, `guides/run-tasks`, `guides/task-lifecycle`, the guide for that screen; screenshots in `site/images` |
| `cli/src/usage.ts`, `cli/src/config.ts` | `cli/commands`, `cli/install` |
| `server/src/mcp/tools` | `mcp/tools`, `mcp/connect`, `use-cases/drive-from-claude-code` |
| `server/src/workspace/bellows*.ts` | `reference/bellows-yaml`, `guides/configure-repo`, `guides/gates`, `guides/services`, `guides/policy-and-reviewers` |
| Limits (`MAX_*`, `*_LIMIT`, `docs/limits.md`) | `reference/limits` and the guide that quotes the value |
| Failure kinds, job states | `guides/task-lifecycle`, `reference/faq` |
| Executors, skills, connections, env/secrets, attachments, tokens | the matching `guides/*` page, `cli/install` for tokens |
| `server/src/config.ts`, `driver/src/config.ts`, `.env.example`, `charts/` | `self-host/configuration`, `self-host/kubernetes`, `self-host/docker-compose` |
| GitHub App / Jira app setup, auth modes, runner isolation | `self-host/github-app`, `self-host/jira-app`, `self-host/security` |

Update every page the change makes wrong, in the page's own style (see `site/README.md`). A new
user-facing feature with no page gets a section in the closest guide; a new page also needs its
entry in `site/docs.json` → `navigation`. Features behind a flag that is off by default
(`BATCHES_ENABLED`) stay out, apart from the one note each page already has.

A screen shown in a screenshot that changed visibly gets a fresh capture at the same path and size,
light theme, fictional data only (`acme`, `acme/notes-api`, `alex-doe`, `sam-roe`). If you cannot
capture it, list it in the report rather than leave a stale image silently.

## 2. Run the checks

```bash
npm run build -w core                            # server tests import core/dist
npx vitest run server/test/site-docs.test.ts     # examples parse; CLI, MCP and nav match the code
cd site && npx mint@latest validate && npx mint@latest broken-links && cd ..
```

The test fails when a full `.bellows.yaml` example does not parse (fragments are titled
`.bellows.yaml (excerpt)`), when the documented CLI commands or MCP tools differ from the code, or
when `docs.json` and the pages disagree. Fix the docs, never the test, unless the test is wrong.

Then the anonymization scan — the repo is public:

```bash
grep -rnE "[A-Z][A-Z0-9]+-[0-9]+" site --include='*.mdx' | grep -v PROJ-   # real ticket keys
grep -rniE "https?://[a-z0-9.-]+\.[a-z]{2,}" site --include='*.mdx' \
  | grep -vE "bellows\.cloud|example\.com|github\.com/Bellows-AI|mintlify|localhost|127\.0\.0\.1"
```

Every hit is either fictional (`acme`, `PROJ-123`, `example.com`) or a public Bellows URL. Look at
every new or replaced image yourself.

## 3. Release mode: the changelog entry

Run after the GitHub release exists. Add one `<Update label="vX.Y.Z" description="YYYY-MM-DD">`
block at the top of `site/reference/changelog.mdx`, newest first, from the release notes: user-facing
changes only, in plain words, grouped **New**, **Improved**, **Fixed**, each linking its guide. Drop
internal refactors, CI and test-only items, and every issue number, task id or name. Upgrade notes
for operators stay in the GitHub release.

## 4. Ship

One PR titled `docs(site): …` with what changed and why, the check results, and any screenshot
you could not refresh. Merging publishes the site.

## Reporting back

Pages changed and the code change behind each, checks run and their result, images refreshed or
still stale, and anything you chose not to document with the reason.
