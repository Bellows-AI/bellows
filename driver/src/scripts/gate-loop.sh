# The gate loop: the entrypoint of a task group's gate container — the declared gate image, as the
# gate uid — passed by content as `sh -c <this> gate-loop <gate shell>`. It serves the gate mailbox
# only it and the supervisor mount (driver/src/supervisor-contract.ts, GATE_FILES):
#
#   requests/<id>/{command,cwd,env}  a request, renamed in whole by the supervisor
#   running/<id>                     claimed by rename: from here on the request ran
#   running/<id>/cancel              the supervisor's order to kill it
#   requests/<id>/parallel           marker: this request may run beside other marked ones
#   running/<id>/pgid                the gate's own process group, written by the gate when `setsid` exists
#   done/<id>/{output,exit}          the answer: `exit` written atomically, then the rename
#   alive                            this loop's heartbeat, touched every iteration
#   parallel                         present while the loop can run requests side by side (`setsid` exists)
#   bin/gh                           the GitHub helper ($2, scripts/gate-github.sh), installed at start
#   running/<id>/{asks,answers}      a GitHub token ask of the running request and the supervisor's answer
#
# A request's env is exported inside its own subshell alone, so it never reaches the loop's own
# commands or the next request, and the env file is gone before the command starts; the loop's own
# commands are builtins or absolute paths. The loop itself is the only process that settles a request
# and the only one that kills with `kill -KILL -1`, which spares its caller: after a request ends, and on
# a cancel, the loop kills every process its uid can signal when no other request runs, so nothing a gate
# left behind outlives it into the answer or the next request. NEVER run this outside its container: that
# kill reaches every process of the user that runs it (driver/test/scripts-gate-loop.test.ts pins the
# bytes, and runs it in a pid namespace of its own).
#
# Requests run one at a time, whatever the supervisor posts, except requests that carry a `parallel`
# marker (the supervisor writes it for gates the repository marked `parallel`) when `setsid` exists: those
# are taken while others run, each gate its own session, a cancel or the end of a request kills that
# gate's process group while another request runs, and the sweep above waits until the last one is over.
# Without `setsid` the loop takes a request only when none is running, and says nothing is parallel.
box=${FACTORY_GATE_DIR:-/factory/gate}
shell=$1
github=$2

beat() {
    true > "$box/alive"
}

pause() {
    /bin/sleep 0.2 2>/dev/null || /bin/sleep 1
}

setsid=
for candidate in /usr/bin/setsid /bin/setsid /usr/sbin/setsid /sbin/setsid; do
    if [ -x "$candidate" ]; then
        setsid=$candidate
        break
    fi
done

# Whether every request held in running/ carries the parallel marker (true when none is held).
allparallel() {
    for other in "$box/running"/*; do
        [ -d "$other" ] && [ ! -e "$other/parallel" ] && return 1
    done
    return 0
}

# Whether a request other than $1 is still held in running/ ($1 empty: whether any is).
others() {
    for other in "$box/running"/*; do
        [ -d "$other" ] && [ "$other" != "$1" ] && return 0
    done
    return 1
}

# Starts the request in $1. The inner subshell is the gate: its env, its worktree (126 when the sync
# removed it), the gate shell — in a session of its own when `setsid` exists, which records its process
# group. The outer one records the gate's status once the gate itself ends.
start() {
    (
        (
            if [ -f "$1/env" ]; then
                while IFS= read -r line; do
                    export "$line"
                done < "$1/env"
            fi
            /bin/rm -f "$1/env"
            cwd=$(/bin/cat "$1/cwd")
            cd "$cwd" 2>/dev/null || { echo "[gate] the worktree $cwd is missing"; exit 126; }
            if [ -n "$setsid" ]; then
                FACTORY_GATE_RUN="$1" FACTORY_GATE_BIN="$box/bin" exec "$setsid" /bin/sh -c 'echo $$ > "$FACTORY_GATE_RUN/pgid"; exec /bin/sh -c "$0" gate "$1"' "$shell" "$(/bin/cat "$1/command")"
            fi
            FACTORY_GATE_RUN="$1" FACTORY_GATE_BIN="$box/bin" exec /bin/sh -c "$shell" gate "$(/bin/cat "$1/command")"
        ) > "$1/output" 2>&1
        echo "$?" 2>/dev/null > "$1/code"
    ) &
}

# Answers the request in $1, whose gate ended or was cancelled: first what the gate left behind is
# killed — everything when no other request runs, else its own process group — then `exit` is written.
finish() {
    if others "$1"; then
        if [ -s "$1/pgid" ]; then
            IFS= read -r group < "$1/pgid"
            kill -KILL "-$group" 2>/dev/null
        fi
    else
        kill -KILL -1 2>/dev/null
    fi
    code=137
    [ -e "$1/code" ] && IFS= read -r code < "$1/code"
    echo "$code" > "$1/exit.tmp" && /bin/mv -f "$1/exit.tmp" "$1/exit"
    /bin/mv "$1" "$box/done/${1##*/}"
}

/bin/mkdir -p "$box/requests" "$box/running" "$box/done" "$box/bin"
/bin/rm -f "$box/parallel"
[ -n "$setsid" ] && : > "$box/parallel"
# The helper is `gh` on the gate's PATH and git's credential helper; no chmod in the image = no gh shim.
printf '%s\n' "$github" > "$box/bin/gh"
/bin/chmod 0700 "$box/bin/gh" 2>/dev/null
# A request this loop held when its container restarted ran, and its answer is lost: done, no exit.
for held in "$box/running"/*; do
    [ -d "$held" ] && /bin/mv "$held" "$box/done/"
done
while :; do
    beat
    for request in "$box/requests"/*; do
        [ -d "$request" ] || continue
        # A request waits for the ones running unless it and all of them are marked and `setsid` exists.
        if others "" && { [ -z "$setsid" ] || [ ! -e "$request/parallel" ] || ! allparallel; }; then
            break
        fi
        id=${request##*/}
        /bin/mv "$request" "$box/running/$id" 2>/dev/null || continue
        start "$box/running/$id"
    done
    for held in "$box/running"/*; do
        [ -d "$held" ] || continue
        if [ -e "$held/code" ]; then
            finish "$held"
        elif [ -e "$held/cancel" ] && { ! others "$held" || [ -s "$held/pgid" ]; }; then
            finish "$held"
        fi
    done
    pause
done
