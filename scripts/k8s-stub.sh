#!/bin/sh
# The kind lane releases a blocked agent only after observing the disruption it is testing.
set -eu
echo "${CLAUDE_CODE_CONFIG_CONTENT:-none}"
echo "$@"
# `factory-stub-mark` (issue #822): the first run marks the worktree's git-ignored .factory/ and goes
# on; a run that finds the mark — a replacement on the tree a lost runner left — says so and ends.
case "$*" in
*factory-stub-mark*)
    if [ -f "$WORKDIR/.factory/stub-mark" ]; then
        echo "mark kept from $(cat "$WORKDIR/.factory/stub-mark") head: $(git -C "$WORKDIR" log -1 --format=%s)"
        exit 0
    fi
    mkdir -p "$WORKDIR/.factory" && echo "${HOSTNAME:-stub}" >"$WORKDIR/.factory/stub-mark"
    ;;
esac
# `factory-stub-commit` (issue #829): one commit of a file on the task branch, so the publish after the run
# has something to push; made before any wait, so a driver killed at the wait finds it already there.
case "$*" in
*factory-stub-commit*)
    echo commit >"$WORKDIR/lane-commit-file"
    git -C "$WORKDIR" add lane-commit-file
    git -C "$WORKDIR" -c user.name=lane -c user.email=lane@localhost commit -q -m lane-commit
    ;;
esac
# `factory-stub-change` (issue #1020): one file written into the task tree. A task that changes nothing
# skips its close-time gates, so a lane that counts gate runs needs an agent that leaves a change.
case "$*" in
*factory-stub-change*)
    echo change >"$WORKDIR/lane-change"
    ;;
esac
# `factory-stub-transcript-<n>` (issue #779): the session file the
# real CLI writes under the runner's transcript store (projects/<working dir with every non-alphanumeric
# as '-'>/<session>.jsonl) topped up to <n> claude JSONL records, so a replacement run on the same volume
# adds none, as a resumed session would not repeat its history; then `stub-transcript-ready` beside it, so a lane that holds the run at a
# wait (`factory-stub-wait-...`) knows the records are on the volume. A write that fails fails the run.
case "$*" in
*factory-stub-transcript-*)
    count="${*##*factory-stub-transcript-}"
    count="${count%%[!0-9]*}"
    [ -n "$count" ] && [ -n "${FACTORY_TRANSCRIPT_DIR:-}" ] && [ -n "${BELLOWS_SESSION_ID:-}" ] || exit 1
    segment="$(printf '%s' "$WORKDIR" | sed 's/[^A-Za-z0-9]/-/g')"
    session_file="$FACTORY_TRANSCRIPT_DIR/projects/$segment/$BELLOWS_SESSION_ID.jsonl"
    mkdir -p "$FACTORY_TRANSCRIPT_DIR/projects/$segment"
    have=0
    [ ! -f "$session_file" ] || have="$(wc -l <"$session_file")"
    while [ "$have" -lt "$count" ]; do
        have=$((have + 1))
        printf '{"type":"user","uuid":"stub-record-%s","sessionId":"%s","message":{"role":"user","content":"stub record %s"}}\n' \
            "$have" "$BELLOWS_SESSION_ID" "$have" >>"$session_file"
    done
    : >"$FACTORY_TRANSCRIPT_DIR/stub-transcript-ready"
    echo "transcript $session_file records $have"
    ;;
