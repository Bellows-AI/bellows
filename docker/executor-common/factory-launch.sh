#!/bin/sh
# The agent container's entrypoint, in front of the CLI's own. The driver starts this
# container as root with every capability dropped but CAP_SETUID and CAP_SETGID, and
# no-new-privileges. As root this starts the tool broker — the one process that keeps those two, so
# the CLI's commands run as the tool uid (factory-tool.cjs) — and then drops for good to the CLI's
# uid, with no capability, to run its argument. Run as anyone else — the image by hand — it runs its
# argument unchanged.
#
# `--reviewer` first is the review sidecar's launch: the broker starts in reviewer mode — a reviewer's
# tools see no attempt lease either — and the drop is to the reviewer uid 1002 in group node, with
# factory-agent (1002) as its one supplementary group so it reaches the broker's socket. Its tools run
# as the same tool uid a task's do. Run as anyone else, the flag is dropped and the rest runs unchanged.
#
# Until that drop this is root under the run's environment, so it names nothing by PATH, and the
# broker starts under an empty one. The loader's own variables are refused before they get here
# (RESERVED_ENV_NAMES, driver/src/claim.ts).
#
# One file, built into both executor images (driver/test/executor-images.test.ts).
set -eu

BROKER_FLAG=
if [ "${1:-}" = --reviewer ]; then
    BROKER_FLAG=--reviewer
    shift
fi

if [ "$(/usr/bin/id -u)" != 0 ]; then
    exec "$@"
fi

# The CLI and its tools share the tree through group 1000, so everything here writes it group-writable.
umask 002

/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_DISABLE_COMPILE_CACHE=1 \
    /usr/local/bin/node /usr/local/lib/factory-tool/factory-tool.cjs serve $BROKER_FLAG &
BROKER_PID=$!
WAITED=0
while [ ! -S /run/factory-tool/broker.sock ]; do
    if [ "$WAITED" -ge 100 ] || ! kill -0 "$BROKER_PID" 2>/dev/null; then
        echo "factory-launch: the tool broker did not start; the agent does not run without it." >&2
        exit 70
    fi
    WAITED=$((WAITED + 1))
    /bin/sleep 0.1
done

CLAUDE_CODE_SHELL=/usr/local/libexec/factory-tool/bash
SHELL=/usr/local/libexec/factory-tool/bash
export CLAUDE_CODE_SHELL SHELL
# The runtime sets HOME from the uid it started, root's; the CLI's is node's. One the run named stays.
if [ "${HOME:-/root}" = /root ]; then
    HOME=/home/node
    export HOME
fi
if [ -n "$BROKER_FLAG" ]; then
    exec /usr/bin/setpriv --reuid=1002 --regid=1000 --groups=1002 --inh-caps=-all -- "$@"
fi
exec /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all -- "$@"
