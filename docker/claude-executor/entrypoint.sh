#!/bin/sh
# Enter the work directory, then hand every argument to claude.
#
#   docker run ... claude-executor -p 'summarise the diff'
#   docker run ... -e WORKDIR=/workspace/server claude-executor -p '...'
set -eu

# The GitHub helper beside this script (/usr/local/bin in the image), resolved before any `cd`.
GITHUB_CREDENTIAL="$(cd "$(dirname "$0")" && pwd)/github-credential.cjs"
# The agent's GitHub token is that helper's alone, renewed ahead of expiry: a value injected into
# this container would shadow it in gh and git, and outlive its hour.
unset GITHUB_TOKEN GH_TOKEN

# The task supervisor releases the agent (issue #771). The group exists from the attempt's first
# step, the sync, and the tree this container works in does not exist until then, so the agent waits
# for the supervisor's `go` marker in its read-only mailbox. A Stop or a kill order that lands first
# means the agent is never released: it leaves quietly. An image run by hand has no mailbox and waits
# for nothing.
if [ -n "${FACTORY_CTL_GO:-}" ]; then
    while [ ! -f "$FACTORY_CTL_GO" ]; do
        if [ -f "${FACTORY_CTL_IN:-/nonexistent}/stop" ] || [ -f "${FACTORY_CTL_IN:-/nonexistent}/kill" ]; then
            exit 0
        fi
        sleep 0.2
    done
fi

WORKDIR="${WORKDIR:-/workspace}"
export WORKDIR

# The transcript store (issue #55): when the driver hands us a transcript directory, the CLI's
# config dir moves to it — on the workspaces volume, so transcripts survive this container and a
# follow-up's --resume finds the thread's earlier sessions in the same directory. The seed below
# and the patches read CLAUDE_CONFIG_DIR dynamically, so the baked guard and settings ride along
# unchanged.
if [ -n "${FACTORY_TRANSCRIPT_DIR:-}" ]; then
    mkdir -p "$FACTORY_TRANSCRIPT_DIR"
    export CLAUDE_CONFIG_DIR="$FACTORY_TRANSCRIPT_DIR"
fi

# A fresh CLAUDE_CONFIG_DIR — the transcript store's per-thread directory above, or a volume mounted
# over the baked home — starts empty and would hide the baked configuration. Seed it once from the
# pristine copy. Keyed on settings.json rather than on the directory being empty, since the CLI
# writes .claude.json before anything else asks a question.
if [ ! -f "$CLAUDE_CONFIG_DIR/settings.json" ] && [ -d /opt/claude-home ]; then
    cp -a /opt/claude-home/. "$CLAUDE_CONFIG_DIR/"
fi
# The CLI's config dir — its transcripts, settings and credentials, the exporter's state beside them
# — is the CLI's uid's alone: the agent's tools run as their own uid in its group (issue #814). After
# the seed, whose `cp -a` of the directory itself lays the baked mode back over it.
chmod 0700 "$CLAUDE_CONFIG_DIR" 2>/dev/null || true

# The seed above runs once, but the directory outlives the container and the agent can edit its
# settings.json — stripping the git guard hook there would disarm it for every later run of the
# thread. So the baked `hooks` block (the fence, and the file's only content) is laid over the
# persisted file on EVERY start; every other key is left as the thread wrote it. A settings.json
# that no longer parses is replaced by the baked copy: the guard outranks the unreadable state.
if [ -f /opt/claude-home/settings.json ] && [ -f "$CLAUDE_CONFIG_DIR/settings.json" ]; then
    SETTINGS="$CLAUDE_CONFIG_DIR/settings.json" node -e "
        const fs = require('fs');
        const f = process.env.SETTINGS;
        const baked = JSON.parse(fs.readFileSync('/opt/claude-home/settings.json', 'utf8'));
        let c;
        try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { c = baked; }
        c.hooks = baked.hooks;
        fs.writeFileSync(f, JSON.stringify(c, null, 4) + '\n');
    " || echo "claude-executor: could not re-seed the baked hooks into settings.json" >&2
fi

if [ ! -d "$WORKDIR" ]; then
    echo "claude-executor: WORKDIR '$WORKDIR' does not exist." >&2
    echo "Mount a checkout at it, e.g. -v \"\$PWD:/workspace\"." >&2
    exit 2
fi

cd "$WORKDIR"

# A bind-mounted checkout keeps the host's uid, which is rarely 1000. git then refuses to read the
# repository at all ("dubious ownership"), and every git-shaped thing the agent tries fails with an
# error that says nothing about uids. Marking it safe is the narrow fix; it is scoped to this
# directory, and the container is already a single-user throwaway.
if [ -e "$WORKDIR/.git" ]; then
    git config --global --add safe.directory "$WORKDIR" 2>/dev/null || true
