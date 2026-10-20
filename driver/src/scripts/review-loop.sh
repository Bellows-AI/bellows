# The review loop: the entrypoint of a task group's reviewer container — the executor image, as the
# reviewer uid — passed by content as `sh -c <this> review-loop`. It serves the review mailbox only
# it and the supervisor mount (driver/src/supervisor-contract.ts, REVIEW_FILES), in the gate loop's
# layout (scripts/gate-loop.sh):
#
#   requests/<id>/{command,cwd,env}  a request, renamed in whole by the supervisor
#   running/<id>                     claimed by rename: from here on the request ran
#   running/<id>/cancel              the supervisor's order to kill it
#   done/<id>/{output,exit}          the answer: `exit` written atomically, then the rename
#   alive                            this loop's heartbeat, touched every iteration
#
# A request's env is its credential volume: exported inside its own subshell alone, so it never
# reaches the loop's own commands or the next request, and the env file is gone before the command
# starts. The loop's own commands are builtins or absolute paths. After every request and on a
# cancel the loop kills every process its uid can signal, which spares the loop itself: nothing a
# review left behind outlives it into the answer or the next request. NEVER run this outside its
# container: that kill reaches every process of the user that runs it
# (driver/test/scripts-review-loop.test.ts pins the bytes instead).
box=${FACTORY_REVIEW_DIR:-/factory/review}

beat() {
    : > "$box/alive"
}

pause() {
    /bin/sleep 0.2 2>/dev/null || /bin/sleep 1
}

# One request, in $1. The inner subshell is the review: its env, its worktree (126 when the sync
# removed it), the executor entrypoint argv the supervisor wrote as `command`. The outer one records
# the review's status once the review itself ends.
serve() {
    (
        (
            if [ -f "$1/env" ]; then
                while IFS= read -r line; do
                    export "$line"
                done < "$1/env"
            fi
            /bin/rm -f "$1/env"
            cwd=$(/bin/cat "$1/cwd")
            cd "$cwd" 2>/dev/null || { echo "[review] the worktree $cwd is missing"; exit 126; }
            exec /bin/sh -c "$(/bin/cat "$1/command")"
        ) > "$1/output" 2>&1
        echo "$?" > "$1/code"
    ) &
    pid=$!
    until [ -e "$1/code" ]; do
        if [ -e "$1/cancel" ]; then
            kill -KILL -1 2>/dev/null
            break
        fi
        beat
        pause
    done
    wait "$pid" 2>/dev/null
    kill -KILL -1 2>/dev/null
    code=137
    [ -e "$1/code" ] && IFS= read -r code < "$1/code"
    echo "$code" > "$1/exit.tmp" && /bin/mv -f "$1/exit.tmp" "$1/exit"
}

/bin/mkdir -p "$box/requests" "$box/running" "$box/done"
# A request this loop held when its container restarted ran, and its answer is lost: done, no exit.
for held in "$box/running"/*; do
    [ -d "$held" ] && /bin/mv "$held" "$box/done/"
done
while :; do
    beat
    for request in "$box/requests"/*; do
        [ -d "$request" ] || continue
        id=${request##*/}
        /bin/mv "$request" "$box/running/$id" 2>/dev/null || continue
        serve "$box/running/$id"
        /bin/mv "$box/running/$id" "$box/done/$id"
        beat
    done
    pause
done
