#!/bin/sh
# The agent container's entrypoint (issue #814), in front of the CLI's own. The driver starts this
# container as root with every capability dropped but CAP_SETUID and CAP_SETGID, and
# no-new-privileges. As root this starts the tool broker — the one process that keeps those two, so
# the CLI's commands run as the tool uid (factory-tool.cjs) — and then drops for good to the CLI's
# uid, with no capability, to run its argument. Run as anyone else — the image by hand — it runs its
# argument unchanged.
#
# Until that drop this is root under the run's environment, so it names nothing by PATH, and the
# broker starts under an empty one. The loader's own variables are refused before they get here
# (RESERVED_ENV_NAMES, driver/src/claim.ts).
#
# Kept byte-identical in both executor images (driver/test/executor-images.test.ts).
set -eu

if [ "$(/usr/bin/id -u)" != 0 ]; then
    exec "$@"
fi

# The CLI and its tools share the tree through group 1000, so everything here writes it group-writable.
umask 002

/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin NODE_DISABLE_COMPILE_CACHE=1 \
    /usr/local/bin/node /usr/local/lib/factory-tool/factory-tool.cjs serve &
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
exec /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=-all -- "$@"
