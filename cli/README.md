# @bellows-ai/bellows-cli

Command-line client for a [Bellows Factory](https://github.com/Bellows-AI/factory) board: queue
tasks, wait on them, follow up, and drive batches over the board's HTTP API.

## Quick start

```bash
npm install -g @bellows-ai/bellows-cli          # Node.js 22 or newer

mkdir -p ~/.bellows
cat > ~/.bellows/settings.json <<'JSON'
{
  "url": "https://factory.example.com",
  "token": "fat_..."
}
JSON
chmod 600 ~/.bellows/settings.json

bellows auth status                 # checks the configuration and who the token acts as
bellows job create "fix the flaky test" --repo owner/name
bellows job wait <id>
bellows help                        # every command, flag and exit code
```

## Configuration

Every command that talks to the board reads `~/.bellows/settings.json`; `--config <path>` reads
another file. Keys, `FACTORY_*` environment overrides (which win key by key), defaults and the
refusals (exit 2) are `cli/src/config.ts`, pinned by `cli/test/config.test.ts`; `bellows auth status`
shows where each value came from.

- A settings file holding a `token` readable by anyone but you is refused: `chmod 600` it.
- With no settings file the CLI reads the environment alone, so `FACTORY_URL` and `FACTORY_TOKEN`
  work for CI.
- Never put the token on the command line. `--json` on any command prints one machine-readable
  envelope.

MIT licensed.
