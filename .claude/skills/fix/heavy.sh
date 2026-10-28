#!/bin/sh
# Run a heavy command only while the host has a free slot, so parallel fix runs queue instead of
# saturating one machine.
#
#   sh heavy.sh <command> [args...]               # takes 1 of FACTORY_HEAVY_SLOTS (default 2)
#   sh heavy.sh --exclusive <command> [args...]   # takes every slot: fixed ports, kind, test:jobs
#
# State lives in FACTORY_HEAVY_DIR (default ~/.cache/factory-heavy): one file per held slot, its
# first field the holder pid, changed only under the mkdir mutex. A slot whose holder died is
# reclaimed; a queued --exclusive blocks new shared claims so it cannot starve. stdin reaches the
# command, signals are forwarded to it, and the exit status is the command's.
#
# Host guard, because a slot count cannot see load from outside the queue (another session, a
# leaked process): before claiming, it kills orphaned test runners — vitest processes whose parent
# is gone. Holding the slot, it waits until the 1-minute load is at most FACTORY_HEAVY_MAX_LOAD
# (default 2 x cores) and free memory at least FACTORY_HEAVY_MIN_FREE percent (default 15), for at
# most FACTORY_HEAVY_HOST_WAIT seconds (default 900), then runs anyway with a warning. A command
# that ends with 137 or 143 although nobody signalled heavy.sh was killed by the host (OOM, a
# reaper): it runs once more, after the same wait. FACTORY_HEAVY_GUARD=0 turns all of this off.
set -u

dir="${FACTORY_HEAVY_DIR:-$HOME/.cache/factory-heavy}"
slots="${FACTORY_HEAVY_SLOTS:-2}"
poll="${FACTORY_HEAVY_POLL:-5}"
guard="${FACTORY_HEAVY_GUARD:-1}"
min_free="${FACTORY_HEAVY_MIN_FREE:-15}"
host_wait="${FACTORY_HEAVY_HOST_WAIT:-900}"
usage() {
    echo 'usage: heavy.sh [--exclusive] <command> [args...]' >&2
    exit 2
}
case "$slots" in '' | *[!0-9]* | 0) echo 'heavy.sh: FACTORY_HEAVY_SLOTS must be a positive integer' >&2 && exit 2 ;; esac
want=1
if [ "${1:-}" = --exclusive ]; then
    want="$slots"
    shift