fi

# GitHub (docs/connections.md): no token rides this container's env. git asks the image's helper
# for github.com, and the helper obtains the attempt's token from the board with the attempt pair,
# caches it on the memory-backed /run/factory-github and renews it ahead of expiry; gh is the
# wrapper over the same helper. Only the helper's path lands in the git config, never a token.
if [ -n "${FACTORY_STATS_URL:-}" ] && [ -n "${RUNNER_JOB_ID:-}" ] && [ -n "${RUNNER_LEASE_TOKEN:-}" ]; then
    git config --global credential.https://github.com.helper "!node '$GITHUB_CREDENTIAL' git" \
        2>/dev/null || echo "claude-executor: could not configure the git credential helper" >&2
fi

# The tool uid shares node's group and the tree's umask, and reads this file through its own
# (issue #814): readable, never writable, by the commands the agent runs.
if [ -f "$HOME/.gitconfig" ]; then chmod 0644 "$HOME/.gitconfig" 2>/dev/null || true; fi

# Workspace trust. An untrusted workspace makes the CLI ignore the checkout's .claude/settings.json
# ("Ignoring N permissions.allow entries … this workspace has not been trusted"), and nobody can
# accept the trust dialog in an unattended container. The CLI files trust under the repository's
# MAIN checkout — the git common dir's parent — not under the task worktree it runs in, so both are
# recorded, merged into whatever .claude.json already holds. A directory that is no git checkout
# records itself only. Trusting the tree grants nothing new: the agent already runs arbitrary code
# in it.
TRUST_MAIN="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
TRUST_MAIN="${TRUST_MAIN%/.git}"
CLAUDE_JSON="$CLAUDE_CONFIG_DIR/.claude.json" node -e "
    const fs = require('fs');
    const f = process.env.CLAUDE_JSON;
    let c = {};
    try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    c.projects = c.projects || {};
    for (const dir of process.argv.slice(1).filter(Boolean)) {
        c.projects[dir] = { ...(c.projects[dir] || {}), hasTrustDialogAccepted: true };
    }
    fs.writeFileSync(f, JSON.stringify(c, null, 2));
" "$WORKDIR" "$TRUST_MAIN" || echo "claude-executor: could not record workspace trust in .claude.json" >&2

# Jira (docs/connections.md): JIRA_API is the board's connector proxy for THIS attempt, never
# Atlassian itself — the credential stays on the board, which checks the attempt's lease and the
# task's selected connection on every call. Derived here, never inherited: a stale value would
# send the lease pair wherever it points. The jira skill passes the pair as headers and tells the
# agent to stop and report when the board refuses.
unset JIRA_API
if [ -n "${FACTORY_STATS_URL:-}" ] && [ -n "${RUNNER_JOB_ID:-}" ] && [ -n "${RUNNER_LEASE_TOKEN:-}" ]; then
    export JIRA_API="${FACTORY_STATS_URL%/}/api/jobs/$RUNNER_JOB_ID/connectors/jira/rest/api/3"
fi

# The member's own executor config — model, env vars, permission allowlist — synthesized by the
# board from their `claude-code` executor row (server/src/db/job-store.ts) and delivered as
# CLAUDE_CODE_CONFIG_CONTENT, the same shape opencode's OPENCODE_CONFIG_CONTENT takes. Top-level
# keys overwrite the baked settings.json; `env` merges INTO the baked env block instead of
# replacing it outright. Telemetry is not in this file at all: it lives in managed settings, which
# outrank user settings, so a member cannot disable it or turn on prompt/response/tool-detail
# logging from here. `hooks`, `enabledPlugins` and `extraKnownMarketplaces` are the
# runner's fence — the git guard hook, and no plugin the image does not bake — the board
# already strips them before this env var is set; stripped again here in case a value ever
# arrives some other way.
if [ -n "${CLAUDE_CODE_CONFIG_CONTENT:-}" ]; then
    SETTINGS="$CLAUDE_CONFIG_DIR/settings.json"
    if [ -f "$SETTINGS" ]; then
        SETTINGS="$SETTINGS" node -e "
            const fs = require('fs');
            const f = process.env.SETTINGS;
            const c = JSON.parse(fs.readFileSync(f, 'utf8'));
            const member = JSON.parse(process.env.CLAUDE_CODE_CONFIG_CONTENT);
            delete member.hooks;
            delete member.enabledPlugins;
            delete member.extraKnownMarketplaces;
            const { env: memberEnv, ...rest } = member;
            Object.assign(c, rest);
            if (memberEnv && typeof memberEnv === 'object') {
                c.env = { ...(c.env || {}), ...memberEnv };
            }
            fs.writeFileSync(f, JSON.stringify(c, null, 4) + '\n');
        " || echo "claude-executor: could not merge CLAUDE_CODE_CONFIG_CONTENT into settings.json" >&2
    fi
