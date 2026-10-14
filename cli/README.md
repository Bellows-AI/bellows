# @bellows-ai/bellows-cli

Command-line client for a [Bellows Factory](https://github.com/Bellows-AI/factory) board: queue
tasks, wait on them, follow up, and drive batches over the board's HTTP API.

```bash
npm install -g @bellows-ai/bellows-cli          # Node.js 22 or newer

export FACTORY_URL=https://factory.example.com
export FACTORY_TOKEN=fat_...        # personal token from the board's settings page
bellows auth status                 # checks the configuration and who the token acts as

bellows job create "fix the flaky test" --repo owner/name
bellows job wait <id>
bellows help                        # every command, flag and exit code
```

Instead of exporting, keep the same values in `~/.bellows/settings.json` (`chmod 600` it: a
file holding a token readable by anyone else is refused), or name another file with
`--config <path>` on any command. A set variable wins over the file's key.

```json
{ "url": "https://factory.example.com", "token": "fat_...", "requestTimeoutS": 30, "readRetries": 3 }
```

`--json` on any command prints one machine-readable envelope. Keep the token in your
environment, a `0600` settings file or a secret store, never on the command line.

MIT licensed.
