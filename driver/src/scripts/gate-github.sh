#!/bin/sh
# The gate's GitHub helper, installed by the gate loop at `<gate>/bin/gh` and used two ways: as git's
# credential helper (FACTORY_GATE_MODE=credential, git appends get|store|erase) and as a `gh` shim
# first on the gate's PATH. A gate holds no GitHub token of its own: each use asks for one through
# the request's mailbox, `$FACTORY_GATE_RUN/asks/<pid>`, answered by the supervisor in
# `answers/<pid>` as `token <value>` or `none <reason>`. An ask never printed or kept a token on
# any stream but its caller's, and a token is never empty: no grant is a non-zero exit.
# Only absolute paths for the tools: the request's PATH is the gate command's.
box=${FACTORY_GATE_RUN:-}
limit=${FACTORY_GATE_ASK_SECONDS:-60}
case $limit in '' | *[!0-9]*) limit=60 ;; esac
token=
reason=

pause() {
    /bin/sleep 0.2 2>/dev/null || /bin/sleep 1
}

# Asks for a token: sets $token and returns 0, or sets $reason and returns 1.
ask() {
    token=
    reason=
    if [ -z "$box" ] || [ ! -d "$box/asks" ] || [ ! -d "$box/answers" ]; then
        reason='no gate mailbox to ask through'
        return 1
    fi
    me=$$
    /bin/rm -f "$box/answers/$me"
    # Staged under a dot name the supervisor skips, then renamed whole: it never reads half an ask.
    if ! { printf 'ask\n' > "$box/asks/.$me.tmp" && /bin/mv -f "$box/asks/.$me.tmp" "$box/asks/$me"; }; then
        reason='could not write the ask'
        return 1
    fi
    start=$(/bin/date +%s 2>/dev/null)
    case $start in '' | *[!0-9]*) start= ;; esac
    tries=0
    while :; do
        if [ -f "$box/answers/$me" ]; then
            line=
            IFS= read -r line < "$box/answers/$me"
            case $line in
                'token '?*)
                    token=${line#token }
                    /bin/rm -f "$box/answers/$me"
                    case $token in
                        *[' 	']*) token= ;;
                        *) return 0 ;;
                    esac
                    ;;
                'none '?*)
                    reason=${line#none }
                    /bin/rm -f "$box/answers/$me"
                    return 1
                    ;;
            esac
        fi
        tries=$((tries + 1))
        if [ -n "$start" ]; then
            now=$(/bin/date +%s 2>/dev/null)
            case $now in '' | *[!0-9]*) now=$start ;; esac
            # Whole seconds: -gt so the wait is never shorter than the limit.
            [ $((now - start)) -gt "$limit" ] && break
        fi
        # The wall clock bounds the wait; the count only backstops an image with no `date`.
        [ -z "$start" ] && [ "$tries" -ge $((limit * 5)) ] && break
        pause
    done
    /bin/rm -f "$box/asks/$me"
    reason=unanswered
    return 1
}

refused() {
    echo "gate-github: no GitHub token ($reason)" >&2
}

if [ "${FACTORY_GATE_MODE:-}" = credential ]; then
    [ "$1" = get ] || exit 0
    protocol=
    host=
    while IFS= read -r line && [ -n "$line" ]; do
        case $line in
            protocol=*) protocol=${line#protocol=} ;;
            host=*) host=${line#host=} ;;
        esac
    done
    [ "$protocol" = https ] && [ "$host" = github.com ] || exit 0
    ask || {
        refused
        exit 1
    }
    printf 'username=x-access-token\npassword=%s\n' "$token"
    exit 0
fi

# The `gh` shim: a fresh token in GH_TOKEN, then the image's own gh, found past this directory on PATH.
self=${0%/*}
oldifs=$IFS
IFS=:
real=
for dir in $PATH; do
    if [ "$dir" != "$self" ] && [ -x "$dir/gh" ] && [ ! -d "$dir/gh" ]; then
        real=$dir/gh
        break
    fi
done
IFS=$oldifs
if ask; then
    GH_TOKEN=$token
    export GH_TOKEN
else
    refused
fi
if [ -z "$real" ]; then
    echo 'gh: not found' >&2
    exit 127
fi
exec "$real" "$@"
