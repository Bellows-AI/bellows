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

`--json` on any command prints one machine-readable envelope. Keep `FACTORY_TOKEN` in your
environment or a secret store, never on the command line.

MIT licensed.
