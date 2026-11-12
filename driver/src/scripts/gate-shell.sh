# One gate's shell, passed by content as `sh -c <this> gate <command>`. The agent's tools run as
# their own uid in group 1000, so a gate writes the tree they share group-writable.
# The declared command is $1, one argv element, run exactly as `sh -c <command>` would run it.
umask 002
# A gate holds no GitHub token: with a mailbox to ask through (scripts/gate-github.sh, installed at
# FACTORY_GATE_BIN/gh by the loop), `gh` resolves to the shim and git's github.com helper to it, the
# request env's own GIT_CONFIG_* pairs kept. Without one (setup, other users of this shell) nothing changes.
if [ -n "${FACTORY_GATE_RUN:-}" ] && [ -n "${FACTORY_GATE_BIN:-}" ] && [ -d "$FACTORY_GATE_RUN/asks" ]; then
    PATH="$FACTORY_GATE_BIN:$PATH"
    export PATH
    n=${GIT_CONFIG_COUNT:-0}
    case $n in '' | *[!0-9]*) n=0 ;; esac
    m=$((n + 1))
    export "GIT_CONFIG_KEY_$n=credential.https://github.com.helper" "GIT_CONFIG_VALUE_$n="
    export "GIT_CONFIG_KEY_$m=credential.https://github.com.helper"
    export "GIT_CONFIG_VALUE_$m=!FACTORY_GATE_MODE=credential /bin/sh '$FACTORY_GATE_BIN/gh'"
    export GIT_CONFIG_COUNT=$((m + 1))
fi
exec sh -c "$1"
