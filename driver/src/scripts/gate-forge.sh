#!/bin/sh
# The forge helper, installed by the gate loop at `<gate>/bin/gh` and by the supervisor in a forge step's
# own mailbox, and used two ways: as git's credential helper (FACTORY_GATE_MODE=credential, git appends
# get|store|erase) and as a `gh` shim first on the gate's PATH. A gate or step holds no forge token of its
# own: each use asks for one through the mailbox, `ask <host>` in `$FACTORY_GATE_RUN/asks/<pid>`, answered
# by the supervisor in `answers/<pid>` as `token <value>` or `none <reason>`. It answers https only, for
# github.com (user x-access-token) and each host in the comma-separated FACTORY_FORGE_HOSTS (user oauth2);
# any other host gets no output and no ask. An ask never printed or kept a token on any stream but its
# caller's, and a token is never empty: no grant is a non-zero exit. An ask is unresolved from the moment the
# helper writes it until the helper has read its answer and removed it: what an ask leaves behind (the ask, its
# staging file, a missing `$FACTORY_GATE_RUN/faults/armed`, a word on stderr) is read by the supervisor as a credential
# wait, so no timeout, failed removal or stalled supervisor can turn it into git's own auth failure.
# Only absolute paths for the tools: the request's PATH is the gate command's.
box=${FACTORY_GATE_RUN:-}
limit=${FACTORY_GATE_ASK_SECONDS:-60}
case $limit in '' | *[!0-9]*) limit=60 ;; esac
token=
reason=

pause() {
    /bin/sleep 0.2 2>/dev/null || /bin/sleep 1
}

# Asks for host $1's token: sets $token and returns 0, or sets $reason and returns 1.
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
    if ! { printf 'ask %s\n' "$1" > "$box/asks/.$me.tmp" && /bin/mv -f "$box/asks/.$me.tmp" "$box/asks/$me"; }; then
        # Whatever the ask left (a staging file) stays: it is the evidence. Nothing here creates anything, because
        # the fault may have taken the storage to: the supervisor's pre-made `faults/armed` is removed (an entry freed),
        # and a word on stderr says it where not even that can be done (a read-only mailbox).
        /bin/rm -f "$box/faults/armed" 2>/dev/null
        unresolved 'could not write the ask'
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
                    consumed
                    case $token in
                        *[' 	']*) token= ;;
                        *) return 0 ;;
                    esac
                    ;;
                'none '?*)
                    reason=${line#none }
                    consumed
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
    # The ask stays where it is: an ask nobody answered is the evidence the supervisor finds, however late it looks.
    unresolved 'the ask went unanswered'
    reason=unanswered
    return 1
}

# The one act that clears an ask: the answer has been read. The answer goes first, the ask last, so an ask left
# behind (a removal that failed, a helper killed in between) is never read as resolved.
consumed() {
    /bin/rm -f "$box/answers/$me"
    /bin/rm -f "$box/asks/$me"
}

# The helper's word, on stderr, that an ask is unresolved (supervisor.cjs `UNRESOLVED_MARK`).
unresolved() {
    echo "factory-credential-unresolved: $1" >&2
}

refused() {
    case $reason in
        waiting) echo "gate-forge: no token (waiting for the task's starter to reconnect $1 on the board)" >&2 ;;
        *) echo "gate-forge: no token ($reason)" >&2 ;;
    esac
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
    [ "$protocol" = https ] || exit 0
    lower=$(printf '%s' "$host" | /usr/bin/tr '[:upper:]' '[:lower:]' 2>/dev/null) && host=$lower
    # The driver's host rule (repo-ref.ts normalizeForgeHost): DNS labels and one optional numeric port, checked
    # before a default :443 is dropped; anything else asks nothing.
    case $host in
        '' | *[!a-z0-9.:-]* | [.:-]* | *[.-] | *..* | *.-* | *-.* | *[.-]:* | *:*:* | *: | *:*[!0-9]* | *:??????*) exit 0 ;;
    esac
    host=${host%:443}
    allowed=
    [ "$host" = github.com ] && allowed=github
    set -f
    oldifs=$IFS
    IFS=,
    for listed in ${FACTORY_FORGE_HOSTS:-}; do
        [ -z "$allowed" ] && [ "$listed" = "$host" ] && allowed=listed
    done
    IFS=$oldifs
    set +f
    [ -n "$allowed" ] || exit 0
    ask "$host" || {
        refused "$host"
        exit 1
    }
    user=oauth2
    [ "$allowed" = github ] && user=x-access-token
    printf 'username=%s\npassword=%s\n' "$user" "$token"
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
if ask github.com; then
    GH_TOKEN=$token
    export GH_TOKEN
else
    refused github.com
fi
if [ -z "$real" ]; then
    echo 'gh: not found' >&2
    exit 127
fi
exec "$real" "$@"
