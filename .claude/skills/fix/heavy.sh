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
set -u

dir="${FACTORY_HEAVY_DIR:-$HOME/.cache/factory-heavy}"
slots="${FACTORY_HEAVY_SLOTS:-2}"
poll="${FACTORY_HEAVY_POLL:-5}"
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
"$@" <&3 3<&- &
child=$!
exec 3<&-
trap 'kill -TERM "$child" 2>/dev/null' INT TERM HUP
wait "$child"
status=$?
# A trapped signal interrupts wait while the child is still exiting: wait for its real status.
while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    status=$?
done
exit "$status"
