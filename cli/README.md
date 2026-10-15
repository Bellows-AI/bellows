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

Every command that talks to the board reads `~/.bellows/settings.json`. `help` and `--version`
read no configuration. Pass `--config <path>` on any command to read another file instead.

```json
{
  "url": "https://factory.example.com",
  "token": "fat_...",
  "requestTimeoutS": 30,
  "readRetries": 3
}
```

| Key | Environment override | Default | Meaning |
| --- | --- | --- | --- |
| `url` | `FACTORY_URL` | none (required) | the board's base URL |
| `token` | `FACTORY_TOKEN` | unset | personal access token (`fat_...`) from the board's settings page; leave it out for an open board |
| `requestTimeoutS` | `FACTORY_REQUEST_TIMEOUT_S` | `30` | deadline for one request, in seconds |
| `readRetries` | `FACTORY_READ_RETRIES` | `3` | how many times a failed read or keyed write is retried (never an unkeyed write); `0` turns retries off |

**Environment overrides the file, key by key.** If a variable is set, it wins over that key in
the file. A blank variable counts as unset. Any key missing from both falls back to its default.
That lets you keep one settings file and switch boards for a single command:

```bash
FACTORY_URL=https://staging.example.com bellows job list     # token still comes from the file
```

`bellows auth status` shows where each value came from:

```text
board    https://staging.example.com (version 1.4.2) [env]
token    set (personal) [/home/you/.bellows/settings.json]
requests 30s deadline [default], 3 read retries [default]
```

**These are refused with exit 2:**

- a file passed with `--config` that does not exist
- a settings file that is not valid JSON
- an unknown key, or a key with the wrong type
- a settings file that holds a `token` and is readable by anyone but you; run
  `chmod 600 ~/.bellows/settings.json` to fix it

If there is no `~/.bellows/settings.json` at all, the CLI reads the environment alone, so
`export FACTORY_URL=… FACTORY_TOKEN=…` keeps working for CI and scripts.

Keep the token in a `0600` settings file, your environment or a secret store. Never put it on the
command line. `--json` on any command prints one machine-readable envelope.

MIT licensed.