fi
[ $# -gt 0 ] || usage
mkdir -p "$dir" || exit 2
label="$(printf '%s %s' "$PWD" "$*" | tr '\n' ' ' | cut -c1-200)"
wait_file="$dir/exclusive-wait"

holder() { head -n 1 "$1" 2>/dev/null | cut -f1; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }
# drop_dead <file>: removes a state file whose holder is gone.
drop_dead() { [ -f "$1" ] && ! alive "$(holder "$1")" && rm -f "$1"; }

lock() {
    until mkdir "$dir/mutex" 2>/dev/null; do
        pid="$(holder "$dir/mutex/pid")"
        # A holder keeps the mutex for milliseconds: a dead one, or one older than a minute, is stale.
        if { [ -n "$pid" ] && ! alive "$pid"; } || [ -n "$(find "$dir/mutex" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
            rm -rf "$dir/mutex"
        else
            sleep 1
        fi
    done
    echo "$$" >"$dir/mutex/pid"
}
unlock() { rm -rf "$dir/mutex"; }

held=''
# claim: under the mutex, takes $want free slots or none. 0 = taken.
claim() {
    free=0
    i=1
    while [ "$i" -le "$slots" ]; do
        drop_dead "$dir/slot-$i"
        [ -f "$dir/slot-$i" ] || free=$((free + 1))
        i=$((i + 1))
    done
    drop_dead "$wait_file"
    if [ "$want" -eq 1 ] && [ -f "$wait_file" ]; then return 1; fi
    if [ "$free" -lt "$want" ]; then
        [ "$want" -gt 1 ] && [ ! -f "$wait_file" ] && printf '%s\t%s\n' "$$" "$label" >"$wait_file"
        return 1
    fi
    i=1
    while [ "$i" -le "$slots" ] && [ "$(echo "$held" | wc -w)" -lt "$want" ]; do
        if [ ! -f "$dir/slot-$i" ]; then
            printf '%s\t%s\n' "$$" "$label" >"$dir/slot-$i"
            held="$held $i"
        fi
        i=$((i + 1))
    done
    [ "$(holder "$wait_file")" = "$$" ] && rm -f "$wait_file"
    return 0
}

release() {
    for i in $held; do rm -f "$dir/slot-$i"; done
    held=''
    [ "$(holder "$wait_file")" = "$$" ] && rm -f "$wait_file"
    [ "$(holder "$dir/mutex/pid")" = "$$" ] && unlock
    return 0
}
trap release EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

host_load() {
    if [ -r /proc/loadavg ]; then cut -d' ' -f1 /proc/loadavg; else sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}'; fi
}
host_cores() { getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null; }
host_free() {
    if [ -r /proc/meminfo ]; then
        awk '/^MemTotal:/ {t = $2} /^MemAvailable:/ {a = $2} END {if (t) printf "%d\n", a * 100 / t}' /proc/meminfo
    elif command -v memory_pressure >/dev/null 2>&1; then
        memory_pressure -Q 2>/dev/null | awk '/free percentage/ {gsub("%", "", $NF); print $NF}'
    fi
}
# host_reason: why the host is too busy to start, or nothing. FACTORY_HEAVY_PROBE replaces the
# probes with one command printing "<load> <cores> <free %>". A value it cannot read is skipped.
host_reason() {
    if [ -n "${FACTORY_HEAVY_PROBE:-}" ]; then
        # shellcheck disable=SC2046
        set -- $(sh -c "$FACTORY_HEAVY_PROBE" 2>/dev/null)
    else
        set -- "$(host_load)" "$(host_cores)" "$(host_free)"
    fi
    max="${FACTORY_HEAVY_MAX_LOAD:-}"
    [ -n "$max" ] || case "${2:-}" in '' | *[!0-9]*) ;; *) max=$(($2 * 2)) ;; esac
    awk -v l="${1:-}" -v m="$max" -v f="${3:-}" -v mf="$min_free" 'BEGIN {
        if (l != "" && m != "" && l + 0 > m + 0) { printf "load %s over %s", l, m; exit }
        if (f != "" && f + 0 < mf + 0) printf "free memory %s%% under %s%%", f, mf
    }'
}
wait_for_host() {
    [ "$guard" = 0 ] && return 0
    since="$(date +%s)"
    told=0
    while reason="$(host_reason)" && [ -n "$reason" ]; do
        if [ $(($(date +%s) - since)) -ge "$host_wait" ]; then
            echo "heavy.sh: host still busy ($reason) after ${host_wait}s; running anyway" >&2
            return 0
        fi
        [ "$told" -eq 1 ] || echo "heavy.sh: holding the slot until the host settles ($reason)" >&2
        told=1
        sleep "$poll"
    done
}
# Kills test runners whose parent is gone: vitest workers (they retitle themselves `node (vitest
# N)`), and anything naming vitest under the directory that holds this checkout and its worktrees.
sweep_orphans() {
    [ "$guard" = 0 ] && return 0
    under="${FACTORY_HEAVY_SWEEP_UNDER:-$(cd "$(dirname "$0")/../../../.." && pwd -P)/}"
    victims="$(ps -wwAo pid=,ppid=,command= | awk -v under="$under" '
        $2 != 1 { next }
        { cmd = $0; sub(/^ *[0-9]+ +[0-9]+ +/, "", cmd) }
        cmd ~ /^node \(vitest/ || (index(cmd, under) && cmd ~ /vitest/) { print $1 }
    ' | tr '\n' ' ')"
    [ -n "$victims" ] || return 0
    echo "heavy.sh: killing orphaned test runners: $victims" >&2
    # shellcheck disable=SC2086
    kill -TERM $victims 2>/dev/null
    return 0
}

sweep_orphans
announced=0
while :; do
    lock
    claim
    taken=$?
    unlock
    [ "$taken" -eq 0 ] && break
    if [ "$announced" -eq 0 ]; then
        echo "heavy.sh: waiting for $want of $slots slot(s); held by:" >&2
        cat "$dir"/slot-* "$wait_file" 2>/dev/null | cut -f2 | sed 's/^/  /' >&2
        announced=1
    fi
    sleep "$poll"
done

# An asynchronous command reads /dev/null unless given stdin explicitly: hand it ours through fd 3.
exec 3<&0
signalled=0
attempt=1
while :; do
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    wait_for_host
    "$@" <&3 3<&- &
    child=$!
    trap 'signalled=1; kill -TERM "$child" 2>/dev/null' INT TERM HUP
    wait "$child"
    status=$?
    # A trapped signal interrupts wait while the child is still exiting: wait for its real status.
    while kill -0 "$child" 2>/dev/null; do
        wait "$child"
        status=$?
    done
    if [ "$guard" != 0 ] && [ "$signalled" -eq 0 ] && [ "$attempt" -eq 1 ] &&
        { [ "$status" -eq 137 ] || [ "$status" -eq 143 ]; }; then
        echo "heavy.sh: exit $status and nobody signalled heavy.sh: the host killed it; running once more" >&2
        attempt=2
        continue
    fi
    break
done
exec 3<&-
exit "$status"
