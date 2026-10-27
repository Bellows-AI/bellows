---
name: fix-local
description: The fix skill with Codex reviews — fix a GitHub issue end-to-end in an isolated worktree (fix-planner plan, TDD, PR, GitHub review loop), but the fix-planner's plan and the Phase 4 code review both go through the local Codex CLI (`codex exec`, read-only sandbox) instead of the reviewer subagent. Needs `codex` on PATH and logged in, so local machines only. Trigger phrases: "/fix-local", "fix this issue with codex review", "fix locally with codex".
---

# Fix a GitHub issue, Codex-reviewed

Read `<repo root>/.claude/skills/fix/SKILL.md` and run it exactly — every phase, rule, stop
condition, and the autonomy it demands — with these blocks plugged in:

- Issue source: `<repo root>/.claude/skills/fix/blocks/source-github.md` (fix's default).
- Reviewer: `<repo root>/.claude/skills/fix/blocks/review-codex.md`. Read it before Phase 0; it adds
  a Codex preflight and plan review and replaces Phase 4.