fi

# The baked Stop hook (issue #226) is a prompt hook, and one without a usable model fails OPEN —
# the stop is allowed, silently. So the placeholder it ships with becomes the run's model, after
# the merge above has settled which one that is: $ANTHROPIC_MODEL, else the merged settings' own
# top-level `model`. With neither, the key is deleted and the CLI uses its default.
if [ -f "$CLAUDE_CONFIG_DIR/settings.json" ]; then
    SETTINGS="$CLAUDE_CONFIG_DIR/settings.json" node -e "
        const fs = require('fs');
        const f = process.env.SETTINGS;
        const c = JSON.parse(fs.readFileSync(f, 'utf8'));
        const model = process.env.ANTHROPIC_MODEL || c.model;
        for (const entry of (c.hooks && c.hooks.Stop) || []) {
            for (const hook of entry.hooks || []) {
                if (hook.model !== '__FACTORY_RUN_MODEL__') continue;
                if (model) hook.model = model; else delete hook.model;
            }
        }
        fs.writeFileSync(f, JSON.stringify(c, null, 4) + '\n');
    " || echo "claude-executor: could not resolve the Stop hook's model in settings.json" >&2
fi

# The branch reporter samples session -> (repo, branch) beside the run, so the board can
# attribute the session's tokens to a PR. A background SIBLING of the CLI, never its child — a
# CLI crash must not take the reporter down mid-run — with stdio discarded: the output stream
# this container prints is the run's, and the reporter never speaks. This shell is PID 1, so
# it owns the runtime's TERM/INT: both children are tracked, the signal is forwarded to both,
# and the CLI is waited out past the trap-interrupted `wait` returns — otherwise a
# `docker stop` would leave it running until the runtime's forced kill. Its exit status, a
# signal death's 143 included, is captured and re-raised, which is the one behavior exec had
# that must survive; the reporter is stopped and reaped before the close-time sample so
# nothing outlives the run.
# The trap goes up BEFORE the first child, not after the last one. Installed afterwards, the
# stretch between the CLI's `&` and the `trap` line is a window where PID 1 still carries the
# default TERM action: a `docker stop` landing there kills this shell outright and leaves the
# CLI running until the runtime's forced kill — the exact outcome the trap exists to prevent.
# The window is small and it is real; it is also what made the offline signal test flaky, since
# that test could only guess at its width with a sleep.
#
# The pids are empty until each child starts, and `kill` is given them UNQUOTED so an empty one
# expands to nothing rather than to an empty argument. A TERM arriving before any child exists
# finds nothing to forward, which is correct: there is nothing running yet to stop.
#
# `cmd & PID=$!` is two commands and cannot be made one, so a signal can still land in the gap
# between the fork and the assignment — the child exists, this shell does not know its pid yet,
# and the forward reaches nothing. TERM_PENDING records that it happened; the re-check once every
# pid is known delivers it. Without that, the signal is simply lost and the run keeps going.
CLI_PID=''
REPORTER_PID=''
PROGRESS_PID=''
CTL_PID=''
PROXY_PID=''
TERM_PENDING=''
on_term() {
    TERM_PENDING=1
    # shellcheck disable=SC2086 # deliberately unquoted: an unset pid must vanish, not empty-arg
    kill -TERM $CLI_PID $REPORTER_PID $PROGRESS_PID $CTL_PID $PROXY_PID 2>/dev/null || true
}
trap on_term TERM INT

# Stops one helper and reaps it. A helper TERMed while still between its fork and exec runs this
# shell's handler and swallows the signal, so a guard sends TERM again and then KILL; a bare `wait`
# held PID 1, and the run, forever.
stop_helper() {
    [ -n "$1" ] || return 0
    kill -TERM "$1" 2>/dev/null || true
    (
        sleep 1
        kill -TERM "$1" 2>/dev/null
        sleep 2
        kill -KILL "$1" 2>/dev/null
    ) &
    _guard=$!
    wait "$1" 2>/dev/null || true
    kill -KILL "$_guard" 2>/dev/null || true
    wait "$_guard" 2>/dev/null || true
}

# The run-control proxy (issue #814): the agent's tools run as their own uid and hold no run-control
# token. The proxy serves the two routes the baked skills call on a socket a tool can reach and
# forwards them to the supervisor's relay socket in FACTORY_CTL_OUT, where the supervisor attaches
# the agent's token (#829); no token is ever in this shell's environment. A sibling like the
# reporter, stdio discarded.
if [ -n "${FACTORY_CTL_OUT:-}" ] && [ -S "$FACTORY_CTL_OUT/control.sock" ]; then
    node /usr/local/bin/control-proxy.cjs >/dev/null 2>&1 &
    PROXY_PID=$!
