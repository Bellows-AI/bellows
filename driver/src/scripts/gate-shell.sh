# One gate's shell, passed by content as `sh -c <this> gate <command>`. The agent's tools run as
# their own uid in group 1000, so a gate writes the tree they share group-writable.
# The declared command is $1, one argv element, run exactly as `sh -c <command>` would run it.
umask 002
# Setup only (FACTORY_GATE_SETUP, set by driver/src/gates.ts): a file the tool uid created is owned by
# it, and `chmod` (npm's bin links) needs ownership, not group write. Replace each such file in the
# tree with a copy this uid owns, group-writable so the tool uid can still edit it; a rename needs only
# the group-writable directory. node_modules and .git are skipped: setup rebuilds the first, the second
# is git's. Best effort: a file that cannot be replaced is left for the command to report.
if [ -n "${FACTORY_GATE_SETUP:-}" ]; then
    find . \( -name node_modules -o -name .git \) -prune -o -type f ! -user "$(id -u)" \
        -exec sh -c 'for f; do t="$f.owned.$$"; cp -p "$f" "$t" && chmod g+w "$t" && mv -f "$t" "$f" || rm -f "$t"; done' sh {} + \
        >/dev/null 2>&1
fi
# A gate holds no forge token: with a mailbox to ask through (scripts/gate-forge.sh, installed at
# FACTORY_GATE_BIN/gh by the loop), `gh` resolves to the shim and git's helper for github.com and for each
# host in the comma-separated FACTORY_FORGE_HOSTS to it, the request env's own GIT_CONFIG_* pairs kept (git
# 2.31 and later read them; an older git runs tokenless). Without one (setup, other users of this shell)
# nothing changes.
if [ -n "${FACTORY_GATE_RUN:-}" ] && [ -n "${FACTORY_GATE_BIN:-}" ] && [ -d "$FACTORY_GATE_RUN/asks" ]; then
    PATH="$FACTORY_GATE_BIN:$PATH"
    export PATH
    n=${GIT_CONFIG_COUNT:-0}
    case $n in '' | *[!0-9]*) n=0 ;; esac
    seen=,
    set -f
    oldifs=$IFS
    IFS=,
    for host in github.com ${FACTORY_FORGE_HOSTS:-}; do
        case $host in '' | *[!a-z0-9.:-]*) continue ;; esac
        case $seen in *",$host,"*) continue ;; esac
        seen="$seen$host,"
        m=$((n + 1))
        export "GIT_CONFIG_KEY_$n=credential.https://$host.helper" "GIT_CONFIG_VALUE_$n="
        export "GIT_CONFIG_KEY_$m=credential.https://$host.helper"
        export "GIT_CONFIG_VALUE_$m=!FACTORY_GATE_MODE=credential /bin/sh '$FACTORY_GATE_BIN/gh'"
        n=$((m + 1))
    done
    IFS=$oldifs
    set +f
    export GIT_CONFIG_COUNT=$n
fi
exec sh -c "$1"
