# claude-executor

Claude Code in a container, run by the driver against a mounted checkout. It does not build or run
this repo's application.

| Concern | Code | Test |
| --- | --- | --- |
| The image — Node 24, `@anthropic-ai/claude-code`, `gh`, `acli`; no plugin | `Dockerfile` | `test.sh` |
| `ENTRYPOINT` (`/usr/local/bin/factory-launch`): as root, the tool broker, then the drop to `node` | `factory-launch.sh` | `driver/test/executor-images.test.ts`, `test.sh` |
| The tool shell: each command as `factory-tool` (1001) through the broker; the run-control proxy | `factory-tool.cjs`, `tool-bash.sh`, `control-proxy.cjs` | `driver/test/tool-broker.test.ts`, `driver/test/control-proxy.test.ts`, `test.sh` |
| `/usr/local/bin/claude-executor`: `$WORKDIR`, `safe.directory`, `JIRA_API` export, transcript redirect | `entrypoint.sh` | `driver/test/executor-images.test.ts`, `test.sh` |
| Git/gh guard, wired as the `PreToolUse` hook | `git-guard.cjs`, `claude-home/settings.json` | `driver/test/executor-images.test.ts`, `git-guard.cjs --selftest` |
| Sidecars: branch reporting to `/api/sessions/branch`; progress over the CLI's `stream-json` | `branch-reporter.cjs`, `claude-progress.cjs` | `driver/test/executor-images.test.ts`, `test.sh` |
| The CLI launcher: `-p` rewritten to stream-json, `AskUserQuestion` relayed through the supervisor's mailbox | `claude-bridge.cjs` | `driver/test/claude-bridge.test.ts` |
| Cooperative Stop: the supervisor-mailbox agent and the `PostToolUse` step-boundary hook | `ctl-agent.cjs`, `stop-hook.cjs` | `driver/test/supervisor.test.ts`, `driver/test/run-control.test.ts` |
| Per-node turn context, the `UserPromptSubmit` hook | `turn-context-hook.cjs` | `driver/test/turn-context-hook.test.ts` |
| Baked global instructions and config dir (`CLAUDE_CONFIG_DIR`) | `claude-home/` | `driver/test/executor-images.test.ts` |
| OTLP exporter config, root-owned managed settings and the runner permission allow-list; the driver renders its endpoint | `managed-settings.json`, `driver/src/telemetry-config.ts` | `test.sh`, `driver/test/telemetry-shipping.test.ts`, `driver/test/executor-images.test.ts` |
| Skills, shared with opencode-executor | `../skills/` | `driver/test/executor-images.test.ts` |

Master-prompt delivery and run control: [docs/jobs.md](../../docs/jobs.md). Managed-settings
precedence and `OTEL_LOG_*`: [docs/security.md](../../docs/security.md).

## Invariants

- Whatever is dropped in `claude-home/` ships at `/home/node/.claude` with no Dockerfile change;
  skills live in `docker/skills/` so both executor images bake the same set.
- Guidance that applies to a subset of tasks belongs in a skill, not in `claude-home/CLAUDE.md`,
  which is read in full every session and names only tooling the image has.
- No credential is baked in; `test.sh` asserts a tokenless run reaches the login prompt. `WORKDIR`
  (default `/workspace`) must exist or the wrapper exits `2`.
- The driver sets `FACTORY_TRANSCRIPT_DIR` per thread on the workspaces volume; the entrypoint makes
  it `CLAUDE_CONFIG_DIR`, seeded from `/opt/claude-home`, so `--resume` finds earlier sessions.
- The git guard is a guardrail, not a security boundary — the driver-side sync refusal is the last
  line of defence.
- `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` drops the CLI's bundled skills; the built-in
  `statusline-setup` agent has no switch and stays — `Dockerfile`.

## Commands

```bash
# The shared skills arrive as the named `skills` build context. CLAUDE_CODE_VERSION pins the CLI.
docker build --build-context skills=docker/skills -t claude-executor docker/claude-executor
make runners                                      # both executor images
docker/claude-executor/test.sh                    # builds claude-executor-test, checks it

docker run --rm -it -e CLAUDE_CODE_OAUTH_TOKEN -v "$PWD:/workspace" \
    claude-executor -p 'summarise the diff on this branch'
```

`ANTHROPIC_API_KEY` works in place of `CLAUDE_CODE_OAUTH_TOKEN`. Telemetry exports only to the
endpoint rendered into `/etc/claude-code/managed-settings.json`; `-e OTEL_EXPORTER_OTLP_ENDPOINT`
loses to it.