fi

node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs >/dev/null 2>&1 &
REPORTER_PID=$!
# The cooperative Stop (issue #442): the mailbox agent reads what the task supervisor wrote into
# the read-only FACTORY_CTL_IN directory and writes the stop marker the baked PostToolUse hook
# (stop-hook.cjs) checks after each tool call; it also beats the heartbeat the supervisor reads and
# forwards a kill order to this shell as TERM. Exported so the agent and the hook agree on one
# path; any marker left from before is cleared first. A background sibling like the reporter,
# stdio discarded.
FACTORY_STOP_MARKER=/tmp/factory-stop
export FACTORY_STOP_MARKER
rm -f "$FACTORY_STOP_MARKER"
node /usr/local/bin/ctl-agent.cjs >/dev/null 2>&1 &
CTL_PID=$!
PROGRESS_DIR="$(mktemp -d)"
PROGRESS_FIFO="$PROGRESS_DIR/events"
mkfifo "$PROGRESS_FIFO"
node "$(dirname "$0")/claude-progress.cjs" < "$PROGRESS_FIFO" &
PROGRESS_PID=$!
# The CLI is forked through a subshell that CLEARS the inherited handler and execs. A background
# child inherits the parent's traps until it execs, so a TERM landing in that sliver runs
# `on_term` IN THE CHILD — which sets a copy of TERM_PENDING nothing reads, and swallows the very
# signal meant to kill it. The child then execs and runs on, and `docker stop` waits out its
# grace period for a CLI that was already told to stop. `exec` keeps $! pointing at the CLI, so
# the wait loop and the `kill -0` probe below are unchanged, and the FIFO redirect stays on the
# subshell, which is the same file descriptor the CLI inherits.
#
# What is exec'd is the bridge (issue #226), not the CLI: it launches `claude` in stream-json mode,
# answers AskUserQuestion through the driver's control endpoint inside the same run, forwards
# TERM/INT to the CLI and exits with the CLI's status. Its stdout is the CLI's, unchanged, so the
# FIFO contract holds and $! is still the process the runtime's signal has to reach.
#
# ash and dash — what these images ship — reset the handler themselves and never showed this;
# bash-as-/bin/sh does not, and dropped the signal in 3 of 12 runs of a reduction of this script.
# The entrypoints are run under the host's sh by the offline suite, so "correct only under ash"
# is not good enough for a file whose whole job is to pass a signal on.
(
    trap - TERM INT
    exec node "$(dirname "$0")/claude-bridge.cjs" "$@"
) > "$PROGRESS_FIFO" &
CLI_PID=$!

if [ -n "$TERM_PENDING" ]; then
    # shellcheck disable=SC2086 # same reason as on_term
    kill -TERM $CLI_PID $REPORTER_PID $PROGRESS_PID $CTL_PID $PROXY_PID 2>/dev/null || true
fi

set +e
# `wait` returns 128+signal when the trap interrupts it, indistinguishable from a child that
# died to that signal — so loop until the CLI is really gone (the kill -0 probe fails once
# the last wait has reaped it), and take that final status.
while :; do
    wait "$CLI_PID"
    STATUS=$?
    kill -0 "$CLI_PID" 2>/dev/null || break
done
set -e

# The run is over: stop the sampler and reap it before the close-time sample, which is the
# last thing that runs.
stop_helper "$REPORTER_PID"
stop_helper "$CTL_PID"
stop_helper "$PROXY_PID"
stop_helper "$PROGRESS_PID"
rm -rf "$PROGRESS_DIR"
node --disable-warning=ExperimentalWarning /usr/local/bin/branch-reporter.cjs --once >/dev/null 2>&1 || true
# The supervisor's word that the agent is over, written last and atomically: the exit status the
# runtime reports is still the verdict, this only lets the supervisor start finalizing at once.
if [ -n "${FACTORY_CTL_OUT:-}" ]; then
    printf '%s\n' "$STATUS" > "$FACTORY_CTL_OUT/agent.exit.tmp" 2>/dev/null \
        && mv "$FACTORY_CTL_OUT/agent.exit.tmp" "$FACTORY_CTL_OUT/agent.exit" 2>/dev/null || true
fi
# The cached GitHub token goes with the run; the memory-backed mount goes with the container. The
# tool uid owns the cache (git and gh run as it), so the clear runs through the tool shell too.
"${SHELL:-/bin/sh}" -c 'node "$1" clear' clear "$GITHUB_CREDENTIAL" 2>/dev/null || true
exit "$STATUS"