esac
# `factory-stub-services` (issue #773): the names a task pod's hosts file puts on its loopback, then
# a TCP connect to each declared service of the services lane, retried while one still boots.
reach() { # reach <host> <port>
    node -e '
const [host, port] = process.argv.slice(1);
const until = Date.now() + 60000;
const once = () => {
    const socket = require("net").connect(Number(port), host);
    socket.on("connect", () => { console.log(`reached ${host}`); process.exit(0); });
    socket.on("error", (e) => {
        if (Date.now() > until) { console.error(`${host}:${port} ${e.message}`); process.exit(1); }
        setTimeout(once, 1000);
    });
};
once();' "$1" "$2"
}
# `factory-stub-stop` (issue #770): a wait below ends cleanly on the supervisor's Stop, as the real
# CLI's stop hook does.
stoppable=''
case "$*" in *factory-stub-stop*) stoppable=1 ;; esac
# `factory-stub-ask-<seconds>` (issue #770): after <seconds> of run budget, one question to the
# supervisor through the agent's mailbox, as claude-bridge.cjs asks it, then the answer polled until
# settled; the run goes on to any wait.
case "$*" in
*factory-stub-ask-*)
    after="${*##*factory-stub-ask-}"
    after="${after%%[!0-9]*}"
    [ -n "$after" ] || exit 1
    sleep "$after"
    qid="stub-${HOSTNAME:-stub}"
    mkdir -p "$FACTORY_CTL_OUT/questions"
    printf '%s' "{\"questionId\":\"$qid\",\"questions\":[{\"question\":\"Which colour should the report use?\",\"header\":\"Colour\",\"options\":[{\"label\":\"Red\",\"description\":\"red\"},{\"label\":\"Blue\",\"description\":\"blue\"}],\"multiSelect\":false}]}" \
        >"$FACTORY_CTL_OUT/questions/$qid.json.tmp"
    mv "$FACTORY_CTL_OUT/questions/$qid.json.tmp" "$FACTORY_CTL_OUT/questions/$qid.json"
    echo "asked in ${HOSTNAME:-stub}"
    deadline=$(($(date +%s) + ${FACTORY_STUB_TIMEOUT_SECONDS:-120}))
    state=''
    while :; do
        answer="$(cat "$FACTORY_CTL_IN/answers/$qid.json" 2>/dev/null || true)"
        state="$(printf '%s' "$answer" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).state??""))}catch{}})')"
        case "$state" in '' | pending) ;; *) break ;; esac
        if [ "$(date +%s)" -ge "$deadline" ]; then
            echo 'stub question timed out' >&2
            exit 1
        fi
        sleep 0.2
    done
    echo "ANSWER: $answer"
    [ "$state" = answered ] || exit 1
    ;;
esac
for arg in "$@"; do
    case "$arg" in
    *factory-stub-services*)
        echo "loopback names: $(awk '$1 == "127.0.0.1" { for (i = 2; i <= NF; i++) printf "%s ", $i }' /etc/hosts)"
        reach postgres 5432 || exit 1
        reach s3 9000 || exit 1
        break
        ;;
    *factory-stub-github*)
        github_exit=0
        node /usr/local/bin/github-credential.cjs token >/dev/null 2>/tmp/github.err || github_exit=$?
        echo "github exit $github_exit"
        cat /tmp/github.err
        grep -q ' /run/factory-credentials tmpfs ' /proc/mounts && echo 'github cache tmpfs'
        env | grep -q -e '^GITHUB_TOKEN=' -e '^GH_TOKEN=' || echo 'github no env token'
        break
        ;;
    *factory-stub-connect*)
        # `factory-stub-connect`: the Jira helper for a task with no Jira connection asks the board on the
        # supervisor's agent socket and exits 3; the driver ends this run as a requirement wait. The stub keeps no
        # session, so the run a bind releases is a plain re-run (the resumed prompt is the docker lane's).
        connect_exit=0
        FACTORY_CONTROL_SOCKET="$FACTORY_CTL_OUT/control.sock" node /usr/local/bin/jira.cjs issue ABC-1 || connect_exit=$?
        echo "connect exit $connect_exit"
        # The real CLI keeps working until the driver's cooperative Stop (the grace before a kill is minutes): so does
        # the stub, then leaves; the hand-back ends this run, never the exit.
        if [ "$connect_exit" -eq 3 ]; then
            connect_deadline=$(($(date +%s) + ${FACTORY_STUB_TIMEOUT_SECONDS:-120}))
            while [ ! -f "${FACTORY_CTL_IN:-/nonexistent}/stop" ] && [ "$(date +%s)" -lt "$connect_deadline" ]; do sleep 0.2; done
        fi
        break
        ;;
    *factory-stub-review*)
        # `factory-stub-review` (issue #774): ask the declared `audit` reviewer for key `rv-k` on the
        # control endpoint and wait for its verdict. A re-claimed run asks the same key again.
        node -e '
