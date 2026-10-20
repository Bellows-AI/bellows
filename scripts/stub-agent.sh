#!/bin/sh
# stub-agent.sh <command> [args...] — the task supervisor's agent contract for the lane stub
# executor images (scripts/test-jobs.sh, scripts/test-k8s.sh), the part
# docker/claude-executor/entrypoint.sh honors for the real CLI: ctl-agent.cjs (copied beside this
# file) beats agent.alive and turns a kill order into TERM to this shell, TERM/INT is forwarded to
# the command, and the command's exit status is written to $FACTORY_CTL_OUT/agent.exit, atomically
# and last, then re-raised. Without agent.exit the supervisor waits out its agent-start window and
# reads the run as lost. The command's stdout and stderr are the run's, unchanged.
# Pinned by driver/test/lane-stubs.test.ts.

# Review mode (issue #774): `stub-agent.sh review <executor> <executor args…>`, how the stub images'
# /usr/local/bin/claude-executor and opencode-executor answer when a task group's reviewer container
# runs them (scripts/stub-runner.Dockerfile). A scripted reviewer: it names who ran it, tries to
# write into the shared clone it was given read-only and reports whether that failed, optionally
# holds first (a `STUB-REVIEW-HOLD-<seconds>` marker in the instructions, once per reviewer home, so
# a re-run after a lost pod answers at once), and ends on the verdict line the board parses.
if [ "${1:-}" = review ]; then
    executor=${2:-unknown}
    shift 2
    hold=$(printf '%s' "$*" | sed -n 's/.*STUB-REVIEW-HOLD-\([0-9][0-9]*\).*/\1/p' | head -n 1)
    if [ -n "$hold" ] && [ ! -e "$HOME/.stub-review-held" ]; then
        printf '' > "$HOME/.stub-review-held"
        sleep "$hold"
    fi
    probe="${GIT_CONFIG_VALUE_1:-/nonexistent}/.stub-review-write"
    # printf, not `:`: dash exits on a failed redirection of a special builtin.
    if { printf '' > "$probe"; } 2>/dev/null; then
        rm -f "$probe"
        written=written
    else
        written=denied
    fi
    printf 'review-stub executor=%s uid=%s\n' "$executor" "$(id -u)"
    printf 'tree-write=%s\n' "$written"
    echo 'VERDICT: CLEAN'
    exit 0
fi

# The supervisor's release (issue #771), as the real entrypoints wait for it: nothing starts until
# `go`, and a Stop or a kill order that lands first means the agent leaves quietly.
if [ -n "${FACTORY_CTL_GO:-}" ]; then
    while [ ! -f "$FACTORY_CTL_GO" ]; do
        if [ -f "${FACTORY_CTL_IN:-/nonexistent}/stop" ] || [ -f "${FACTORY_CTL_IN:-/nonexistent}/kill" ]; then
            exit 0
        fi
        sleep 0.2
    done
fi

CHILD_PID=''
CTL_PID=''
TERM_PENDING=''
on_term() {
    TERM_PENDING=1
    # shellcheck disable=SC2086 # deliberately unquoted: an unset pid must vanish, not empty-arg
    kill -TERM $CHILD_PID $CTL_PID 2>/dev/null || true
}
# Up before the first child, as in the real entrypoint: a TERM before it would kill this shell
# and leave the command running.
trap on_term TERM INT

node "$(dirname "$0")/ctl-agent.cjs" >/dev/null 2>&1 &
CTL_PID=$!
# The subshell clears the inherited trap before it execs, so a TERM landing in that sliver kills
# the command instead of running on_term in the child.
(
    trap - TERM INT
    exec "$@"
) &
CHILD_PID=$!

if [ -n "$TERM_PENDING" ]; then
    # shellcheck disable=SC2086 # same reason as on_term
    kill -TERM $CHILD_PID $CTL_PID 2>/dev/null || true
fi

# A trap-interrupted `wait` returns 128+signal too: loop until the command is really gone.
while :; do
    wait "$CHILD_PID"
    STATUS=$?
    kill -0 "$CHILD_PID" 2>/dev/null || break
done

kill -TERM "$CTL_PID" 2>/dev/null || true
wait "$CTL_PID" 2>/dev/null || true
if [ -n "${FACTORY_CTL_OUT:-}" ]; then
    printf '%s\n' "$STATUS" > "$FACTORY_CTL_OUT/agent.exit.tmp" 2>/dev/null \
        && mv "$FACTORY_CTL_OUT/agent.exit.tmp" "$FACTORY_CTL_OUT/agent.exit" 2>/dev/null || true
fi
exit "$STATUS"