const http = require("node:http");
const socketPath = process.env.FACTORY_CTL_OUT + "/control.sock";
const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path, headers: { "content-type": "application/json" } }, (res) => {
        let text = "";
        res.on("data", (c) => { text += c; });
        res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
});
(async () => {
    let last = await call("POST", "/review", JSON.stringify({ key: "rv-k", profile: "audit" }));
    console.log("review-request=" + last.status);
    for (let i = 0; i < 200 && !(JSON.parse(last.text).done); i++) {
        await new Promise((r) => setTimeout(r, 1000));
        last = await call("GET", "/review/rv-k");
    }
    console.log("review-final=" + last.text);
})().catch((e) => { console.error(e.message); process.exit(1); });' || exit 1
        break
        ;;
    *factory-stub-kill-tools*)
        "$SHELL" -c 'kill -TERM 1 2>/dev/null; kill -KILL -1 2>/dev/null; echo "the tool ran as $(id -u)"'
        echo 'agent survived'
        break
        ;;
    *factory-stub-sleep-*)
        # `factory-stub-sleep-<seconds>` (issue #831): holds a slot for a fixed time and ends, writing no
        # barrier file, so the benchmark phase needs no `kubectl exec` while it measures.
        seconds="${arg##*factory-stub-sleep-}"
        seconds="${seconds%%[!0-9]*}"
        [ -n "$seconds" ] || exit 1
        sleep "$seconds"
        echo "slept in ${HOSTNAME:-stub}"
        break
        ;;
    *factory-stub-pass-*)
        # The pass of an agent that must not wait (issue #829): its ready file, so a lane counts the runs.
        release="${arg##*factory-stub-pass-}"
        release="${release%%[!a-zA-Z0-9_./-]*}"
        [ -n "$release" ] || exit 1
        : > "$release.ready-${HOSTNAME:-stub}"
        echo "passed in ${HOSTNAME:-stub}"
        break
        ;;
    *factory-stub-wait-*)
        release="${arg##*factory-stub-wait-}"
        release="${release%%[!a-zA-Z0-9_./-]*}"
        [ -n "$release" ] || exit 1
        : > "$release.ready-${HOSTNAME:-stub}"
        echo "waiting in ${HOSTNAME:-stub}"
        wait_seconds="${FACTORY_STUB_TIMEOUT_SECONDS:-120}"
        # `factory-stub-patient` (issue #829): a takeover case holds the agent past a kubelet Secret refresh.
        case "$*" in *factory-stub-patient*) wait_seconds=900 ;; esac
        deadline=$(($(date +%s) + wait_seconds))
        while [ ! -f "$release" ]; do
            if [ -n "$stoppable" ] && [ -f "${FACTORY_CTL_IN:-/nonexistent}/stop" ]; then
                echo "stopped in ${HOSTNAME:-stub}"
                exit 0
            fi
            if [ "$(date +%s)" -ge "$deadline" ]; then
                echo 'stub release timed out' >&2
                exit 1
            fi
            sleep 0.2
        done
        echo "released in ${HOSTNAME:-stub}"
        break
        ;;
    esac
done
# `factory-stub-fail` (issue #779): the run ends non-zero, after any records and wait above.
# `factory-stub-fail-once`: only the first run on the task volume does; a retry finds the mark and passes.
case "$*" in
*factory-stub-fail-once*)
    [ -n "${FACTORY_TRANSCRIPT_DIR:-}" ] || exit 1
    if [ ! -f "$FACTORY_TRANSCRIPT_DIR/stub-fail-once" ]; then
        mkdir -p "$FACTORY_TRANSCRIPT_DIR"
        : >"$FACTORY_TRANSCRIPT_DIR/stub-fail-once"
        exit 1
    fi
    ;;
*factory-stub-fail*) exit 1 ;;
esac
